import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, normalize, resolve } from "node:path";
import { ENRICHMENT_VERSION, type SessionDigest, type TaskDigest, type TaskStats, type ToolCallDigest } from "./types.ts";

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_TASKS_PER_SESSION = 10_000;
const MAX_PROMPT_CHARS = 360;
const MAX_TERMS = 12;
const MAX_TOOL_CALLS = 80;
const MAX_TOOL_PARAM_CHARS = 256;
const READ_ONLY_TOOLS = new Set(["read", "read_symbol", "grep", "ffgrep", "find", "fffind", "ls", "web_fetch_page", "web_search"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

const STOP_WORDS = new Set([
	"about", "after", "again", "also", "and", "are", "because", "before", "being", "build", "can", "code", "could", "does", "file", "files",
	"for", "from", "have", "help", "how", "into", "its", "make", "more", "need", "new", "not", "please", "project", "should", "some", "than",
	"redacted", "redacted-token", "that", "the", "their", "then", "there", "these", "this", "through", "use", "using", "want", "what", "when", "where", "which", "with", "would", "you",
]);

const INTENTS: Array<[string, RegExp]> = [
	["debug", /\b(debug|diagnose|investigate|root cause|why)\b/i],
	["fix", /\b(fix|repair|resolve|broken|bug|error|failure)\b/i],
	["review", /\b(review|audit|assess|check)\b/i],
	["test", /\b(test|spec|coverage|verify|validate)\b/i],
	["refactor", /\b(refactor|cleanup|simplify|restructure)\b/i],
	["document", /\b(document|docs|readme|guide)\b/i],
	["configure", /\b(configure|config|setup|install|integrate)\b/i],
	["migrate", /\b(migrate|upgrade|convert|move)\b/i],
	["explain", /\b(explain|describe|teach|understand)\b/i],
	["create", /\b(create|add|implement|introduce|write)\b/i],
];

type UnknownRecord = Record<string, unknown>;

interface BatchRef {
	taskId: string;
	tools: string[];
	readOnly: boolean;
	singleton: boolean;
	mutationPath?: string;
}

interface CallHistoryNode {
	taskId: string;
	signature: string;
	previous?: CallHistoryNode;
}

interface MutableTask {
	digest: TaskDigest;
}

interface PendingCall {
	task: MutableTask;
	name: string;
	toolCall?: ToolCallDigest;
}

export function emptyTaskStats(): TaskStats {
	return {
		assistantRequests: 0, toolBatches: 0, toolCalls: 0, singletonBatches: 0,
		consecutiveSingletonReadOnly: 0, sequentialMutationRounds: 0, samePathSiblingMutations: 0,
		repeatedExactCalls: 0, toolErrors: 0, truncatedResults: 0, assistantErrors: 0,
		toolResultBytes: 0, delegatedRuns: 0, delegatedAgents: 0, delegateTimeouts: 0,
		delegateFailures: 0, parentCost: 0, inputTokens: 0, outputTokens: 0,
		cacheReadTokens: 0, maxContextTokens: 0,
	};
}

function record(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((item) => {
		const part = record(item);
		return part.type === "text" && typeof part.text === "string" ? part.text : "";
	}).filter(Boolean).join("\n");
}

function redact(value: string): string {
	return value
		.replace(/\b(sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9]{12,}|(?:eyJ[a-zA-Z0-9_-]+\.){2}[a-zA-Z0-9_-]+)\b/gi, "<redacted-token>")
		.replace(/(["'])(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\1(\s*:\s*)(["'])[^"'\r\n]{1,512}\4/gi, "$1$2$1$3<redacted>")
		.replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2<redacted>");
}

function boundedPrompt(value: string): string {
	const normalized = redact(value).replace(/\s+/g, " ").trim();
	return normalized.length > MAX_PROMPT_CHARS ? `${normalized.slice(0, MAX_PROMPT_CHARS - 1)}…` : normalized;
}

function termsFor(value: string): string[] {
	const withoutArtifacts = value
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/(?:\.{0,2}\/|~\/|\/)[^\s]+/g, " ")
		.replace(/`[^`]+`/g, " ")
		.toLowerCase();
	const counts = new Map<string, number>();
	for (const match of withoutArtifacts.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,29}/gu)) {
		const term = match[0].replace(/^[-_]+|[-_]+$/g, "");
		if (!term || STOP_WORDS.has(term) || /^\d+$/.test(term)) continue;
		counts.set(term, (counts.get(term) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TERMS).map(([term]) => term);
}

function inferIntent(value: string): string {
	return INTENTS.find(([, pattern]) => pattern.test(value))?.[0] ?? "other";
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as UnknownRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
}

function normalizedPath(name: string, args: UnknownRecord, cwd: string): string | undefined {
	const raw = typeof args.path === "string" ? args.path.replace(/^@/, "").trim() : "";
	if (!raw) return undefined;
	try { return resolve(cwd, raw); }
	catch { return normalize(raw); }
}

function callSignature(name: string, args: UnknownRecord, cwd: string): string {
	const normalized = { ...args };
	const path = normalizedPath(name, args, cwd);
	if (path) normalized.path = path;
	if (name === "read") normalized.offset ??= 1;
	return `${name}:${JSON.stringify(stable(normalized))}`;
}

function encodedParams(args: UnknownRecord): string | undefined {
	const encoded = JSON.stringify(stable(args));
	return encoded.length < MAX_TOOL_PARAM_CHARS ? redact(encoded) : undefined;
}

function isTruncated(message: UnknownRecord, text: string): boolean {
	const details = record(message.details);
	const truncation = record(details.truncation);
	if (typeof truncation.truncated === "boolean") return truncation.truncated;
	if (typeof details.truncated === "boolean") return details.truncated;
	return /^(?:\[)?Output truncated(?:\b|:)/im.test(text) || /^\[Showing lines \d+-\d+ of \d+.*(?:limit|truncat)/im.test(text);
}

function timestampFor(entry: UnknownRecord, message: UnknownRecord): string {
	if (typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))) return entry.timestamp;
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return new Date(message.timestamp).toISOString();
	return new Date(0).toISOString();
}

function makeTask(file: string, entry: UnknownRecord, message: UnknownRecord): MutableTask {
	const prompt = boundedPrompt(textContent(message.content));
	return {
		digest: {
			id: typeof entry.id === "string" ? entry.id : createHash("sha256").update(`${file}:${entry.timestamp ?? ""}:${prompt}`).digest("hex").slice(0, 16),
			timestamp: timestampFor(entry, message),
			prompt,
			promptHash: createHash("sha256").update(prompt).digest("hex"),
			intent: inferIntent(prompt),
			terms: termsFor(prompt),
			toolCalls: [],
			toolBatches: [],
			toolNgrams: [],
			stats: emptyTaskStats(),
		},
	};
}

function hasCallOnBranch(node: CallHistoryNode | undefined, taskId: string, signature: string): boolean {
	let current = node;
	for (let depth = 0; current && depth < 500; depth += 1, current = current.previous) {
		if (current.taskId === taskId && current.signature === signature) return true;
	}
	return false;
}

function recordToolNgrams(task: MutableTask, inherited: BatchRef | undefined, names: string[]): void {
	if (task.digest.toolNgrams.length >= 160) return;
	const windows: string[][] = [];
	for (const length of [2, 3]) {
		for (let index = 0; index + length <= names.length; index += 1) windows.push(names.slice(index, index + length));
	}
	if (inherited?.taskId === task.digest.id) {
		if (inherited.tools.length && names.length) windows.push([inherited.tools.at(-1)!, names[0]]);
		if (inherited.tools.length >= 2 && names.length) windows.push([...inherited.tools.slice(-2), names[0]]);
		if (inherited.tools.length && names.length >= 2) windows.push([inherited.tools.at(-1)!, ...names.slice(0, 2)]);
	}
	for (const window of windows) {
		if (task.digest.toolNgrams.length >= 160) break;
		task.digest.toolNgrams.push(window);
	}
}

function delegationAgents(args: UnknownRecord): number {
	return Array.isArray(args.agents) ? args.agents.length : 1;
}

function observeDelegateResult(task: MutableTask, text: string): void {
	const timeoutMatches = text.match(/\b(?:timed_out|timed out)\b/gi)?.length ?? 0;
	const failureMatches = text.match(/\b(?:status["']?\s*[:=]\s*["']?failed|\d+\/\d+ failed)\b/gi)?.length ?? 0;
	task.digest.stats.delegateTimeouts += Math.min(timeoutMatches, task.digest.stats.delegatedAgents);
	task.digest.stats.delegateFailures += Math.min(failureMatches, task.digest.stats.delegatedAgents);
}

interface BoundedLine {
	line?: string;
	oversized: boolean;
}

/** Bound memory while scanning, including before a newline arrives. */
async function* boundedLines(path: string): AsyncGenerator<BoundedLine> {
	let buffer = "";
	let discarding = false;
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		let remaining = String(chunk);
		while (remaining.length > 0) {
			const newline = remaining.indexOf("\n");
			const piece = newline < 0 ? remaining : remaining.slice(0, newline).replace(/\r$/, "");
			remaining = newline < 0 ? "" : remaining.slice(newline + 1);
			if (discarding) {
				if (newline >= 0) {
					discarding = false;
					yield { oversized: true };
				}
				continue;
			}
			if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(piece, "utf8") > MAX_JSON_LINE_BYTES) {
				buffer = "";
				if (newline >= 0) yield { oversized: true };
				else discarding = true;
				continue;
			}
			buffer += piece;
			if (newline >= 0) {
				yield { line: buffer.replace(/\r$/, ""), oversized: false };
				buffer = "";
			}
		}
	}
	if (discarding) yield { oversized: true };
	else if (buffer) yield { line: buffer, oversized: false };
}

/** Stream one Pi JSONL session into compact task digests. Session content is treated as untrusted data. */
export async function parseSessionFile(path: string, source: { size: number; mtimeMs: number }): Promise<SessionDigest> {
	const file = basename(path);
	const tasks = new Map<string, MutableTask>();
	const taskByEntry = new Map<string, string | undefined>();
	const lastBatchByEntry = new Map<string, BatchRef | undefined>();
	const callHistoryByEntry = new Map<string, CallHistoryNode | undefined>();
	const pendingCalls = new Map<string, PendingCall>();
	let sessionId = "";
	let cwd = "";
	let createdAt = new Date(0).toISOString();
	let parentSession: string | undefined;
	let malformedLines = 0;
	let oversizedLines = 0;
	let entryCount = 0;
	let entryLimitReached = false;
	let taskLimitReached = false;
	let sawHeader = false;

	for await (const item of boundedLines(path)) {
		if (item.oversized) {
			if (!sawHeader) throw new Error(`${file} has no valid session header`);
			oversizedLines += 1;
			continue;
		}
		const line = item.line ?? "";
		if (!line.trim()) continue;
		if (entryCount >= MAX_ENTRIES) {
			entryLimitReached = true;
			break;
		}
		entryCount += 1;
		let entry: UnknownRecord;
		try {
			const parsed: unknown = JSON.parse(line);
			entry = record(parsed);
			if (typeof entry.type !== "string") throw new Error("missing type");
		} catch {
			if (!sawHeader) throw new Error(`${file} has no valid session header`);
			malformedLines += 1;
			continue;
		}

		if (!sawHeader) {
			if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string" || !entry.cwd.trim()) {
				throw new Error(`${file} has no valid session header`);
			}
			sawHeader = true;
			sessionId = entry.id;
			cwd = entry.cwd;
			createdAt = typeof entry.timestamp === "string" ? entry.timestamp : createdAt;
			parentSession = typeof entry.parentSession === "string" ? entry.parentSession : undefined;
			continue;
		}
		if (entry.type === "session") {
			malformedLines += 1;
			continue;
		}
		if (typeof entry.id !== "string") {
			malformedLines += 1;
			continue;
		}

		const parentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
		let taskId = parentId ? taskByEntry.get(parentId) : undefined;
		const inheritedBatch = parentId ? lastBatchByEntry.get(parentId) : undefined;
		const inheritedCallHistory = parentId ? callHistoryByEntry.get(parentId) : undefined;
		const message = entry.type === "message" ? record(entry.message) : {};

		if (message.role === "user") {
			if (tasks.size >= MAX_TASKS_PER_SESSION) {
				taskLimitReached = true;
				taskId = undefined;
			} else {
				const task = makeTask(file, entry, message);
				tasks.set(task.digest.id, task);
				taskId = task.digest.id;
			}
		}
		taskByEntry.set(entry.id, taskId);
		const task = taskId ? tasks.get(taskId) : undefined;

		if (task && (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message")) {
			lastBatchByEntry.set(entry.id, undefined);
			callHistoryByEntry.set(entry.id, undefined);
			continue;
		}
		if (!task || message.role === "user") {
			lastBatchByEntry.set(entry.id, undefined);
			callHistoryByEntry.set(entry.id, undefined);
			continue;
		}

		if (message.role === "assistant") {
			const stats = task.digest.stats;
			stats.assistantRequests += 1;
			if (message.stopReason === "error" || message.stopReason === "aborted") stats.assistantErrors += 1;
			const usage = record(message.usage);
			stats.inputTokens += finite(usage.input);
			stats.outputTokens += finite(usage.output);
			stats.cacheReadTokens += finite(usage.cacheRead);
			stats.parentCost += finite(record(usage.cost).total);
			stats.maxContextTokens = Math.max(stats.maxContextTokens, finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite));

			const calls = Array.isArray(message.content)
				? message.content.map(record).filter((part) => part.type === "toolCall" && typeof part.name === "string")
				: [];
			if (!calls.length) {
				lastBatchByEntry.set(entry.id, undefined);
				callHistoryByEntry.set(entry.id, undefined);
				continue;
			}

			stats.toolBatches += 1;
			stats.toolCalls += calls.length;
			if (calls.length === 1) stats.singletonBatches += 1;
			const names = calls.map((call) => String(call.name));
			const mutationPaths = calls
				.filter((call) => MUTATION_TOOLS.has(String(call.name)))
				.map((call) => normalizedPath(String(call.name), record(call.arguments), cwd))
				.filter((value): value is string => Boolean(value));
			stats.samePathSiblingMutations += mutationPaths.length - new Set(mutationPaths).size;
			const currentBatch: BatchRef = {
				taskId: task.digest.id,
				tools: names,
				readOnly: names.every((name) => READ_ONLY_TOOLS.has(name)),
				singleton: names.length === 1,
				mutationPath: names.length === 1 && MUTATION_TOOLS.has(names[0]) ? mutationPaths[0] : undefined,
			};
			if (inheritedBatch?.taskId === task.digest.id) {
				if (inheritedBatch.singleton && inheritedBatch.readOnly && currentBatch.singleton && currentBatch.readOnly) stats.consecutiveSingletonReadOnly += 1;
				if (inheritedBatch.singleton && inheritedBatch.mutationPath && currentBatch.singleton && currentBatch.mutationPath) stats.sequentialMutationRounds += 1;
			}

			recordToolNgrams(task, inheritedBatch, names);
			let currentCallHistory = inheritedCallHistory;
			const batchIndexes: number[] = [];
			for (const call of calls) {
				const name = String(call.name);
				const args = record(call.arguments);
				let toolCall: ToolCallDigest | undefined;
				if (task.digest.toolCalls.length < MAX_TOOL_CALLS) {
					const params = encodedParams(args);
					toolCall = { name, ...(params !== undefined ? { params } : {}) };
					batchIndexes.push(task.digest.toolCalls.length);
					task.digest.toolCalls.push(toolCall);
				}
				const signature = callSignature(name, args, cwd);
				if (hasCallOnBranch(currentCallHistory, task.digest.id, signature)) stats.repeatedExactCalls += 1;
				currentCallHistory = { taskId: task.digest.id, signature, previous: currentCallHistory };
				if (name === "delegate_to_subagents") {
					stats.delegatedRuns += 1;
					stats.delegatedAgents += delegationAgents(args);
				}
				if (typeof call.id === "string") pendingCalls.set(call.id, { task, name, toolCall });
			}
			if (batchIndexes.length) task.digest.toolBatches.push(batchIndexes);
			lastBatchByEntry.set(entry.id, currentBatch);
			callHistoryByEntry.set(entry.id, currentCallHistory);
			continue;
		}

		if (message.role === "toolResult") {
			const text = textContent(message.content);
			task.digest.stats.toolResultBytes += Buffer.byteLength(text, "utf8");
			if (message.isError === true) task.digest.stats.toolErrors += 1;
			if (isTruncated(message, text)) task.digest.stats.truncatedResults += 1;
			if (typeof message.toolCallId === "string") {
				const pending = pendingCalls.get(message.toolCallId);
				if (pending?.toolCall) pending.toolCall.status = message.isError === true ? "failed" : "success";
				if (pending?.name === "delegate_to_subagents") observeDelegateResult(pending.task, text);
				pendingCalls.delete(message.toolCallId);
			}
		}
		lastBatchByEntry.set(entry.id, inheritedBatch);
		callHistoryByEntry.set(entry.id, inheritedCallHistory);
	}

	if (!sawHeader) throw new Error(`${file} has no valid session header`);
	return {
		enrichmentVersion: ENRICHMENT_VERSION,
		file,
		size: source.size,
		mtimeMs: source.mtimeMs,
		sessionId,
		cwd,
		createdAt,
		...(parentSession ? { parentSession } : {}),
		malformedLines,
		oversizedLines,
		entryLimitReached,
		taskLimitReached,
		tasks: [...tasks.values()].map(({ digest }) => digest).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
	};
}

import { normalize, resolve } from "node:path";

export interface FindingEvidence {
	request: number;
	entryId?: string;
	toolCallId?: string;
	tool: string;
	path?: string;
}

export interface BatchingFinding {
	kind: "cross-file-edits" | "repeated-read" | "same-path-mutations";
	/** Confidence in the observation, not proof that work was avoidable. */
	confidence: "possible" | "observed";
	evidence: FindingEvidence[];
	explanation: string;
}

export interface WiseBatchReport {
	assistantRequests: number;
	toolBatches: number;
	toolCalls: number;
	singletonBatches: number;
	maxBatchSize: number;
	callsPerBatch: number;
	singletonRate: number;
	toolCounts: Record<string, number>;
	consecutiveSingletonEdits: number;
	consecutiveDifferentFileEdits: number;
	consecutiveSameFileEdits: number;
	consecutiveSingletonBash: number;
	consecutiveReadOnlyBatches: number;
	consecutiveSingletonReadOnlyBatches: number;
	repeatedExactCalls: number;
	/** Successful identical read ranges without a known intervening mutation. */
	repeatedReads: number;
	samePathSiblingMutations: number;
	editCalls: number;
	editBlocks: number;
	toolErrors: number;
	truncatedResults: number;
	toolResultCharacters: number;
	toolResultBytes: number;
	/** Parent assistant request cost only; nested and summary costs are separate. */
	totalCost: number;
	pricedRequests: number;
	requestCostBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
	nestedToolCost: number;
	summaryCost: number;
	/** Legacy field name: hypothetical equal-cost split scenario, not measured savings. */
	estimatedSingletonToolCallSavings: number;
	maxContextTokens: number;
	/** Legacy field name: observed successful sequential-edit request cost, not a savings ceiling. */
	avoidableEditRequestCostUpperBound: number;
	findings: BatchingFinding[];
	omittedFindings: number;
}

type UnknownRecord = Record<string, unknown>;
interface ParsedCall {
	name: string;
	arguments: UnknownRecord;
	path?: string;
	outcome: "unknown" | "success" | "error";
	evidence: FindingEvidence;
}
interface Batch {
	calls: ParsedCall[];
	cost: number;
}
const MAX_FINDINGS = 20;
const READ_ONLY_TOOLS = new Set(["read", "grep", "ffgrep", "find", "fffind", "ls", "web_fetch_page", "web_search"]);

function record(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}
function content(message: UnknownRecord): UnknownRecord[] {
	return Array.isArray(message.content) ? message.content.map(record) : [];
}
function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function hasCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function messageFromEntry(entry: unknown): UnknownRecord | undefined {
	const value = record(entry);
	return value.type === "message" ? record(value.message) : undefined;
}
function stableArguments(call: ParsedCall): string {
	const sort = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sort);
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
	};
	const args = { ...call.arguments };
	if (call.path) args.path = call.path;
	if (call.name === "read") args.offset ??= 1;
	return `${call.name}:${JSON.stringify(sort(args))}`;
}
function isTruncated(message: UnknownRecord, text: string): boolean {
	const details = record(message.details);
	const flag = record(details.truncation).truncated ?? details.truncated;
	if (typeof flag === "boolean") return flag;
	// Fallback for tools without metadata. Ordinary prose mentioning truncation is not evidence.
	return /^(?:\[)?Output truncated(?:\b|:)/im.test(text) || /^\[Showing lines \d+-\d+ of \d+.*(?:limit|truncat)/im.test(text);
}

export function emptyReport(): WiseBatchReport {
	return {
		assistantRequests: 0, toolBatches: 0, toolCalls: 0, singletonBatches: 0, maxBatchSize: 0,
		callsPerBatch: 0, singletonRate: 0, toolCounts: Object.create(null), consecutiveSingletonEdits: 0,
		consecutiveDifferentFileEdits: 0, consecutiveSameFileEdits: 0, consecutiveSingletonBash: 0,
		consecutiveReadOnlyBatches: 0, consecutiveSingletonReadOnlyBatches: 0,
		repeatedExactCalls: 0, repeatedReads: 0, samePathSiblingMutations: 0,
		editCalls: 0, editBlocks: 0, toolErrors: 0, truncatedResults: 0,
		toolResultCharacters: 0, toolResultBytes: 0, totalCost: 0, pricedRequests: 0,
		requestCostBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		nestedToolCost: 0, summaryCost: 0, estimatedSingletonToolCallSavings: 0,
		maxContextTokens: 0, avoidableEditRequestCostUpperBound: 0, findings: [], omittedFindings: 0,
	};
}

/** Analyze the supplied historical branch without inspecting the current filesystem. */
export function analyzeEntries(entries: readonly unknown[], options: { cwd?: string } = {}): WiseBatchReport {
	const report = emptyReport();
	const timeline: Array<Batch | null> = [];
	const pending = new Map<string, ParsedCall>();
	const addFinding = (finding: BatchingFinding) => {
		if (report.findings.length < MAX_FINDINGS) report.findings.push(finding);
		else report.omittedFindings += 1;
	};

	for (const entry of entries) {
		const value = record(entry);
		if (value.type === "compaction" || value.type === "branch_summary") {
			report.summaryCost += finite(record(record(value.usage).cost).total);
			timeline.push(null);
		}
		if (value.type === "custom_message") timeline.push(null);
		const message = messageFromEntry(entry);
		if (!message) continue;
		if (message.role === "user") {
			timeline.push(null);
			pending.clear();
			continue;
		}
		if (message.role === "toolResult") {
			const text = content(message).filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text as string).join("");
			report.toolResultCharacters += text.length;
			report.toolResultBytes += Buffer.byteLength(text, "utf8");
			report.nestedToolCost += finite(record(record(message.usage).cost).total);
			if (message.isError === true) report.toolErrors += 1;
			if (isTruncated(message, text)) report.truncatedResults += 1;
			if (typeof message.toolCallId === "string") {
				const call = pending.get(message.toolCallId);
				if (call) call.outcome = message.isError === true ? "error" : "success";
				pending.delete(message.toolCallId);
			}
			continue;
		}
		if (message.role !== "assistant") {
			timeline.push(null);
			continue;
		}
		report.assistantRequests += 1;
		const usage = record(message.usage);
		const cost = record(usage.cost);
		if (hasCost(cost.total)) {
			report.totalCost += cost.total;
			report.pricedRequests += 1;
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) report.requestCostBreakdown[key] += finite(cost[key]);
		report.maxContextTokens = Math.max(report.maxContextTokens, finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite));
		const calls = content(message).filter(item => item.type === "toolCall").map((item): ParsedCall => {
			const args = record(item.arguments);
			const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.replace(/^@/, "") : undefined;
			const path = rawPath ? (options.cwd ? resolve(options.cwd, rawPath) : normalize(rawPath)) : undefined;
			const name = typeof item.name === "string" ? item.name : "unknown";
			const id = typeof item.id === "string" ? item.id : undefined;
			const call: ParsedCall = {
				name, arguments: args, path, outcome: "unknown",
				evidence: { request: report.assistantRequests, entryId: typeof value.id === "string" ? value.id : undefined, toolCallId: id, tool: name, path },
			};
			if (id) pending.set(id, call);
			return call;
		});
		if (!calls.length) {
			timeline.push(null);
			continue;
		}
		report.estimatedSingletonToolCallSavings += finite(cost.total) * (calls.length - 1);
		timeline.push({ calls, cost: finite(cost.total) });
	}

	let previous: Batch | undefined;
	const seen = new Map<string, ParsedCall>();
	for (const batch of timeline) {
		if (!batch) {
			previous = undefined;
			seen.clear();
			continue;
		}
		const { calls } = batch;
		report.toolBatches += 1;
		report.toolCalls += calls.length;
		report.maxBatchSize = Math.max(report.maxBatchSize, calls.length);
		if (calls.length === 1) report.singletonBatches += 1;
		const mutations = new Map<string, ParsedCall[]>();
		// Unknown tools (including shell commands) may mutate arbitrary state. Do not guess shell semantics.
		const opaque = calls.some(call => !READ_ONLY_TOOLS.has(call.name) && call.name !== "edit" && call.name !== "write");
		if (opaque) seen.clear();
		for (const call of calls) {
			report.toolCounts[call.name] = (Object.hasOwn(report.toolCounts, call.name) ? report.toolCounts[call.name] : 0) + 1;
			const signature = stableArguments(call);
			const earlier = seen.get(signature);
			const siblingMutation = call.path && calls.some(sibling =>
				(sibling.name === "edit" || sibling.name === "write") && sibling.path === call.path,
			);
			if (!siblingMutation && earlier?.outcome === "success" && call.outcome === "success") {
				report.repeatedExactCalls += 1;
				if (call.name === "read" && call.path) {
					report.repeatedReads += 1;
					addFinding({ kind: "repeated-read", confidence: "possible", evidence: [earlier.evidence, call.evidence], explanation: "Identical read range succeeded twice without a known intervening mutation. External changes or verification may still justify it." });
				}
			}
			if (call.outcome === "success") seen.set(signature, call);
			else seen.delete(signature);
			if ((call.name === "edit" || call.name === "write") && call.path) {
				const group = mutations.get(call.path) ?? [];
				group.push(call);
				mutations.set(call.path, group);
			}
			if (call.name === "edit") {
				report.editCalls += 1;
				if (Array.isArray(call.arguments.edits)) report.editBlocks += call.arguments.edits.length;
				if (typeof call.arguments.oldText === "string" && typeof call.arguments.newText === "string") report.editBlocks += 1;
			}
		}
		for (const [path, group] of mutations) {
			if (group.length > 1) {
				report.samePathSiblingMutations += group.length - 1;
				addFinding({ kind: "same-path-mutations", confidence: "observed", evidence: group.slice(0, 4).map(call => call.evidence), explanation: "Sibling mutations target the same normalized path. Pi may serialize them; review ordering and consider one edit call. This does not prove a write race." });
			}
			// Invalidate even failed mutations: a custom implementation may have partially written.
			for (const [signature, call] of seen) if (call.path === path) seen.delete(signature);
		}
		if (opaque || calls.some(call => (call.name === "edit" || call.name === "write") && !call.path)) seen.clear();
		if (previous) {
			const before = previous.calls.length === 1 ? previous.calls[0] : undefined;
			const after = calls.length === 1 ? calls[0] : undefined;
			if (previous.calls.every(call => READ_ONLY_TOOLS.has(call.name)) && calls.every(call => READ_ONLY_TOOLS.has(call.name))) {
				report.consecutiveReadOnlyBatches += 1;
				if (before && after) report.consecutiveSingletonReadOnlyBatches += 1;
			}
			if (before?.name === "edit" && after?.name === "edit" && before.outcome === "success" && after.outcome === "success") {
				report.consecutiveSingletonEdits += 1;
				if (before.path && after.path) {
					if (before.path === after.path) report.consecutiveSameFileEdits += 1;
					else {
						report.consecutiveDifferentFileEdits += 1;
						addFinding({ kind: "cross-file-edits", confidence: "possible", evidence: [before.evidence, after.evidence], explanation: "Consecutive edits to different paths both succeeded. Consider sibling calls only if the second edit was already known; dependency is unknown." });
					}
				}
				report.avoidableEditRequestCostUpperBound += batch.cost;
			}
			if (before?.name === "bash" && after?.name === "bash") report.consecutiveSingletonBash += 1;
		}
		previous = batch;
	}
	report.callsPerBatch = report.toolBatches ? report.toolCalls / report.toolBatches : 0;
	report.singletonRate = report.toolBatches ? report.singletonBatches / report.toolBatches : 0;
	return report;
}

export function entriesForLatestUserTask(entries: readonly unknown[]): readonly unknown[] {
	let latestUserIndex = -1;
	for (let index = 0; index < entries.length; index += 1) {
		if (messageFromEntry(entries[index])?.role === "user") latestUserIndex = index;
	}
	return latestUserIndex < 0 ? entries : entries.slice(latestUserIndex);
}

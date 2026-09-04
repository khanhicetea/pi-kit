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
	repeatedReads: number;
	samePathSiblingMutations: number;
	editCalls: number;
	editBlocks: number;
	toolErrors: number;
	truncatedResults: number;
	toolResultCharacters: number;
	totalCost: number;
	estimatedSingletonToolCallSavings: number;
	maxContextTokens: number;
	avoidableEditRequestCostUpperBound: number;
}

type UnknownRecord = Record<string, unknown>;

interface ParsedCall {
	name: string;
	arguments: UnknownRecord;
}

interface Batch {
	calls: ParsedCall[];
}

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"ffgrep",
	"find",
	"fffind",
	"ls",
	"web_fetch_page",
	"web_search",
]);

function record(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function content(message: UnknownRecord): UnknownRecord[] {
	const value = message.content;
	return Array.isArray(value) ? value.map(record) : [];
}

function parseCalls(message: UnknownRecord): ParsedCall[] {
	return content(message)
		.filter((item) => item.type === "toolCall")
		.map((item) => ({
			name: typeof item.name === "string" ? item.name : "unknown",
			arguments: record(item.arguments),
		}));
}

function pathOf(call: ParsedCall): string | undefined {
	return typeof call.arguments.path === "string" ? call.arguments.path : undefined;
}

function stableArguments(call: ParsedCall): string {
	const sort = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sort);
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value as UnknownRecord)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sort(child)]),
		);
	};
	return `${call.name}:${JSON.stringify(sort(call.arguments))}`;
}

function isReadOnly(batch: Batch): boolean {
	return batch.calls.every((call) => READ_ONLY_TOOLS.has(call.name));
}

function messageFromEntry(entry: unknown): UnknownRecord | undefined {
	const value = record(entry);
	if (value.type !== "message") return undefined;
	return record(value.message);
}

function emptyReport(): WiseBatchReport {
	return {
		assistantRequests: 0,
		toolBatches: 0,
		toolCalls: 0,
		singletonBatches: 0,
		maxBatchSize: 0,
		callsPerBatch: 0,
		singletonRate: 0,
		toolCounts: {},
		consecutiveSingletonEdits: 0,
		consecutiveDifferentFileEdits: 0,
		consecutiveSameFileEdits: 0,
		consecutiveSingletonBash: 0,
		consecutiveReadOnlyBatches: 0,
		consecutiveSingletonReadOnlyBatches: 0,
		repeatedExactCalls: 0,
		repeatedReads: 0,
		samePathSiblingMutations: 0,
		editCalls: 0,
		editBlocks: 0,
		toolErrors: 0,
		truncatedResults: 0,
		toolResultCharacters: 0,
		totalCost: 0,
		estimatedSingletonToolCallSavings: 0,
		maxContextTokens: 0,
		avoidableEditRequestCostUpperBound: 0,
	};
}

export function analyzeEntries(entries: readonly unknown[]): WiseBatchReport {
	const report = emptyReport();
	let previousBatch: Batch | undefined;
	let seenCalls = new Set<string>();
	let readPaths = new Set<string>();

	for (const entry of entries) {
		const message = messageFromEntry(entry);
		if (!message) continue;
		const role = message.role;

		if (role === "user") {
			previousBatch = undefined;
			seenCalls = new Set();
			readPaths = new Set();
			continue;
		}

		if (role === "toolResult") {
			const text = content(message)
				.filter((item) => item.type === "text" && typeof item.text === "string")
				.map((item) => item.text as string)
				.join("");
			report.toolResultCharacters += text.length;
			if (message.isError === true) report.toolErrors += 1;
			if (/truncat(?:ed|ion)/i.test(text)) report.truncatedResults += 1;
			continue;
		}

		if (role !== "assistant") continue;
		report.assistantRequests += 1;

		const usage = record(message.usage);
		const cost = record(usage.cost);
		if (typeof cost.total === "number" && Number.isFinite(cost.total)) report.totalCost += cost.total;
		const input = typeof usage.input === "number" ? usage.input : 0;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		report.maxContextTokens = Math.max(report.maxContextTokens, input + cacheRead);

		const parsedCalls = parseCalls(message);
		if (parsedCalls.length === 0) continue;
		if (typeof cost.total === "number" && Number.isFinite(cost.total)) {
			report.estimatedSingletonToolCallSavings += cost.total * (parsedCalls.length - 1);
		}
		const batch = { calls: parsedCalls };
		report.toolBatches += 1;
		report.toolCalls += parsedCalls.length;
		report.maxBatchSize = Math.max(report.maxBatchSize, parsedCalls.length);
		if (parsedCalls.length === 1) report.singletonBatches += 1;

		const mutationPaths = new Map<string, number>();
		for (const call of parsedCalls) {
			report.toolCounts[call.name] = (report.toolCounts[call.name] ?? 0) + 1;
			const signature = stableArguments(call);
			if (seenCalls.has(signature)) report.repeatedExactCalls += 1;
			seenCalls.add(signature);

			const path = pathOf(call);
			if (call.name === "read" && path) {
				if (readPaths.has(path)) report.repeatedReads += 1;
				readPaths.add(path);
			}

			if ((call.name === "edit" || call.name === "write") && path) {
				mutationPaths.set(path, (mutationPaths.get(path) ?? 0) + 1);
			}

			if (call.name === "edit") {
				report.editCalls += 1;
				if (Array.isArray(call.arguments.edits)) report.editBlocks += call.arguments.edits.length;
			}
		}
		for (const count of mutationPaths.values()) {
			if (count > 1) report.samePathSiblingMutations += count - 1;
		}

		if (previousBatch) {
			const previousSingle = previousBatch.calls.length === 1 ? previousBatch.calls[0] : undefined;
			const currentSingle = parsedCalls.length === 1 ? parsedCalls[0] : undefined;

			if (isReadOnly(previousBatch) && isReadOnly(batch)) {
				report.consecutiveReadOnlyBatches += 1;
				if (previousSingle && currentSingle) report.consecutiveSingletonReadOnlyBatches += 1;
			}

			if (previousSingle?.name === "edit" && currentSingle?.name === "edit") {
				report.consecutiveSingletonEdits += 1;
				if (pathOf(previousSingle) === pathOf(currentSingle)) report.consecutiveSameFileEdits += 1;
				else report.consecutiveDifferentFileEdits += 1;
				if (typeof cost.total === "number" && Number.isFinite(cost.total)) {
					report.avoidableEditRequestCostUpperBound += cost.total;
				}
			}

			if (previousSingle?.name === "bash" && currentSingle?.name === "bash") {
				report.consecutiveSingletonBash += 1;
			}
		}
		previousBatch = batch;
	}

	report.callsPerBatch = report.toolBatches === 0 ? 0 : report.toolCalls / report.toolBatches;
	report.singletonRate = report.toolBatches === 0 ? 0 : report.singletonBatches / report.toolBatches;
	return report;
}

export function entriesForLatestUserTask(entries: readonly unknown[]): readonly unknown[] {
	let latestUserIndex = -1;
	for (let index = 0; index < entries.length; index += 1) {
		if (messageFromEntry(entries[index])?.role === "user") latestUserIndex = index;
	}
	return latestUserIndex < 0 ? entries : entries.slice(latestUserIndex);
}

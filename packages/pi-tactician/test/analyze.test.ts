import { describe, expect, it } from "vitest";
import { analyzeEntries, entriesForLatestUserTask } from "../src/analyze.ts";

function user(text = "task") {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistant(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, cost = 0) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: toolCalls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, ...call })),
			usage: { input: 100, cacheRead: 900, cost: { total: cost } },
		},
	};
}

function result(text: string, isError = false) {
	return {
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text }], isError },
	};
}

describe("analyzeEntries", () => {
	it("measures batching and sequential inference barriers", () => {
		const report = analyzeEntries([
			user(),
			assistant([{ name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } }], 0.1),
			result("edited"),
			assistant([{ name: "edit", arguments: { path: "src/b.ts", edits: [{ oldText: "c", newText: "d" }] } }], 0.2),
			result("edited"),
			assistant([
				{ name: "read", arguments: { path: "src/a.ts" } },
				{ name: "read", arguments: { path: "src/b.ts" } },
			]),
			result("first"),
			result("Output truncated", true),
			assistant([{ name: "read", arguments: { path: "src/a.ts" } }]),
			result("again"),
		]);

		expect(report.assistantRequests).toBe(4);
		expect(report.toolBatches).toBe(4);
		expect(report.toolCalls).toBe(5);
		expect(report.singletonBatches).toBe(3);
		expect(report.callsPerBatch).toBe(1.25);
		expect(report.maxBatchSize).toBe(2);
		expect(report.consecutiveSingletonEdits).toBe(1);
		expect(report.consecutiveDifferentFileEdits).toBe(1);
		expect(report.avoidableEditRequestCostUpperBound).toBeCloseTo(0.2);
		expect(report.consecutiveReadOnlyBatches).toBe(1);
		expect(report.consecutiveSingletonReadOnlyBatches).toBe(0);
		expect(report.repeatedExactCalls).toBe(1);
		expect(report.repeatedReads).toBe(1);
		expect(report.editCalls).toBe(2);
		expect(report.editBlocks).toBe(2);
		expect(report.toolErrors).toBe(1);
		expect(report.truncatedResults).toBe(1);
		expect(report.maxContextTokens).toBe(1000);
		expect(report.totalCost).toBeCloseTo(0.3);
		expect(report.estimatedSingletonToolCallSavings).toBeCloseTo(0);
	});

	it("estimates savings against splitting batches into singleton requests", () => {
		const report = analyzeEntries([
			user(),
			assistant(
				[
					{ name: "read", arguments: { path: "a" } },
					{ name: "read", arguments: { path: "b" } },
					{ name: "read", arguments: { path: "c" } },
				],
				0.25,
			),
		]);
		expect(report.estimatedSingletonToolCallSavings).toBeCloseTo(0.5);
	});

	it("resets repeat and transition tracking at user boundaries", () => {
		const call = { name: "read", arguments: { path: "README.md" } };
		const report = analyzeEntries([user("one"), assistant([call]), user("two"), assistant([call])]);
		expect(report.repeatedExactCalls).toBe(0);
		expect(report.repeatedReads).toBe(0);
		expect(report.consecutiveReadOnlyBatches).toBe(0);
	});

	it("detects unsafe same-path sibling mutations", () => {
		const report = analyzeEntries([
			user(),
			assistant([
				{ name: "edit", arguments: { path: "src/a.ts", edits: [] } },
				{ name: "write", arguments: { path: "src/a.ts", content: "replacement" } },
			]),
		]);
		expect(report.samePathSiblingMutations).toBe(1);
	});
});

describe("entriesForLatestUserTask", () => {
	it("returns entries beginning with the latest user message", () => {
		const entries = [user("old"), assistant([]), user("new"), assistant([])];
		expect(entriesForLatestUserTask(entries)).toEqual(entries.slice(2));
	});
});

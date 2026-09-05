import { describe, expect, it } from "vitest";
import { analyzeEntries, entriesForLatestUserTask } from "../src/analyze.ts";

let nextId = 0;
function user(text = "task") {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}
interface Call {
	name: string;
	arguments: Record<string, unknown>;
}
const read = (path = "a.ts", extra = {}): Call => ({ name: "read", arguments: { path, ...extra } });
const edit = (path?: string): Call => ({ name: "edit", arguments: { path, edits: [{ oldText: "a", newText: "b" }] } });
function batch(calls: Call[], options: { cost?: number; error?: boolean; pending?: boolean; text?: string; usage?: object; details?: object } = {}) {
	const id = `entry-${++nextId}`;
	const entries = [{
		type: "message", id,
		message: {
			role: "assistant",
			content: calls.map((call, index) => ({ type: "toolCall", id: `${id}-${index}`, ...call })),
			usage: options.usage ?? { input: 100, cacheRead: 900, cost: { total: options.cost ?? 0 } },
		},
	}];
	if (options.pending) return entries;
	return [...entries, ...calls.map((call, index) => ({
		type: "message", message: { role: "toolResult", toolCallId: `${id}-${index}`, toolName: call.name,
			content: [{ type: "text", text: options.text ?? "OK" }], isError: options.error ?? false, details: options.details },
	}))];
}

describe("analyzeEntries", () => {
	it("measures batching, successful edit chains, and evidence", () => {
		const report = analyzeEntries([
			user(), ...batch([edit("a.ts")], { cost: 0.1 }), ...batch([edit("b.ts")], { cost: 0.2 }),
			...batch([read("a.ts"), read("b.ts")]), ...batch([read("a.ts")]),
		]);
		expect(report).toMatchObject({ assistantRequests: 4, toolBatches: 4, toolCalls: 5, singletonBatches: 3,
			callsPerBatch: 1.25, maxBatchSize: 2, consecutiveSingletonEdits: 1, consecutiveDifferentFileEdits: 1,
			consecutiveReadOnlyBatches: 1, consecutiveSingletonReadOnlyBatches: 0,
			repeatedExactCalls: 1, repeatedReads: 1, editCalls: 2, editBlocks: 2, maxContextTokens: 1000 });
		expect(report.totalCost).toBeCloseTo(0.3);
		expect(report.avoidableEditRequestCostUpperBound).toBeCloseTo(0.2);
		expect(report.findings.map(f => f.kind)).toEqual(["cross-file-edits", "repeated-read"]);
		expect(report.findings[0]).toMatchObject({ confidence: "possible", evidence: [
			{ request: 1, tool: "edit", path: "a.ts" }, { request: 2, tool: "edit", path: "b.ts" },
		] });
		expect(report.findings[0].evidence[0].entryId).toMatch(/^entry-/);
		expect(report.findings[0].evidence[0].toolCallId).toMatch(/^entry-/);
		expect(report.findings[0].explanation).toContain("dependency is unknown");
	});

	it("keeps equal-cost splitting a separate hypothetical scenario", () => {
		const r = analyzeEntries(batch([read("a"), read("b"), read("c")], { cost: 0.25 }));
		expect(r.totalCost).toBe(0.25);
		expect(r.estimatedSingletonToolCallSavings).toBe(0.5);
	});

	it("does not treat pagination, post-edit reads, or repair as repeated work", () => {
		const r = analyzeEntries([
			...batch([read("a", { offset: 1, limit: 10 })]), ...batch([read("a", { offset: 11, limit: 10 })]),
			...batch([edit("a")]), ...batch([read("a", { offset: 1, limit: 10 })]),
			...batch([edit("b")], { error: true }), ...batch([edit("b")]),
		]);
		expect(r.repeatedReads).toBe(0);
		expect(r.repeatedExactCalls).toBe(0);
		expect(r.consecutiveSingletonEdits).toBe(0);
		expect(r.avoidableEditRequestCostUpperBound).toBe(0);
		expect(r.toolErrors).toBe(1);
		expect(r.findings).toEqual([]);
	});

	it("does not carry a successful read across a later failed attempt", () => {
		const r = analyzeEntries([...batch([read()]), ...batch([read()], { error: true }), ...batch([read()])]);
		expect(r.repeatedReads).toBe(0);
		expect(r.findings).toEqual([]);
	});

	it("treats search→read as an observation, not a finding", () => {
		const r = analyzeEntries([...batch([{ name: "fffind", arguments: { pattern: "a" } }]), ...batch([read("a")])]);
		expect(r.consecutiveReadOnlyBatches).toBe(1);
		expect(r.findings).toEqual([]);
	});

	it("normalizes paths and default offsets without reading the filesystem", () => {
		const r = analyzeEntries([...batch([read("./a")]), ...batch([read("/repo/a", { offset: 1 })])], { cwd: "/repo" });
		expect(r.repeatedReads).toBe(1);
		const siblings = analyzeEntries(batch([edit("@./a"), { name: "write", arguments: { path: "a", content: "x" } }]));
		expect(siblings.samePathSiblingMutations).toBe(1);
		expect(siblings.findings[0]).toMatchObject({ kind: "same-path-mutations", confidence: "observed" });
		expect(siblings.findings[0].explanation).toContain("does not prove a write race");
	});

	it("does not classify missing paths as same-file edits", () => {
		const r = analyzeEntries([...batch([edit()]), ...batch([edit()])]);
		expect(r.consecutiveSameFileEdits).toBe(0);
		expect(r.consecutiveDifferentFileEdits).toBe(0);
		expect(r.findings).toEqual([]);
	});

	it("requires successful results linked by ID before suggesting edits or repeats", () => {
		const r = analyzeEntries([...batch([edit("a")], { pending: true }), ...batch([edit("b")]),
			...batch([read("a")], { error: true }), ...batch([read("a")]), ...batch([read("a")], { pending: true })]);
		expect(r.consecutiveSingletonEdits).toBe(0);
		expect(r.repeatedReads).toBe(0);
		expect(r.findings).toEqual([]);
	});

	it.each([
		user("new"),
		{ type: "compaction" },
		{ type: "branch_summary" },
		{ type: "custom_message", content: "new instruction" },
		{ type: "message", message: { role: "bashExecution", command: "touch a" } },
		{ type: "message", message: { role: "assistant", content: [] } },
	])("resets transition and repeat tracking at meaningful boundaries: %j", boundary => {
		const r = analyzeEntries([...batch([read()]), boundary, ...batch([read()])]);
		expect(r.repeatedReads).toBe(0);
		expect(r.consecutiveReadOnlyBatches).toBe(0);
	});

	it("ignores TUI-only entries as boundaries", () => {
		const r = analyzeEntries([...batch([read()]), { type: "custom", customType: "pi-tactician-report" }, ...batch([read()])]);
		expect(r.repeatedReads).toBe(1);
	});

	it.each(["bash", "custom_mutator"])("invalidates read observations around opaque %s calls", name => {
		const r = analyzeEntries([...batch([read()]), ...batch([{ name, arguments: { command: "touch a.ts" } }]), ...batch([read()])]);
		expect(r.repeatedReads).toBe(0);
	});

	it("counts UTF-8 bytes and prefers structured truncation metadata", () => {
		const r = analyzeEntries([
			...batch([read("a")], { text: "é🙂 truncation is documented here" }),
			...batch([read("b")], { text: "Output truncated", details: { truncation: { truncated: false } } }),
			...batch([read("c")], { text: "partial", details: { truncation: { truncated: true } } }),
			...batch([read("d")], { text: "Output truncated" }),
		]);
		expect(r.truncatedResults).toBe(2);
		expect(r.toolResultBytes).toBe(r.toolResultCharacters + 3);
	});

	it("includes cache writes and separates parent, nested tool, and summary costs", () => {
		const r = analyzeEntries([
			...batch([read()], { usage: { input: 100, cacheRead: 900, cacheWrite: 500,
				cost: { total: 0.1, input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04 } } }),
			{ type: "message", message: { role: "toolResult", content: [], usage: { cost: { total: 0.2 } } } },
			{ type: "compaction", usage: { cost: { total: 0.3 } } },
			{ type: "branch_summary", usage: { cost: { total: 0.4 } } },
			...batch([], { usage: {} }), ...batch([], { usage: { cost: { total: 0 } } }),
		]);
		expect(r.maxContextTokens).toBe(1500);
		expect(r.totalCost).toBe(0.1);
		expect(r.pricedRequests).toBe(2);
		expect(r.nestedToolCost).toBe(0.2);
		expect(r.summaryCost).toBeCloseTo(0.7);
		expect(r.requestCostBreakdown).toEqual({ input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04 });
	});

	it("handles malformed entries, non-finite usage, and legacy edit blocks", () => {
		const r = analyzeEntries([null, {}, { type: "message", message: null }, ...batch([
			{ name: "edit", arguments: { path: "a", oldText: "a", newText: "b" } },
		], { usage: { input: NaN, cacheRead: Infinity, cacheWrite: -1, cost: { total: Infinity } } })]);
		expect(r.editBlocks).toBe(1);
		expect(r.maxContextTokens).toBe(0);
		expect(r.pricedRequests).toBe(0);
		expect(r.totalCost).toBe(0);
	});

	it("does not flag a read alongside a same-path mutation as repeated work", () => {
		const r = analyzeEntries([...batch([read()]), ...batch([read(), edit("a.ts")]), ...batch([read()])]);
		expect(r.repeatedReads).toBe(0);
	});

	it("counts tool names that collide with Object prototype properties", () => {
		const r = analyzeEntries(batch([{ name: "__proto__", arguments: {} }, { name: "constructor", arguments: {} }]));
		expect(r.toolCounts["__proto__"]).toBe(1);
		expect(r.toolCounts.constructor).toBe(1);
	});

	it("bounds findings without losing aggregate counts", () => {
		const r = analyzeEntries(Array.from({ length: 30 }, () => batch([read()])).flat());
		expect(r.repeatedReads).toBe(29);
		expect(r.findings).toHaveLength(20);
		expect(r.omittedFindings).toBe(9);
	});
});

describe("entriesForLatestUserTask", () => {
	it("selects the latest user message and handles empty/no-user branches", () => {
		const entries = [user("old"), ...batch([]), user("new"), ...batch([])];
		expect(entriesForLatestUserTask(entries)).toEqual(entries.slice(2));
		expect(entriesForLatestUserTask([])).toEqual([]);
		const noUser = batch([read()]);
		expect(entriesForLatestUserTask(noUser)).toBe(noUser);
	});
});

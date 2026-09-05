import { describe, expect, it } from "vitest";
import { analyzeEntries, emptyReport } from "../src/analyze.ts";
import { formatReport, normalizeStoredReport, REPORT_SCHEMA_VERSION, type StoredTacticianReport } from "../src/report.ts";

const modern = (report = emptyReport()): StoredTacticianReport => ({ schemaVersion: REPORT_SCHEMA_VERSION, scope: "task" as const, report });

describe("report persistence and formatting", () => {
	it("distinguishes absent pricing from recorded zero cost", () => {
		expect(formatReport(modern())).toContain("Parent request cost (recorded): Unavailable");
		expect(formatReport(modern({ ...emptyReport(), assistantRequests: 1, pricedRequests: 1 })))
			.toContain("Parent request cost (recorded): $0.0000");
	});
	it("shows scenario assumptions without claiming measured savings", () => {
		const text = formatReport(modern({ ...emptyReport(), assistantRequests: 1, pricedRequests: 1, estimatedSingletonToolCallSavings: 0.5 }));
		expect(text).toContain("Equal-cost split scenario: $0.50");
		expect(text).toContain("not measured savings");
		expect(text).toContain("not evidence of wasted work");
		expect(text).not.toContain("Estimated cost saved");
	});
	it("preserves legacy character units and warns about old metric definitions", () => {
		const data = normalizeStoredReport({ scope: "session", report: { toolResultCharacters: 2048, totalCost: 0.1 } });
		const text = formatReport(data);
		expect(text).toContain("2048 UTF-16 code units (legacy)");
		expect(text).toContain("Unknown (legacy report)");
		expect(text).toContain("Run /tactician-report again");
		expect(text).not.toContain("KiB");
	});
	it.each([null, {}, { report: { callsPerBatch: Infinity, totalCost: NaN, toolCounts: null, findings: [{}] } }, { schemaVersion: 99, report: {} }])("normalizes malformed or unsupported data safely: %j", value => {
		const data = normalizeStoredReport(value);
		expect(() => formatReport(data)).not.toThrow();
		expect(data.report.totalCost).toBe(0);
		expect(data.report.callsPerBatch).toBe(0);
		expect(data.report.findings).toEqual([]);
	});
	it("validates findings and strips terminal controls from historical evidence", () => {
		const data = normalizeStoredReport({ ...modern(), report: { ...emptyReport(), findings: [
			{}, { kind: "cross-file-edits", confidence: "possible", explanation: "Dependency unknown", evidence: [{ request: 1, tool: "edit", path: "a\x1b[31m.ts\n" }] },
		] } });
		expect(data.report.findings).toHaveLength(1);
		const text = formatReport(data);
		expect(text).toContain("Request 1: edit a.ts");
		expect(text).not.toContain("\x1b");
	});
	it("shows calls per batched request and renders empty reports safely", () => {
		const report = { ...emptyReport(), toolBatches: 3, toolCalls: 6, singletonBatches: 1 };
		const text = formatReport(modern(report));
		expect(text).toContain("Calls / batched request: 2.50");
		expect(formatReport(modern(analyzeEntries([])))).toContain("not proof of optimal batching");
	});
});

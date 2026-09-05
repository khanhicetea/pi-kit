import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { emptyReport } from "../src/analyze.ts";
import type { StoredTacticianReport } from "../src/report.ts";
import { createBatchMarkerComponent, createReportComponent, findBatchContainingToolCall } from "../src/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
} as unknown as Theme;

const data: StoredTacticianReport = {
	schemaVersion: 2,
	scope: "task",
	report: {
		...emptyReport(),
		assistantRequests: 9,
		toolBatches: 7,
		toolCalls: 12,
		singletonBatches: 5,
		maxBatchSize: 4,
		callsPerBatch: 12 / 7,
		singletonRate: 5 / 7,
		toolCounts: { edit: 6, read: 4, bash: 2 },
		consecutiveSingletonEdits: 3,
		consecutiveDifferentFileEdits: 2,
		consecutiveSameFileEdits: 1,
		consecutiveSingletonBash: 1,
		consecutiveReadOnlyBatches: 2,
		consecutiveSingletonReadOnlyBatches: 1,
		repeatedExactCalls: 1,
		repeatedReads: 2,
		samePathSiblingMutations: 0,
		editCalls: 6,
		editBlocks: 10,
		toolErrors: 1,
		truncatedResults: 1,
		toolResultCharacters: 12_000,
		totalCost: 0.42,
		estimatedSingletonToolCallSavings: 0.18,
		maxContextTokens: 81_234,
		avoidableEditRequestCostUpperBound: 0.11,
	},
};

describe("Tactician report UI", () => {
	it("renders one high-signal summary line when space allows", () => {
		const lines = createReportComponent(data, false, theme).render(200);
		const text = lines.join("\n");
		expect(lines).toHaveLength(1);
		expect(text).toContain("Tactician · Task");
		expect(text).toContain("Calls / requests");
		expect(text).toContain("12 / 7");
		expect(text).toContain("1.71");
		expect(text).toContain("Calls / batched request");
		expect(text).toContain("3.50");
		expect(text).toContain("Singleton");
		expect(text).toContain("Findings");
		expect(text).not.toContain("saved");
		expect(text).not.toContain("$0.18");
		expect(lines.every((line) => visibleWidth(line) <= 200)).toBe(true);
	});

	it("shows tool and diagnostic tables when expanded", () => {
		const lines = createReportComponent(data, true, theme).render(64);
		const text = lines.join("\n");
		expect(text).toContain("TOOLS");
		expect(text).toContain("DIAGNOSTICS");
		expect(text).toContain("COST");
		expect(text).toContain("Equal-cost split scenario");
		expect(text).toContain("INTERPRETATION");
		expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
	});

	it.each([0, 1, 2, 3, 10, 28, 64, 80, 120, 200])("stays within terminal width %i", width => {
		for (const expanded of [true, false]) {
			const lines = createReportComponent(data, expanded, theme).render(width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("does not color high singleton rates as errors", () => {
		const tones: string[] = [];
		const recordingTheme = { ...theme, fg: (tone: string, text: string) => { tones.push(tone); return text; } } as Theme;
		const singleton = { ...data, report: { ...emptyReport(), toolBatches: 1, toolCalls: 1, singletonBatches: 1, singletonRate: 1 } };
		createReportComponent(singleton, false, recordingTheme).render(200);
		createReportComponent(singleton, true, recordingTheme).render(80);
		expect(tones).not.toContain("error");
		expect(tones).not.toContain("warning");
	});

	it("renders a compact transcript marker for sibling tool calls", () => {
		const compact = createBatchMarkerComponent({ schemaVersion: 1, tools: ["read", "ffgrep", "read"] }, false, theme).render(100).join("\n");
		const expanded = createBatchMarkerComponent({ schemaVersion: 1, tools: ["read", "ffgrep", "read"] }, true, theme).render(100).join("\n");
		expect(compact).toContain("Batch ×3");
		expect(compact).toContain("sibling tool calls");
		expect(expanded).toContain("may execute concurrently");
	});
});

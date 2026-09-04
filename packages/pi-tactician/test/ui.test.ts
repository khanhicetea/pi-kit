import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { StoredWiseBatchReport } from "../src/report.ts";
import { createReportComponent } from "../src/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
} as unknown as Theme;

const data: StoredWiseBatchReport = {
	scope: "task",
	report: {
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

describe("wise batcher report UI", () => {
	it("renders one high-signal summary line when space allows", () => {
		const lines = createReportComponent(data, false, theme).render(200);
		const text = lines.join("\n");
		expect(lines).toHaveLength(1);
		expect(text).toContain("Wise Batcher · Task");
		expect(text).toContain("Tool calls / batches");
		expect(text).toContain("12 / 7");
		expect(text).toContain("1.71 calls/request");
		expect(text).toContain("Singleton");
		expect(text).toContain("Barriers");
		expect(text).toContain("Est. saved vs singletons");
		expect(text).toContain("$0.18");
		expect(lines.every((line) => visibleWidth(line) <= 200)).toBe(true);
	});

	it("shows tool and diagnostic tables when expanded", () => {
		const lines = createReportComponent(data, true, theme).render(64);
		const text = lines.join("\n");
		expect(text).toContain("TOOLS");
		expect(text).toContain("DIAGNOSTICS");
		expect(text).toContain("Recorded request cost");
		expect(text).toContain("Est. saved vs singleton calls");
		expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
	});

	it("stays within narrow terminal widths", () => {
		const lines = createReportComponent(data, true, theme).render(28);
		expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
	});
});

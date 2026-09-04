import type { WiseBatchReport } from "./analyze.ts";

export const REPORT_ENTRY_TYPE = "pi-tactician-report";

export interface StoredWiseBatchReport {
	scope: "task" | "session";
	report: WiseBatchReport;
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function dollars(value: number): string {
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatReport(data: StoredWiseBatchReport): string {
	const { report, scope } = data;
	const lines = [
		`Wise Batcher · ${scope === "task" ? "current task" : "active session branch"}`,
		`Requests ${report.assistantRequests} · tool rounds ${report.toolBatches} · calls ${report.toolCalls}`,
		`Calls/round ${report.callsPerBatch.toFixed(2)} · singleton rounds ${report.singletonBatches}/${report.toolBatches} (${percent(report.singletonRate)}) · max batch ${report.maxBatchSize}`,
	];

	if (report.consecutiveSingletonEdits > 0) {
		lines.push(
			`Sequential edit barriers ${report.consecutiveSingletonEdits} (${report.consecutiveDifferentFileEdits} different-file, ${report.consecutiveSameFileEdits} same-file)`,
		);
	}
	if (report.consecutiveSingletonBash > 0) {
		lines.push(`Sequential singleton bash barriers ${report.consecutiveSingletonBash}`);
	}
	if (report.consecutiveReadOnlyBatches > 0) {
		lines.push(
			`Read-only round chains ${report.consecutiveReadOnlyBatches} (${report.consecutiveSingletonReadOnlyBatches} singleton→singleton)`,
		);
	}
	if (report.repeatedExactCalls > 0 || report.repeatedReads > 0) {
		lines.push(`Repeated exact calls ${report.repeatedExactCalls} · repeated read paths ${report.repeatedReads}`);
	}
	if (report.samePathSiblingMutations > 0) {
		lines.push(`Warning: same-path sibling mutations ${report.samePathSiblingMutations}`);
	}
	if (report.editCalls > 0) {
		lines.push(`Edit calls ${report.editCalls} · edit blocks ${report.editBlocks}`);
	}
	if (report.toolErrors > 0 || report.truncatedResults > 0) {
		lines.push(`Tool errors ${report.toolErrors} · truncated results ${report.truncatedResults}`);
	}

	const topTools = Object.entries(report.toolCounts)
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([name, count]) => `${name} ${count}`)
		.join(" · ");
	if (topTools) lines.push(`Tools: ${topTools}`);

	lines.push(
		`Tool-result volume ${(report.toolResultCharacters / 1024).toFixed(1)} KiB · max context ${report.maxContextTokens.toLocaleString()} tokens`,
		`Recorded request cost ${dollars(report.totalCost)}`,
	);
	if (report.avoidableEditRequestCostUpperBound > 0) {
		lines.push(
			`Sequential-edit request cost upper bound ${dollars(report.avoidableEditRequestCostUpperBound)} (opportunity estimate, not guaranteed savings)`,
		);
	}
	lines.push(
		`Estimated cost saved vs singleton tool calls ${dollars(report.estimatedSingletonToolCallSavings ?? 0)} (assumes each split request costs the same as its batch)`,
	);
	return lines.join("\n");
}

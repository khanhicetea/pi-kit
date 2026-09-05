import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeEntries, entriesForLatestUserTask } from "./analyze.ts";
import { GUIDANCE_MARKER, TACTICIAN_GUIDANCE } from "./guidance.ts";
import { REPORT_ENTRY_TYPE, REPORT_SCHEMA_VERSION, type StoredTacticianReport } from "./report.ts";
import {
	BATCH_ENTRY_TYPE,
	BATCH_SCHEMA_VERSION,
	createBatchMarkerComponent,
	createReportComponent,
	findBatchContainingToolCall,
} from "./ui.ts";

export { analyzeEntries, entriesForLatestUserTask } from "./analyze.ts";
export type { TacticianReport, BatchingFinding, FindingEvidence } from "./analyze.ts";
export { GUIDANCE_MARKER, TACTICIAN_GUIDANCE } from "./guidance.ts";
export { formatReport, normalizeStoredReport, REPORT_ENTRY_TYPE, REPORT_SCHEMA_VERSION } from "./report.ts";
export type { StoredTacticianReport } from "./report.ts";
export {
	BATCH_ENTRY_TYPE,
	BATCH_SCHEMA_VERSION,
	createBatchMarkerComponent,
	createReportComponent,
	findBatchContainingToolCall,
} from "./ui.ts";
export type { StoredTacticianBatch, ToolBatch } from "./ui.ts";

export default function tacticianExtension(pi: ExtensionAPI) {
	const markedBatches = new Set<string>();

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const batch = findBatchContainingToolCall(ctx.sessionManager.getBranch(), event.toolCallId);
		if (!batch || batch.tools.length < 2 || batch.toolCallIds.length !== batch.tools.length) return;
		const key = batch.toolCallIds.join("\u0000");
		if (markedBatches.has(key)) return;
		markedBatches.add(key);
		pi.appendEntry(BATCH_ENTRY_TYPE, { schemaVersion: BATCH_SCHEMA_VERSION, tools: batch.tools });
	});

	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(GUIDANCE_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${TACTICIAN_GUIDANCE}` };
	});

	pi.registerEntryRenderer<StoredTacticianReport>(REPORT_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data ?? { scope: "task", report: analyzeEntries([]) };
		return createReportComponent(data, expanded, theme);
	});
	pi.registerEntryRenderer(BATCH_ENTRY_TYPE, (entry, { expanded }, theme) =>
		createBatchMarkerComponent(entry.data, expanded, theme),
	);

	pi.registerCommand("tactician-report", {
		description: "Report tool batching observations and evidence-backed findings for the current task or session",
		getArgumentCompletions: (prefix) =>
			["task", "session"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() || "session";
			if (requested && requested !== "task" && requested !== "session") {
				ctx.ui.notify("Usage: /tactician-report [task|session]", "warning");
				return;
			}

			const scope = requested === "session" ? "session" : "task";
			const branch = ctx.sessionManager.getBranch();
			const selected = scope === "session" ? branch : entriesForLatestUserTask(branch);
			const data: StoredTacticianReport = { schemaVersion: REPORT_SCHEMA_VERSION, scope, report: analyzeEntries(selected, { cwd: ctx.cwd }) };
			pi.appendEntry(REPORT_ENTRY_TYPE, data);
			ctx.ui.notify(
				`Tactician: ${data.report.toolBatches} rounds, ${data.report.callsPerBatch.toFixed(2)} calls/round, ${data.report.callsPerBatchedRequest.toFixed(2)} calls/batched request, ${data.report.findings.length}${data.report.omittedFindings ? "+" : ""} findings`,
				"info",
			);
		},
	});
}

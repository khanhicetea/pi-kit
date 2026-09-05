import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeEntries, entriesForLatestUserTask } from "./analyze.ts";
import { GUIDANCE_MARKER, WISE_BATCHING_GUIDANCE } from "./guidance.ts";
import { REPORT_ENTRY_TYPE, REPORT_SCHEMA_VERSION, type StoredWiseBatchReport } from "./report.ts";
import { createReportComponent } from "./ui.ts";

export { analyzeEntries, entriesForLatestUserTask } from "./analyze.ts";
export type { WiseBatchReport, BatchingFinding, FindingEvidence } from "./analyze.ts";
export { GUIDANCE_MARKER, WISE_BATCHING_GUIDANCE } from "./guidance.ts";
export { formatReport, normalizeStoredReport, REPORT_ENTRY_TYPE, REPORT_SCHEMA_VERSION } from "./report.ts";
export type { StoredWiseBatchReport } from "./report.ts";
export { createReportComponent } from "./ui.ts";

export default function wiseBatcherExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(GUIDANCE_MARKER)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${WISE_BATCHING_GUIDANCE}` };
	});

	pi.registerEntryRenderer<StoredWiseBatchReport>(REPORT_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data ?? { scope: "task", report: analyzeEntries([]) };
		return createReportComponent(data, expanded, theme);
	});

	pi.registerCommand("tactician-report", {
		description: "Report tool batching observations and evidence-backed findings for the current task or session",
		getArgumentCompletions: (prefix) =>
			["task", "session"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() || "task";
			if (requested && requested !== "task" && requested !== "session") {
				ctx.ui.notify("Usage: /tactician-report [task|session]", "warning");
				return;
			}

			const scope = requested === "session" ? "session" : "task";
			const branch = ctx.sessionManager.getBranch();
			const selected = scope === "session" ? branch : entriesForLatestUserTask(branch);
			const data: StoredWiseBatchReport = { schemaVersion: REPORT_SCHEMA_VERSION, scope, report: analyzeEntries(selected, { cwd: ctx.cwd }) };
			pi.appendEntry(REPORT_ENTRY_TYPE, data);
			ctx.ui.notify(
				`Tactician: ${data.report.toolBatches} rounds, ${data.report.callsPerBatch.toFixed(2)} calls/round, ${data.report.findings.length}${data.report.omittedFindings ? "+" : ""} findings`,
				"info",
			);
		},
	});
}

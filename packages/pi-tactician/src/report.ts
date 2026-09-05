import { stripVTControlCharacters } from "node:util";
import { emptyReport, type BatchingFinding, type FindingEvidence, type TacticianReport } from "./analyze.ts";

export const REPORT_ENTRY_TYPE = "pi-tactician-report";
export const REPORT_SCHEMA_VERSION = 2;

export interface StoredTacticianReport {
	/** Absent on reports saved before metric corrections. */
	schemaVersion?: 2;
	scope: "task" | "session";
	report: TacticianReport;
}
export interface MetricRow {
	label: string;
	value: string;
	tone?: "text" | "accent" | "warning" | "muted";
}
export interface ReportSection {
	title: string;
	rows: MetricRow[];
}
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function validNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function displayText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function dollars(value: number): string {
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Treat persisted entries as untrusted, potentially older data. Never reinterpret legacy characters as bytes. */
export function normalizeStoredReport(value: unknown): StoredTacticianReport {
	const data = record(value);
	const raw = record(data.report);
	const report = emptyReport();
	for (const key of Object.keys(report) as Array<keyof TacticianReport>) {
		if (typeof report[key] === "number" && validNumber(raw[key])) {
			(report as unknown as Record<string, unknown>)[key] = raw[key];
		}
	}
	report.toolCounts = Object.fromEntries(Object.entries(record(raw.toolCounts)).filter(([, count]) => validNumber(count))) as Record<string, number>;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const cost = record(raw.requestCostBreakdown)[key];
		if (validNumber(cost)) report.requestCostBreakdown[key] = cost;
	}
	report.callsPerBatch = report.toolBatches ? report.toolCalls / report.toolBatches : 0;
	report.singletonBatches = Math.min(report.singletonBatches, report.toolBatches);
	const batchedRequests = report.toolBatches - report.singletonBatches;
	const batchedCalls = Math.max(0, report.toolCalls - report.singletonBatches);
	report.callsPerBatchedRequest = batchedRequests ? batchedCalls / batchedRequests : 0;
	report.singletonRate = report.toolBatches ? report.singletonBatches / report.toolBatches : 0;
	report.pricedRequests = Math.min(report.pricedRequests, report.assistantRequests);
	if (data.schemaVersion === REPORT_SCHEMA_VERSION && Array.isArray(raw.findings)) {
		for (const item of raw.findings.slice(0, 20)) {
			const finding = record(item);
			if (!["cross-file-edits", "repeated-read", "same-path-mutations"].includes(String(finding.kind))) continue;
			if (finding.confidence !== "possible" && finding.confidence !== "observed") continue;
			if (typeof finding.explanation !== "string" || !Array.isArray(finding.evidence)) continue;
			const evidence: FindingEvidence[] = [];
			for (const item of finding.evidence.slice(0, 4)) {
				const ref = record(item);
				if (!validNumber(ref.request) || typeof ref.tool !== "string") continue;
				evidence.push({
					request: ref.request, tool: ref.tool,
					entryId: typeof ref.entryId === "string" ? ref.entryId : undefined,
					toolCallId: typeof ref.toolCallId === "string" ? ref.toolCallId : undefined,
					path: typeof ref.path === "string" ? ref.path : undefined,
				});
			}
			if (evidence.length) report.findings.push({ kind: finding.kind as BatchingFinding["kind"], confidence: finding.confidence, explanation: finding.explanation, evidence });
		}
	}
	return { schemaVersion: data.schemaVersion === REPORT_SCHEMA_VERSION ? REPORT_SCHEMA_VERSION : undefined, scope: data.scope === "session" ? "session" : "task", report };
}

export function reportSections(data: StoredTacticianReport): ReportSection[] {
	const { report: r } = data;
	const modern = data.schemaVersion === REPORT_SCHEMA_VERSION;
	const observations: MetricRow[] = [
		{ label: "Successful sequential edits", value: `${r.consecutiveSingletonEdits} · ${r.consecutiveDifferentFileEdits} cross-file · ${r.consecutiveSameFileEdits} same-file` },
		{ label: "Sequential bash rounds", value: String(r.consecutiveSingletonBash) },
		{ label: "Read-only round chains", value: `${r.consecutiveReadOnlyBatches} · ${r.consecutiveSingletonReadOnlyBatches} singleton→singleton` },
		{ label: "Repeated exact calls", value: String(r.repeatedExactCalls) },
		{ label: modern ? "Repeated identical read ranges" : "Repeated read paths (legacy)", value: String(r.repeatedReads) },
		{ label: "Same-path sibling mutations", value: String(r.samePathSiblingMutations), tone: r.samePathSiblingMutations ? "warning" : "text" },
	];
	if (!modern) observations[0].label = "Sequential edits (legacy)";
	const cost: MetricRow[] = [
		{ label: "Parent request cost (recorded)", value: modern && !r.pricedRequests ? "Unavailable" : dollars(r.totalCost), tone: "accent" },
		{ label: "Requests with recorded pricing", value: modern ? `${r.pricedRequests}/${r.assistantRequests}` : "Unknown (legacy report)" },
	];
	if (modern) {
		cost.push(
			{ label: "Input / output cost", value: `${dollars(r.requestCostBreakdown.input)} / ${dollars(r.requestCostBreakdown.output)}` },
			{ label: "Cache read / write cost", value: `${dollars(r.requestCostBreakdown.cacheRead)} / ${dollars(r.requestCostBreakdown.cacheWrite)}` },
			{ label: "Nested tool cost (recorded)", value: dollars(r.nestedToolCost) },
			{ label: "Summary cost (recorded)", value: dollars(r.summaryCost) },
		);
	}
	cost.push(
		{ label: "Sequential-edit request cost", value: dollars(r.avoidableEditRequestCostUpperBound) },
		{ label: "Equal-cost split scenario", value: modern && !r.pricedRequests ? "Unavailable" : dollars(r.estimatedSingletonToolCallSavings), tone: "muted" },
	);
	return [
		{ title: "ACTIVITY", rows: [
			{ label: "Assistant requests", value: String(r.assistantRequests) },
			{ label: "Tool rounds", value: String(r.toolBatches) },
			{ label: "Tool calls", value: String(r.toolCalls) },
			{ label: "Calls / round", value: r.callsPerBatch.toFixed(2), tone: "accent" },
			{ label: "Calls / batched request", value: r.callsPerBatchedRequest.toFixed(2), tone: "accent" },
			{ label: "Singleton rounds", value: `${r.singletonBatches}/${r.toolBatches} (${(r.singletonRate * 100).toFixed(1)}%)` },
			{ label: "Largest batch", value: String(r.maxBatchSize) },
		] },
		{ title: "OBSERVATIONS", rows: observations },
		{ title: "TOOLS", rows: Object.entries(r.toolCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label: displayText(label), value: String(count) })) },
		{ title: "DIAGNOSTICS", rows: [
			{ label: "Edit calls / blocks", value: `${r.editCalls} / ${r.editBlocks}` },
			{ label: "Errors / truncations", value: `${r.toolErrors} / ${r.truncatedResults}`, tone: r.toolErrors + r.truncatedResults ? "warning" : "text" },
			{ label: "Tool-result text volume", value: modern ? `${(r.toolResultBytes / 1024).toFixed(1)} KiB (UTF-8)` : `${r.toolResultCharacters} UTF-16 code units (legacy)` },
			{ label: "Maximum input context", value: `${r.maxContextTokens.toLocaleString()} tokens` },
		] },
		{ title: "COST", rows: cost },
	];
}

export function findingLines(data: StoredTacticianReport): string[] {
	const lines = data.report.findings.flatMap(finding => [
		`${finding.confidence === "possible" ? "Possible opportunity" : "Observed pattern"}: ${finding.kind}`,
		finding.evidence.map(ref => `Request ${ref.request}${ref.entryId ? ` [entry ${ref.entryId}]` : ""}: ${ref.tool}${ref.path ? ` ${ref.path}` : ""}${ref.toolCallId ? ` [call ${ref.toolCallId}]` : ""}`).join(" → "),
		finding.explanation,
	]);
	if (!lines.length) lines.push("No evidence-backed findings. This is not proof of optimal batching.");
	if (data.report.omittedFindings) lines.push(`${data.report.omittedFindings} additional findings omitted (showing at most 20).`);
	return lines.map(displayText);
}
export function reportNotes(data: StoredTacticianReport): string[] {
	return [
		...(data.schemaVersion === REPORT_SCHEMA_VERSION ? [] : ["Legacy or unsupported report schema: metrics may use older definitions. Run /tactician-report again for corrected metrics."]),
		"Sequential rounds and singleton rates are observations, not evidence of wasted work. Search→read and repair dependencies can require waiting.",
		"Costs are recorded amounts only; missing components are not inferred. The equal-cost split scenario sums batch cost × (calls − 1), assumes identical split-request costs, and is not measured savings. Sequential-edit cost is not a savings ceiling.",
	];
}
export function formatReport(value: StoredTacticianReport): string {
	const data = normalizeStoredReport(value);
	return [
		`Tactician · ${data.scope === "task" ? "current task" : "active session branch"}`,
		...reportSections(data).flatMap(section => [section.title, ...section.rows.map(row => `${row.label}: ${row.value}`)]),
		"FINDINGS", ...findingLines(data), ...reportNotes(data),
	].join("\n");
}

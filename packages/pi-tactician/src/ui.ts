import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayText, findingLines, normalizeStoredReport, reportNotes, reportSections, type MetricRow, type StoredTacticianReport } from "./report.ts";

export const BATCH_ENTRY_TYPE = "pi-tactician-batch";
export const BATCH_SCHEMA_VERSION = 1;

export interface ToolBatch {
	toolCallIds: string[];
	tools: string[];
}

export interface StoredTacticianBatch {
	schemaVersion: 1;
	tools: string[];
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toolBatchFromEntry(entry: unknown): ToolBatch | undefined {
	const message = record(record(entry).message);
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const calls = message.content.map(record).filter(item => item.type === "toolCall");
	if (!calls.length) return undefined;
	return {
		toolCallIds: calls.map(item => typeof item.id === "string" ? item.id : "").filter(Boolean),
		tools: calls.map(item => displayText(typeof item.name === "string" ? item.name : "unknown")),
	};
}

/** Return the sibling tool calls from the latest assistant request containing a given call. */
export function findBatchContainingToolCall(entries: readonly unknown[], toolCallId: string): ToolBatch | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const batch = toolBatchFromEntry(entries[index]);
		if (batch?.toolCallIds.includes(toolCallId)) return batch;
	}
	return undefined;
}

export function createBatchMarkerComponent(value: unknown, expanded: boolean, theme: Theme): Component {
	const data = record(value);
	const tools = Array.isArray(data.tools)
		? data.tools.filter((tool): tool is string => typeof tool === "string").slice(0, 12).map(displayText)
		: [];
	const count = tools.length;
	const summary = `${theme.fg("accent", theme.bold(`▣ Batch ×${count}`))}${theme.fg("muted", "  sibling tool calls  ")}${tools.join(theme.fg("borderMuted", " · "))}`;
	const box = new Box(1, 0, text => theme.bg("customMessageBg", text));
	box.addChild({
		render: width => wrapTextWithAnsi(summary, Math.max(1, width)),
		invalidate() {},
	});
	if (expanded) {
		box.addChild({
			render: width => wrapTextWithAnsi(theme.fg("muted", "These calls came from one assistant request and may execute concurrently."), Math.max(1, width)),
			invalidate() {},
		});
	}
	return box;
}

function padRight(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

class TacticianReportBody implements Component {
	constructor(
		private readonly data: StoredTacticianReport,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	private border(title: string, width: number, bottom = false): string {
		const left = bottom ? "╰─" : "╭─";
		const titlePart = title ? ` ${title} ` : "";
		const fill = "─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(titlePart)));
		return this.theme.fg(bottom ? "borderMuted" : "borderAccent", truncateToWidth(left + titlePart + fill, width, ""));
	}

	private section(title: string, width: number): string {
		const prefix = `├─ ${title} `;
		return this.theme.fg("borderMuted", truncateToWidth(prefix + "─".repeat(Math.max(0, width - visibleWidth(prefix))), width, ""));
	}

	private paragraph(text: string, width: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width - 3)).map(line => truncateToWidth(`│  ${line}`, width, ""));
	}

	private table(rows: MetricRow[], width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		if (contentWidth < 40) {
			return rows.flatMap(row => this.paragraph(`${this.theme.fg("muted", row.label)}: ${this.theme.fg(row.tone ?? "text", row.value)}`, width));
		}
		const desiredLabelWidth = Math.max(12, ...rows.map(row => visibleWidth(row.label)));
		const labelWidth = Math.min(desiredLabelWidth, Math.floor(contentWidth * 0.62));
		const valueWidth = Math.max(1, contentWidth - labelWidth - 2);
		return rows.flatMap(row => {
			const labels = wrapTextWithAnsi(row.label, labelWidth);
			const values = wrapTextWithAnsi(row.value, valueWidth);
			return Array.from({ length: Math.max(labels.length, values.length) }, (_, index) => truncateToWidth(
				`${this.theme.fg("borderMuted", "│")}  ${this.theme.fg("muted", padRight(labels[index] ?? "", labelWidth))}  ${this.theme.fg(row.tone ?? "text", values[index] ?? "")}`, width, "",
			));
		});
	}

	private compactSummary(width: number): string[] {
		const r = this.data.report;
		const text = [
			this.theme.fg("accent", this.theme.bold(`⚡ Tactician · ${this.data.scope === "task" ? "Task" : "Session"}`)),
			`${this.theme.fg("muted", "Calls / requests")} ${r.toolCalls} / ${r.toolBatches} = ${this.theme.fg("accent", `${r.callsPerBatch.toFixed(2)}`)}`,
			`${this.theme.fg("muted", "Calls / batched request")} ${this.theme.fg("accent", r.callsPerBatchedRequest.toFixed(2))}`,
			`${this.theme.fg("muted", "Singleton")} ${r.singletonBatches}/${r.toolBatches} (${(r.singletonRate * 100).toFixed(0)}%)`,
			`${this.theme.fg("muted", "Findings")} ${r.findings.length}${r.omittedFindings ? "+" : ""}`,
		].join(this.theme.fg("borderMuted", "  │  "));
		return wrapTextWithAnsi(text, width);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (!this.expanded) return this.compactSummary(width);
		const title = `TACTICIAN · ${this.data.scope === "task" ? "CURRENT TASK" : "SESSION"}`;
		const lines = [this.border(this.theme.bold(title), width)];
		for (const section of reportSections(this.data)) {
			lines.push(this.section(section.title, width), ...this.table(section.rows.length ? section.rows : [{ label: "Tool calls", value: "None" }], width));
		}
		lines.push(this.section("FINDINGS", width));
		for (const line of findingLines(this.data)) lines.push(...this.paragraph(line, width));
		lines.push(this.section("INTERPRETATION", width));
		for (const note of reportNotes(this.data)) lines.push(...this.paragraph(this.theme.fg("muted", note), width));
		lines.push(this.border("", width, true));
		return lines.map(line => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

export function createReportComponent(data: StoredTacticianReport, expanded: boolean, theme: Theme): Component {
	const box = new Box(1, 0, text => theme.bg("customMessageBg", text));
	box.addChild(new TacticianReportBody(normalizeStoredReport(data), expanded, theme));
	// Box padding alone can exceed tiny terminal widths.
	return {
		render: width => width <= 0 ? [] : box.render(width).map(line => truncateToWidth(line, width, "")),
		invalidate: () => box.invalidate(),
	};
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { findingLines, normalizeStoredReport, reportNotes, reportSections, type MetricRow, type StoredWiseBatchReport } from "./report.ts";

function padRight(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

class WiseBatchReportBody implements Component {
	constructor(
		private readonly data: StoredWiseBatchReport,
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
			`${this.theme.fg("muted", "Tool calls / batches")} ${r.toolCalls} / ${r.toolBatches} = ${this.theme.fg("accent", `${r.callsPerBatch.toFixed(2)} calls/request`)}`,
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

export function createReportComponent(data: StoredWiseBatchReport, expanded: boolean, theme: Theme): Component {
	const box = new Box(1, 0, text => theme.bg("customMessageBg", text));
	box.addChild(new WiseBatchReportBody(normalizeStoredReport(data), expanded, theme));
	// Box padding alone can exceed tiny terminal widths.
	return {
		render: width => width <= 0 ? [] : box.render(width).map(line => truncateToWidth(line, width, "")),
		invalidate: () => box.invalidate(),
	};
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { StoredWiseBatchReport } from "./report.ts";

interface MetricRow {
	label: string;
	value: string;
	tone?: "text" | "accent" | "success" | "warning" | "error" | "muted";
}

function padRight(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function rateTone(rate: number): MetricRow["tone"] {
	if (rate <= 0.4) return "success";
	if (rate <= 0.7) return "warning";
	return "error";
}

function dollars(value: number): string {
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
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
		const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix)));
		return this.theme.fg("borderMuted", truncateToWidth(prefix + fill, width, ""));
	}

	private table(rows: MetricRow[], width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		if (contentWidth < 30) {
			return rows.flatMap((row) => [
				this.theme.fg("muted", truncateToWidth(`│  ${row.label}`, width)),
				this.theme.fg(row.tone ?? "text", truncateToWidth(`│    ${row.value}`, width)),
			]);
		}

		const desiredLabelWidth = Math.max(12, ...rows.map((row) => visibleWidth(row.label)));
		const labelWidth = Math.min(desiredLabelWidth, Math.floor(contentWidth * 0.62));
		const valueWidth = Math.max(1, contentWidth - labelWidth - 2);
		return rows.map((row) => {
			const label = padRight(truncateToWidth(row.label, labelWidth), labelWidth);
			const value = truncateToWidth(row.value, valueWidth);
			return truncateToWidth(
				`${this.theme.fg("borderMuted", "│")}  ${this.theme.fg("muted", label)}  ${this.theme.fg(row.tone ?? "text", value)}`,
				width,
				"",
			);
		});
	}

	private compactSummary(width: number): string[] {
		const report = this.data.report;
		const scope = this.data.scope === "task" ? "Task" : "Session";
		const barriers = [
			["edit", report.consecutiveSingletonEdits],
			["bash", report.consecutiveSingletonBash],
			["read", report.consecutiveSingletonReadOnlyBatches],
		]
			.filter(([, count]) => Number(count) > 0)
			.map(([name, count]) => `${name} ${count}`)
			.join(" · ");
		const singleton = `${report.singletonBatches}/${report.toolBatches} (${(report.singletonRate * 100).toFixed(0)}%)`;
		const text = [
			this.theme.fg("accent", this.theme.bold(`⚡ Wise Batcher · ${scope}`)),
			`${this.theme.fg("muted", "Tool calls / batches")} ${this.theme.fg("text", `${report.toolCalls} / ${report.toolBatches}`)} ${this.theme.fg("muted", "=")} ${this.theme.fg("accent", `${report.callsPerBatch.toFixed(2)} calls/request`)}`,
			`${this.theme.fg("muted", "Singleton")} ${this.theme.fg(rateTone(report.singletonRate) ?? "text", singleton)}`,
			`${this.theme.fg("muted", "Barriers")} ${barriers ? this.theme.fg("warning", barriers) : this.theme.fg("success", "none")}`,
			`${this.theme.fg("muted", "Est. saved vs singletons")} ${this.theme.fg("success", dollars(report.estimatedSingletonToolCallSavings ?? 0))}`,
		].join(this.theme.fg("borderMuted", "  │  "));
		return wrapTextWithAnsi(text, width);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (!this.expanded) return this.compactSummary(width);

		const report = this.data.report;
		const title = `WISE BATCHER · ${this.data.scope === "task" ? "CURRENT TASK" : "SESSION"}`;
		const lines: string[] = [this.border(this.theme.bold(title), width)];

		lines.push(this.section("EFFICIENCY", width));
		lines.push(
			...this.table(
				[
					{ label: "Assistant requests", value: report.assistantRequests.toLocaleString() },
					{ label: "Tool rounds", value: report.toolBatches.toLocaleString() },
					{ label: "Tool calls", value: report.toolCalls.toLocaleString() },
					{ label: "Calls / round", value: report.callsPerBatch.toFixed(2), tone: "accent" },
					{
						label: "Singleton rounds",
						value: `${report.singletonBatches}/${report.toolBatches} (${(report.singletonRate * 100).toFixed(1)}%)`,
						tone: rateTone(report.singletonRate),
					},
					{ label: "Largest batch", value: report.maxBatchSize.toLocaleString() },
				],
				width,
			),
		);

		const opportunities: MetricRow[] = [];
		if (report.consecutiveSingletonEdits > 0) {
			opportunities.push({
				label: "Sequential edit barriers",
				value: `${report.consecutiveSingletonEdits} · ${report.consecutiveDifferentFileEdits} cross-file · ${report.consecutiveSameFileEdits} same-file`,
				tone: "warning",
			});
		}
		if (report.consecutiveSingletonBash > 0) {
			opportunities.push({ label: "Sequential bash barriers", value: String(report.consecutiveSingletonBash), tone: "warning" });
		}
		if (report.consecutiveReadOnlyBatches > 0) {
			opportunities.push({
				label: "Read-only round chains",
				value: `${report.consecutiveReadOnlyBatches} · ${report.consecutiveSingletonReadOnlyBatches} singleton→singleton`,
				tone: "warning",
			});
		}
		if (report.repeatedExactCalls > 0 || report.repeatedReads > 0) {
			opportunities.push({
				label: "Repeated work",
				value: `${report.repeatedExactCalls} exact calls · ${report.repeatedReads} read paths`,
				tone: "warning",
			});
		}
		if (report.samePathSiblingMutations > 0) {
			opportunities.push({
				label: "Conflicting sibling writes",
				value: String(report.samePathSiblingMutations),
				tone: "error",
			});
		}
		if (opportunities.length === 0) {
			opportunities.push({ label: "Detected barriers", value: "None", tone: "success" });
		}
		lines.push(this.section("OPPORTUNITIES", width), ...this.table(opportunities, width));

		const tools = Object.entries(report.toolCounts)
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			.map(([name, count]) => ({ label: name, value: count.toLocaleString() }));
		lines.push(this.section("TOOLS", width), ...this.table(tools.length > 0 ? tools : [{ label: "Tool calls", value: "None" }], width));

		lines.push(this.section("DIAGNOSTICS", width));
		lines.push(
			...this.table(
				[
					{ label: "Edit calls / blocks", value: `${report.editCalls} / ${report.editBlocks}` },
					{
						label: "Errors / truncations",
						value: `${report.toolErrors} / ${report.truncatedResults}`,
						tone: report.toolErrors + report.truncatedResults > 0 ? "warning" : "success",
					},
					{ label: "Tool-result volume", value: `${(report.toolResultCharacters / 1024).toFixed(1)} KiB` },
					{ label: "Maximum context", value: `${report.maxContextTokens.toLocaleString()} tokens` },
					{ label: "Recorded request cost", value: dollars(report.totalCost), tone: "accent" },
					{
						label: "Est. saved vs singleton calls",
						value: dollars(report.estimatedSingletonToolCallSavings ?? 0),
						tone: "success",
					},
					{
						label: "Edit-barrier cost ceiling",
						value: dollars(report.avoidableEditRequestCostUpperBound),
						tone: report.avoidableEditRequestCostUpperBound > 0 ? "warning" : "muted",
					},
				],
				width,
			),
		);

		lines.push(this.border("", width, true));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {}
}

export function createReportComponent(data: StoredWiseBatchReport, expanded: boolean, theme: Theme): Component {
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new WiseBatchReportBody(data, expanded, theme));
	return box;
}

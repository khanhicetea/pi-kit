import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildProjectReport, formatProjectReport } from "./report.ts";
import { buildReviewPacket, findReviewerModel, loadReviewerPrompt, reviewMarkdown, runReviewer } from "./review.ts";
import { getProjectStorePaths, loadProjectIndex, refreshProjectIndex, saveReview, saveReviewEvidence } from "./store.ts";
import type { ProjectReport, RefreshStats } from "./types.ts";

export { parseSessionFile, emptyTaskStats } from "./history.ts";
export { buildProjectReport, formatProjectReport } from "./report.ts";
export { buildReviewPacket, findReviewerModel, loadReviewerPrompt, MAX_REVIEW_PACKET_BYTES, reviewMarkdown, runReviewer } from "./review.ts";
export { emptyProjectIndex, getProjectStorePaths, loadProjectIndex, normalizeProjectIndex, refreshProjectIndex, saveProjectIndex, saveReview, saveReviewEvidence } from "./store.ts";
export type * from "./types.ts";

export const INDEX_ENTRY_TYPE = "pi-sevo-index";
export const REVIEW_ENTRY_TYPE = "pi-sevo-review";

interface StoredIndexEntry {
	schemaVersion: 1;
	text: string;
	storePath: string;
	refresh: RefreshStats;
}

interface StoredReviewEntry {
	schemaVersion: 1;
	model: string;
	path: string;
	preview: string;
}

function safeText(value: unknown, max = 4_000): string {
	const text = typeof value === "string" ? value : "";
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, (character) => character === "\n" ? "\n" : " ").slice(0, max);
}

async function refresh(ctx: ExtensionCommandContext): Promise<{ report: ProjectReport; stats: RefreshStats; storePath: string; reviewsPath: string }> {
	const paths = getProjectStorePaths(ctx.cwd);
	const result = await refreshProjectIndex({ cwd: ctx.cwd, sessionDir: ctx.sessionManager.getSessionDir(), indexPath: paths.index });
	return { report: buildProjectReport(result.index), stats: result.stats, storePath: paths.index, reviewsPath: paths.reviews };
}

function refreshSuffix(stats: Partial<RefreshStats> | undefined): string {
	const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
	return `${count(stats?.parsed)} parsed, ${count(stats?.reused)} reused, ${count(stats?.skipped)} skipped, ${count(stats?.limitedSessions)} limited, ${count(stats?.retainedStale)} stale, ${Array.isArray(stats?.failed) ? stats.failed.length : 0} failed${stats?.cacheReset === true ? ", cache rebuilt" : ""}`;
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
	ctx.ui.notify(`Pi Sevo: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export default function sevoExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<StoredIndexEntry>(INDEX_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const summary = safeText(data?.text || "Pi Sevo index updated");
		const text = expanded && data ? `${summary}\n${theme.fg("muted", `Store: ${safeText(data.storePath, 1_000)}\nRefresh: ${refreshSuffix(data.refresh)}`)}` : summary.split("\n")[0];
		return new Text(theme.fg("accent", text), 1, 0);
	});
	pi.registerEntryRenderer<StoredReviewEntry>(REVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const title = `Pi Sevo review · ${safeText(data?.model || "reviewer", 200)}`;
		const details = data ? `\n${safeText(data.preview, expanded ? 3_000 : 500)}\n${theme.fg("muted", `Saved: ${safeText(data.path, 1_000)}`)}` : "";
		return new Text(theme.fg("accent", title) + details, 1, 0);
	});

	pi.registerCommand("sevo-index", {
		description: "Incrementally enrich this project's Pi session history without a model call",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("pi-sevo", "Indexing session history...");
			try {
				const result = await refresh(ctx);
				const text = formatProjectReport(result.report);
				pi.appendEntry(INDEX_ENTRY_TYPE, { schemaVersion: 1, text, storePath: result.storePath, refresh: result.stats } satisfies StoredIndexEntry);
				ctx.ui.notify(`Pi Sevo indexed ${result.report.totals.tasks} tasks (${refreshSuffix(result.stats)})`, result.stats.failed.length ? "warning" : "info");
			} catch (error) { notifyError(ctx, error); }
			finally { ctx.ui.setStatus("pi-sevo", undefined); }
		},
	});

	pi.registerCommand("sevo-status", {
		description: "Show the latest Pi Sevo aggregate without scanning session files",
		handler: async (_args, ctx) => {
			try {
				const paths = getProjectStorePaths(ctx.cwd);
				const report = buildProjectReport(await loadProjectIndex(paths.index, ctx.cwd));
				const text = formatProjectReport(report);
				const refreshStats: RefreshStats = {
					discovered: report.totals.sessions, parsed: 0, reused: report.totals.sessions, skipped: 0,
					limitedSessions: 0, retainedStale: 0, cacheReset: false, failed: [],
				};
				pi.appendEntry(INDEX_ENTRY_TYPE, { schemaVersion: 1, text, storePath: paths.index, refresh: refreshStats } satisfies StoredIndexEntry);
				if (!report.totals.sessions) ctx.ui.notify("Pi Sevo has no stored sessions. Run /sevo-index.", "warning");
			} catch (error) { notifyError(ctx, error); }
		},
	});

	pi.registerCommand("sevo-review", {
		description: "Review a bounded enriched-history packet with the current or requested provider/model",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (/\s/.test(requested)) {
				ctx.ui.notify("Usage: /sevo-review [provider/model]", "warning");
				return;
			}
			ctx.ui.setStatus("pi-sevo", "Preparing evidence review...");
			try {
				const paths = getProjectStorePaths(ctx.cwd);
				const index = await loadProjectIndex(paths.index, ctx.cwd);
				const report = buildProjectReport(index);
				if (!report.totals.sessions) throw new Error("Pi Sevo has no stored sessions. Run /sevo-index first.");
				if (report.coverage.incomplete) {
					throw new Error("History evidence is incomplete or stale. Inspect /sevo-index diagnostics and repair the source/cache before review.");
				}
				const current = ctx.model as Model<Api> | undefined;
				const model = findReviewerModel(ctx.modelRegistry, requested, current);
				if (!model) throw new Error(requested ? `Reviewer model not found: ${requested}` : "No current reviewer model");
				const packet = buildReviewPacket(index);
				const evidencePath = await saveReviewEvidence(paths.reviews, packet);
				ctx.ui.notify(`Pi Sevo evidence saved: ${evidencePath}`, "info");
				ctx.ui.setStatus("pi-sevo", `Reviewing with ${model.provider}/${model.id}...`);
				const result = await runReviewer({ registry: ctx.modelRegistry, model, systemPrompt: await loadReviewerPrompt(), packet, signal: ctx.signal });
				const markdown = reviewMarkdown(result, report, evidencePath);
				const path = await saveReview(paths.reviews, markdown);
				pi.appendEntry(REVIEW_ENTRY_TYPE, {
					schemaVersion: 1, model: result.model, path, preview: result.text.slice(0, 3_000),
				} satisfies StoredReviewEntry);
				ctx.ui.notify(`Pi Sevo review saved: ${path}`, "info");
			} catch (error) { notifyError(ctx, error); }
			finally { ctx.ui.setStatus("pi-sevo", undefined); }
		},
	});
}

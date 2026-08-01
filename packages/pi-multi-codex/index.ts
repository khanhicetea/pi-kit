import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER_PREFIX,
  codexUsageRows,
  fetchCodexUsage,
  formatCodexUsage,
  formatPercent,
  isCodexProvider,
  type CodexUsageReport,
} from "./usage.js";

const PROVIDER_PREFIX = CODEX_PROVIDER_PREFIX;
const DEFAULT_SLOTS = 3;
const AUTO_USAGE_INTERVAL_MS = 5 * 60 * 1000;
const SHARED_USAGE_STATE_KEY = "__piMultiCodexUsageStateV3";
const USAGE_WIDGET_ID = "multi-codex-usage";

interface SharedUsageState {
  lastCheckAt: Map<string, number>;
  pending: Map<string, Promise<CodexUsageReport>>;
  reports: Map<string, CodexUsageReport>;
}

function sharedUsageState(): SharedUsageState {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const existing = globalRecord[SHARED_USAGE_STATE_KEY] as SharedUsageState | undefined;
  if (existing) return existing;

  const state: SharedUsageState = {
    lastCheckAt: new Map(),
    pending: new Map(),
    reports: new Map(),
  };
  globalRecord[SHARED_USAGE_STATE_KEY] = state;
  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= width) return text;
  if (width === 1) return "…";
  return `${characters.slice(0, width - 1).join("")}…`;
}

function usageColor(leftPercent: number | null, limited: boolean): "success" | "warning" | "error" {
  if (limited || leftPercent === null || leftPercent <= 20) return "error";
  if (leftPercent <= 50) return "warning";
  return "success";
}

function hasLowUsage(report: CodexUsageReport): boolean {
  return codexUsageRows(report).some((row) => row.leftPercent !== null && row.leftPercent < 20);
}

function clearUsage(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(USAGE_WIDGET_ID, undefined);
}

function renderUsage(ctx: ExtensionContext, report: CodexUsageReport): void {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(formatCodexUsage(report), "info");
    return;
  }

  const provider = report.providerName.replace(/^OpenAI\s+/i, "");
  const rows = codexUsageRows(report).map((row) => ({
    ...row,
    percent: row.leftPercent === null ? "--%" : `${formatPercent(row.leftPercent)}%`,
  }));
  const separator = " - ";

  ctx.ui.setWidget(USAGE_WIDGET_ID, (_tui, theme) => ({
    render(width: number): string[] {
      if (width <= 0) return [];

      const fixedWidth = provider.length
        + separator.length * rows.length
        + rows.reduce((total, row) => total + row.label.length + row.percent.length + 2, 0);
      const barWidth = Math.min(10, Math.floor((width - fixedWidth) / rows.length));

      if (barWidth >= 3) {
        const windows = rows.map((row) => {
          const color = usageColor(row.leftPercent, report.limited);
          const filled = row.leftPercent === null ? 0 : Math.round(barWidth * row.leftPercent / 100);
          const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
          return `${theme.fg("muted", row.label)} ${bar} ${theme.fg(color, theme.bold(row.percent))}`;
        });
        const content = [theme.fg("accent", theme.bold(provider)), ...windows].join(separator);
        const contentWidth = fixedWidth + barWidth * rows.length;
        return [`${" ".repeat(Math.max(0, width - contentWidth))}${content}`];
      }

      const compactWindowsWidth = separator.length * rows.length
        + rows.reduce((total, row) => total + row.label.length + row.percent.length + 1, 0);
      const providerWidth = width - compactWindowsWidth;
      if (providerWidth > 0) {
        const windows = rows.map((row) => {
          const color = usageColor(row.leftPercent, report.limited);
          return `${theme.fg("muted", row.label)} ${theme.fg(color, theme.bold(row.percent))}`;
        });
        const compactProvider = truncatePlain(provider, providerWidth);
        const content = [theme.fg("accent", theme.bold(compactProvider)), ...windows].join(separator);
        const contentWidth = Array.from(compactProvider).length + compactWindowsWidth;
        return [`${" ".repeat(Math.max(0, width - contentWidth))}${content}`];
      }

      const fallback = truncatePlain(
        [provider, ...rows.map((row) => `${row.label} ${row.percent}`)].join(separator),
        width,
      );
      return [`${" ".repeat(Math.max(0, width - Array.from(fallback).length))}${theme.fg("accent", fallback)}`];
    },
    invalidate() {},
  }), { placement: "belowEditor" });
}

function updateUsageDisplay(ctx: ExtensionContext, report: CodexUsageReport, manual: boolean): void {
  if (manual || hasLowUsage(report)) renderUsage(ctx, report);
  else clearUsage(ctx);
}

function currentUsageKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  return model && isCodexProvider(model.provider) ? `${model.provider}\0${model.id}` : undefined;
}

function isCurrentUsageKey(ctx: ExtensionContext, usageKey: string): boolean {
  try {
    return currentUsageKey(ctx) === usageKey;
  } catch {
    return false;
  }
}

function safeNotify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // The async check may finish after its session has been replaced.
  }
}

async function showCurrentUsage(ctx: ExtensionContext, manual: boolean): Promise<void> {
  const usageKey = currentUsageKey(ctx);
  if (!usageKey) {
    clearUsage(ctx);
    if (manual) safeNotify(ctx, "Select an OpenAI Codex model first", "warning");
    return;
  }
  if (!manual && !ctx.hasUI) return;

  const state = sharedUsageState();
  const cached = state.reports.get(usageKey);
  if (!manual && ctx.mode === "tui") {
    if (cached) updateUsageDisplay(ctx, cached, false);
    else clearUsage(ctx);
  }

  const now = Date.now();
  const lastCheck = state.lastCheckAt.get(usageKey) ?? 0;
  if (!manual && now - lastCheck < AUTO_USAGE_INTERVAL_MS) return;

  let request = state.pending.get(usageKey);
  if (!request) {
    state.lastCheckAt.set(usageKey, now);
    request = fetchCodexUsage(ctx, ctx.signal);
    state.pending.set(usageKey, request);
    void request.finally(() => {
      if (state.pending.get(usageKey) === request) state.pending.delete(usageKey);
    }).catch(() => undefined);
  }

  try {
    const report = await request;
    state.reports.set(usageKey, report);
    if (isCurrentUsageKey(ctx, usageKey)) updateUsageDisplay(ctx, report, manual);
  } catch (error) {
    if (manual && isCurrentUsageKey(ctx, usageKey)) {
      safeNotify(ctx, `Codex usage check failed: ${errorMessage(error)}`, "error");
    }
  }
}

function checkUsageInBackground(ctx: ExtensionContext): void {
  void showCurrentUsage(ctx, false).catch(() => undefined);
}

function slotCount(): number {
  const value = process.env.PI_CODEX_NUM_PROVIDER?.trim() || String(DEFAULT_SLOTS);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error("PI_CODEX_NUM_PROVIDER must be an integer between 1 and 100");
  }
  return Number(value);
}

function createSlotProvider(
  source: Provider<"openai-codex-responses">,
  slot: number,
): Provider<"openai-codex-responses"> {
  const id = `${PROVIDER_PREFIX}${slot}`;

  return {
    ...source,
    id,
    name: `OpenAI Codex ${slot}`,
    getModels: () => source.getModels().map((model) => ({
      ...model,
      provider: id,
      name: `[Codex ${slot}] ${model.name}`,
    })),
  };
}

export default function multiCodex(pi: ExtensionAPI) {
  const source = builtinProviders().find(
    (provider): provider is Provider<"openai-codex-responses"> => provider.id === "openai-codex",
  );
  if (!source) throw new Error("The installed pi-ai version does not provide OpenAI Codex");

  for (let slot = 1; slot <= slotCount(); slot++) {
    pi.registerProvider(createSlotProvider(source, slot));
  }

  pi.registerCommand("codex-usage", {
    description: "Check usage for the currently selected Codex account",
    handler: async (_args, ctx) => {
      await showCurrentUsage(ctx, true);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearUsage(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    checkUsageInBackground(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    clearUsage(ctx);
  });
}

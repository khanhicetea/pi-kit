import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  Model,
  ModelsStoreEntry,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
const MODEL_CATALOG_BASE_URL = "https://pi.dev";
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_SLOTS = 3;

interface CatalogStoreEntry extends ModelsStoreEntry {
  etag?: string;
}

interface CatalogPublication {
  persist?: CatalogStoreEntry | null;
  update?: () => void;
}

interface LegacyCatalogStore {
  read(): Promise<ModelsStoreEntry | undefined>;
  write(entry: ModelsStoreEntry): Promise<void>;
  delete(): Promise<void>;
}

interface RefreshModelsContextCompat {
  stored?: Readonly<CatalogStoreEntry>;
  store?: LegacyCatalogStore;
  publish?: (publication: CatalogPublication) => Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

interface BuiltinCatalogHelpers {
  getBuiltinModelDataGeneratedAt?: () => number | undefined;
  getBuiltinModelDataUrl?: (provider: string) => URL;
}

const builtinCatalogHelpers = builtinProviderCatalog as unknown as BuiltinCatalogHelpers;
const AUTO_USAGE_INTERVAL_MS = 5 * 60 * 1000;
const SHARED_USAGE_STATE_KEY = "__piMultiCodexUsageStateV3";
const USAGE_WIDGET_ID = "multi-codex-usage";
const FAST_STATUS_ID = "multi-codex-fast";
const FAST_SETTINGS_KEY = "pi-codex-fast";
const PRIORITY_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const settings: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(settings) ? settings : {};
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

function mergeSettings(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, override] of Object.entries(overrides)) {
    merged[key] = isRecord(merged[key]) && isRecord(override)
      ? mergeSettings(merged[key], override)
      : override;
  }
  return merged;
}

interface FastModeSettings {
  enabled: boolean;
  fastModels: Set<string>;
}

async function loadFastModeSettings(cwd: string): Promise<FastModeSettings> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
  const settings = mergeSettings(
    await readSettings(join(agentDir, "settings.json")),
    await readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json")),
  );
  const extensionSettings = settings[FAST_SETTINGS_KEY];
  if (!isRecord(extensionSettings)) return { enabled: false, fastModels: new Set() };

  const fastModels = Array.isArray(extensionSettings.fast_models)
    ? extensionSettings.fast_models
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim())
    : [];
  return {
    enabled: extensionSettings.enabled === true,
    fastModels: new Set(fastModels),
  };
}

function modelUsesAutomaticFastMode(ctx: ExtensionContext, fastModels: Set<string>): boolean {
  const model = ctx.model;
  return Boolean(
    model
      && (fastModels.has(model.id) || fastModels.has(`${model.provider}/${model.id}`)),
  );
}

function supportsFastMode(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return Boolean(
    model
      && isCodexProvider(model.provider)
      && PRIORITY_MODEL_IDS.has(model.id),
  );
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
        + rows.reduce(
          (total, row) => total + row.label.length + row.percent.length + 2
            + (row.resetText ? row.resetText.length + 1 : 0),
          0,
        );
      const barWidth = Math.min(10, Math.floor((width - fixedWidth) / rows.length));

      if (barWidth >= 3) {
        const windows = rows.map((row) => {
          const color = usageColor(row.leftPercent, report.limited);
          const filled = row.leftPercent === null ? 0 : Math.round(barWidth * row.leftPercent / 100);
          const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
          const reset = row.resetText ? ` ${theme.fg("dim", row.resetText)}` : "";
          return `${theme.fg("muted", row.label)} ${bar} ${theme.fg(color, theme.bold(row.percent))}${reset}`;
        });
        const content = [theme.fg("accent", theme.bold(provider)), ...windows].join(separator);
        const contentWidth = fixedWidth + barWidth * rows.length;
        return [`${" ".repeat(Math.max(0, width - contentWidth))}${content}`];
      }

      const compactWindowsWidth = separator.length * rows.length
        + rows.reduce(
          (total, row) => total + row.label.length + row.percent.length + 1
            + (row.resetText ? row.resetText.length + 1 : 0),
          0,
        );
      const providerWidth = width - compactWindowsWidth;
      if (providerWidth > 0) {
        const windows = rows.map((row) => {
          const color = usageColor(row.leftPercent, report.limited);
          const reset = row.resetText ? ` ${theme.fg("dim", row.resetText)}` : "";
          return `${theme.fg("muted", row.label)} ${theme.fg(color, theme.bold(row.percent))}${reset}`;
        });
        const compactProvider = truncatePlain(provider, providerWidth);
        const content = [theme.fg("accent", theme.bold(compactProvider)), ...windows].join(separator);
        const contentWidth = Array.from(compactProvider).length + compactWindowsWidth;
        return [`${" ".repeat(Math.max(0, width - contentWidth))}${content}`];
      }

      const fallback = truncatePlain(
        [provider, ...rows.map((row) => `${row.label} ${row.percent}${row.resetText ? ` ${row.resetText}` : ""}`)].join(separator),
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

type CodexModel = Model<"openai-codex-responses">;

async function localCatalogLastModified(providerId: string): Promise<number | undefined> {
  const generatedAt = builtinCatalogHelpers.getBuiltinModelDataGeneratedAt?.();
  if (generatedAt !== undefined) return generatedAt;

  const catalogUrl = builtinCatalogHelpers.getBuiltinModelDataUrl?.(providerId);
  if (!catalogUrl) return undefined;
  return stat(catalogUrl).then((value) => value.mtimeMs, () => undefined);
}

function mergeCatalogModels(
  baseline: readonly CodexModel[],
  dynamic: readonly CodexModel[],
): CodexModel[] {
  const merged = [...baseline];
  for (const model of dynamic) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  return merged;
}

function slotModel(model: Model<Api>, providerId: string, slot: number): CodexModel {
  const prefix = `[Codex ${slot}] `;
  const name = typeof model.name === "string" ? model.name : model.id;
  return {
    ...model,
    provider: providerId,
    name: name.startsWith(prefix) ? name : `${prefix}${name}`,
  } as CodexModel;
}

function catalogEntries(value: unknown): Record<string, unknown>[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : isRecord(value)
        ? Object.values(value)
        : undefined;
  if (!entries) throw new Error("Invalid OpenAI Codex model catalog");
  return entries.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && "id" in entry,
  );
}

function parseSlotCatalog(
  value: unknown,
  providerId: string,
  slot: number,
): CodexModel[] {
  return catalogEntries(value).map((entry) => (
    slotModel(entry as unknown as Model<Api>, providerId, slot)
  ));
}

function restoreSlotCatalog(
  stored: ModelsStoreEntry | undefined,
  sourceId: string,
  providerId: string,
  slot: number,
  localGeneratedAt: number | undefined,
): CodexModel[] {
  if (!stored) return [];
  if (
    localGeneratedAt !== undefined
    && (stored.lastModified === undefined || stored.lastModified <= localGeneratedAt)
  ) {
    return [];
  }

  return stored.models
    .filter((model) => model.provider === providerId || model.provider === sourceId)
    .map((model) => slotModel(model, providerId, slot));
}

async function readCatalogStore(
  context: RefreshModelsContextCompat,
): Promise<CatalogStoreEntry | undefined> {
  if (typeof context.publish === "function") {
    return context.stored as CatalogStoreEntry | undefined;
  }
  if (!context.store) throw new Error("Model catalog refresh context has no storage");
  return await context.store.read() as CatalogStoreEntry | undefined;
}

async function publishCatalog(
  context: RefreshModelsContextCompat,
  publication: CatalogPublication,
): Promise<boolean> {
  if (typeof context.publish === "function") return context.publish(publication);
  if (!context.store) throw new Error("Model catalog refresh context has no storage");
  publication.update?.();
  if (publication.persist !== undefined) {
    if (publication.persist === null) await context.store.delete();
    else await context.store.write(publication.persist);
  }
  return true;
}

/**
 * coding-agent wraps its own built-in provider with the pi.dev catalog, but
 * extensions receive the raw pi-ai provider. Keep the same catalog overlay on
 * every numbered provider and rewrite its models to the slot's provider ID.
 */
function createSlotProvider(
  source: Provider<"openai-codex-responses">,
  slot: number,
): Provider<"openai-codex-responses"> {
  const id = `${PROVIDER_PREFIX}${slot}`;
  let dynamicModels: CodexModel[] = [];
  let inflightRefresh: Promise<void> | undefined;

  const refreshCatalog = async (context: RefreshModelsContextCompat): Promise<void> => {
    const localLastModified = await localCatalogLastModified(source.id);
    const stored = await readCatalogStore(context);
    const restored = restoreSlotCatalog(stored, source.id, id, slot, localLastModified);
    if (!(await publishCatalog(context, { update: () => { dynamicModels = restored; } }))) return;
    if (!context.allowNetwork || context.signal?.aborted) return;
    if (
      !context.force
      && stored?.checkedAt !== undefined
      && stored.lastModified !== undefined
      && Date.now() - stored.checkedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    const validator = stored?.models.length ? stored.etag : undefined;
    const url = new URL(
      `/api/models/providers/${encodeURIComponent(source.id)}`,
      MODEL_CATALOG_BASE_URL,
    );
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(validator ? { "if-none-match": validator } : {}),
      },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (context.signal?.aborted) return;

    const checkedAt = Date.now();
    if (response.status === 304 && stored) {
      await publishCatalog(context, { persist: { ...stored, checkedAt } });
      return;
    }
    if (response.status === 404 || response.status === 501) {
      const { etag: _etag, ...withoutEtag } = stored ?? { models: [] };
      await publishCatalog(context, {
        persist: {
          ...withoutEtag,
          checkedAt,
          lastModified: 0,
        },
      });
      return;
    }
    if (!response.ok) {
      await publishCatalog(context, {
        persist: { ...(stored ?? { models: [] }), checkedAt },
      });
      throw new Error(`Model catalog request failed for ${id}: ${response.status}`);
    }

    const refreshed = parseSlotCatalog(await response.json(), id, slot);
    const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
    if (context.signal?.aborted) return;
    const etag = response.headers.get("etag");
    const entry: CatalogStoreEntry = {
      models: refreshed,
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      ...(etag !== null ? { etag } : {}),
    };
    const published = restoreSlotCatalog(
      entry,
      source.id,
      id,
      slot,
      localLastModified,
    );
    await publishCatalog(context, {
      persist: entry,
      update: () => { dynamicModels = published; },
    });
  };

  return {
    ...source,
    id,
    name: `OpenAI Codex ${slot}`,
    getModels: () => mergeCatalogModels(
      source.getModels().map((model) => slotModel(model, id, slot)),
      dynamicModels,
    ),
    refreshModels: (context: RefreshModelsContext) => {
      const compatible = context as unknown as RefreshModelsContextCompat;
      if (typeof compatible.publish === "function") return refreshCatalog(compatible);

      inflightRefresh ??= (async () => {
        try {
          await refreshCatalog(compatible);
        } finally {
          inflightRefresh = undefined;
        }
      })();
      return inflightRefresh;
    },
  };
}

export default function multiCodex(pi: ExtensionAPI) {
  let fastModeEnabled = false;
  let fastModeSettings: FastModeSettings = { enabled: false, fastModels: new Set() };

  function updateFastStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!fastModeEnabled) {
      ctx.ui.setStatus(FAST_STATUS_ID, undefined);
      return;
    }

    const label = supportsFastMode(ctx) ? "fast" : "fast (inactive)";
    ctx.ui.setStatus(FAST_STATUS_ID, ctx.ui.theme.fg("accent", label));
  }

  function notifyFastMode(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!fastModeEnabled) {
      ctx.ui.notify("Fast mode disabled. Requests will use the default service tier.", "info");
      return;
    }

    const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
    const suffix = supportsFastMode(ctx) ? "" : " but inactive";
    ctx.ui.notify(`Fast mode enabled${suffix} (${modelLabel}).`, "info");
  }

  async function resetFastMode(ctx: ExtensionContext): Promise<void> {
    fastModeSettings = { enabled: false, fastModels: new Set() };
    try {
      fastModeSettings = await loadFastModeSettings(ctx.cwd);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-multi-codex: failed to load fast mode setting: ${errorMessage(error)}`, "warning");
      }
    }

    fastModeEnabled = fastModeSettings.fastModels.size > 0
      ? modelUsesAutomaticFastMode(ctx, fastModeSettings.fastModels)
      : fastModeSettings.enabled;
    if (pi.getFlag("fast") === true) fastModeEnabled = true;
    updateFastStatus(ctx);
  }

  const source = builtinProviderCatalog.builtinProviders().find(
    (provider): provider is Provider<"openai-codex-responses"> => provider.id === "openai-codex",
  );
  if (!source) throw new Error("The installed pi-ai version does not provide OpenAI Codex");

  for (let slot = 1; slot <= slotCount(); slot++) {
    pi.registerProvider(createSlotProvider(source, slot));
  }

  pi.registerFlag("fast", {
    description: "Start with Codex fast mode enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("codex-fast", {
    description: "Toggle Codex fast mode for this session",
    handler: async (_args, ctx) => {
      fastModeEnabled = !fastModeEnabled;
      updateFastStatus(ctx);
      notifyFastMode(ctx);
    },
  });

  pi.registerCommand("codex-usage", {
    description: "Check usage for the currently selected Codex account",
    handler: async (_args, ctx) => {
      await showCurrentUsage(ctx, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearUsage(ctx);
    await resetFastMode(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    checkUsageInBackground(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    clearUsage(ctx);
    if (fastModeSettings.fastModels.size > 0) {
      fastModeEnabled = modelUsesAutomaticFastMode(ctx, fastModeSettings.fastModels);
    }
    updateFastStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastModeEnabled || !supportsFastMode(ctx) || !isRecord(event.payload)) return;
    return {
      ...event.payload,
      service_tier: "priority",
    };
  });
}

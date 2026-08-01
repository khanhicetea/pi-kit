import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export const CODEX_PROVIDER_ID = "openai-codex";
export const CODEX_PROVIDER_PREFIX = `${CODEX_PROVIDER_ID}-`;

interface JsonObject {
  [key: string]: unknown;
}

export interface UsageWindow {
  usedPercent: number | null;
  limitSeconds: number | null;
  resetsAtMs: number | null;
}

export interface CodexUsageReport {
  providerId: string;
  providerName: string;
  accountLabel: string;
  plan: string | null;
  limitName: string | null;
  limited: boolean;
  windows: UsageWindow[];
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function decodeAccessToken(token: string): JsonObject | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    return asObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function accountIdentity(token: string): { accountId: string; label: string } {
  const claims = decodeAccessToken(token);
  const authClaims = asObject(claims?.[ACCOUNT_CLAIM]);
  const accountId = typeof authClaims?.chatgpt_account_id === "string"
    ? authClaims.chatgpt_account_id.trim()
    : "";
  if (!accountId) throw new Error("the current OAuth token has no ChatGPT account ID");

  const email = typeof claims?.email === "string" ? claims.email.trim() : "";
  return {
    accountId,
    label: email || `${accountId.slice(0, 8)}…`,
  };
}

function resetTimeMs(value: JsonObject, now: number): number | null {
  const afterSeconds = finiteNumber(value.reset_after_seconds);
  if (afterSeconds !== null) return now + Math.max(0, afterSeconds) * 1000;

  const rawResetAt = value.reset_at;
  const numericResetAt = finiteNumber(rawResetAt);
  if (numericResetAt !== null) {
    return numericResetAt > 100_000_000_000 ? numericResetAt : numericResetAt * 1000;
  }
  if (typeof rawResetAt === "string") {
    const parsed = Date.parse(rawResetAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseWindow(value: unknown, now: number): UsageWindow | null {
  const record = asObject(value);
  if (!record) return null;

  const rawUsed = finiteNumber(record.used_percent);
  const usedPercent = rawUsed === null ? null : Math.min(100, Math.max(0, rawUsed));
  const rawLimitSeconds = finiteNumber(record.limit_window_seconds);
  const limitSeconds = rawLimitSeconds === null ? null : Math.max(0, rawLimitSeconds);
  const resetsAtMs = resetTimeMs(record, now);

  if (usedPercent === null && limitSeconds === null && resetsAtMs === null) return null;
  return { usedPercent, limitSeconds, resetsAtMs };
}

function normalizeLimitName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function additionalLimitEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(asObject).filter((item): item is JsonObject => Boolean(item));
  const record = asObject(value);
  return record
    ? Object.values(record).map(asObject).filter((item): item is JsonObject => Boolean(item))
    : [];
}

function modelSpecificBucket(root: JsonObject, modelId: string): { bucket: JsonObject; name: string | null } | null {
  const normalizedModel = normalizeLimitName(modelId);
  const entries = additionalLimitEntries(root.additional_rate_limits);

  for (const entry of entries) {
    const names = [entry.limit_name, entry.model, entry.metered_feature]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "");
    const exactMatch = names.some((name) => normalizeLimitName(name) === normalizedModel);
    const sparkMatch = normalizedModel.includes("spark") && names.some((name) => normalizeLimitName(name).includes("spark"));
    if (!exactMatch && !sparkMatch) continue;

    const bucket = asObject(entry.rate_limit);
    if (bucket) {
      const name = typeof entry.limit_name === "string" ? entry.limit_name.trim() || null : null;
      return { bucket, name };
    }
  }
  return null;
}

function parseResponse(
  value: unknown,
  modelId: string,
  identity: { providerId: string; providerName: string; accountLabel: string },
  now: number,
): CodexUsageReport {
  const root = asObject(value);
  if (!root) throw new Error("the usage API returned an invalid payload");

  const selected = modelSpecificBucket(root, modelId);
  const bucket = selected?.bucket ?? asObject(root.rate_limit);
  if (!bucket) throw new Error("the usage API returned no rate-limit data");

  const windows = [bucket.primary_window, bucket.secondary_window]
    .map((window) => parseWindow(window, now))
    .filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0) throw new Error("the usage API returned no usage windows");

  return {
    ...identity,
    plan: typeof root.plan_type === "string" ? root.plan_type.trim() || null : null,
    limitName: selected?.name ?? null,
    limited: bucket.limit_reached === true || bucket.allowed === false,
    windows,
  };
}

export function isCodexProvider(providerId: string | undefined): providerId is string {
  return providerId === CODEX_PROVIDER_ID || providerId?.startsWith(CODEX_PROVIDER_PREFIX) === true;
}

export async function fetchCodexUsage(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<CodexUsageReport> {
  const model = ctx.model;
  if (!model || !isCodexProvider(model.provider)) {
    throw new Error("select an OpenAI Codex model first");
  }

  const resolved = await ctx.modelRegistry.getProviderAuth(model.provider);
  const accessToken = resolved?.auth.apiKey?.trim();
  if (!accessToken) throw new Error(`no OAuth login found for ${model.provider}`);

  const account = accountIdentity(accessToken);
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(USAGE_ENDPOINT, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": account.accountId,
      },
      signal: requestSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) throw new Error("the usage request timed out");
    throw error;
  }

  if (!response.ok) {
    throw new Error(`the usage API returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  return parseResponse(payload, model.id, {
    providerId: model.provider,
    providerName: ctx.modelRegistry.getProviderDisplayName(model.provider),
    accountLabel: account.label,
  }, Date.now());
}

export interface CodexUsageRow {
  label: string;
  leftPercent: number | null;
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatWindowDuration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return "limit";
}

export function codexUsageRows(report: CodexUsageReport): CodexUsageRow[] {
  return report.windows.map((window, index) => ({
    label: window.limitSeconds !== null && window.limitSeconds > 0
      ? formatWindowDuration(window.limitSeconds)
      : index === 0 ? "session" : "weekly",
    leftPercent: window.usedPercent === null ? null : Math.max(0, 100 - window.usedPercent),
  }));
}

function plainProgressBar(leftPercent: number | null, width: number): string {
  if (leftPercent === null) return "░".repeat(width);
  const filled = Math.round(width * leftPercent / 100);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatCodexUsage(report: CodexUsageReport, barWidth = 8): string {
  const provider = report.providerName.replace(/^OpenAI\s+/i, "");
  const windows = codexUsageRows(report).map((row) => {
    const percent = row.leftPercent === null ? "--%" : `${formatPercent(row.leftPercent)}%`;
    return `${row.label} ${plainProgressBar(row.leftPercent, barWidth)} ${percent}`;
  });
  return [provider, ...windows].join(" - ");
}

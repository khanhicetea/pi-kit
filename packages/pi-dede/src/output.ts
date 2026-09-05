import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { DetailedUsage, DedeChildResult, DedeToolDetails } from "./types.ts";
import { truncateUtf8 } from "./runner.ts";

export const CHILD_MODEL_MAX_BYTES = 4 * 1024;
export const CHILD_MODEL_MAX_LINES = 160;
export const MODEL_CONTENT_MAX_BYTES = 12 * 1024;
export const MODEL_CONTENT_MAX_LINES = 500;

export function deriveStatus(results: readonly DedeChildResult[]): DedeToolDetails["status"] {
  if (results.some((result) => result.status === "cancelled")) return "cancelled";
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  if (succeeded === results.length && results.length > 0) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial";
}

function boundedChild(result: DedeChildResult): string {
  const singleLine = (value: string, bytes: number) => truncateUtf8(value.replace(/[\r\n]+/g, " "), bytes).text;
  // Control metadata is never competing with the answer or unbounded diagnostics.
  const controls = [
    result.sessionId && `Session: \`${singleLine(result.sessionId, 128)}\` (inspect: pi --session ${singleLine(result.sessionId, 128)})`,
    result.continuationHandle && `Related continuation available: \`${singleLine(result.continuationHandle, 128)}\`. Use "continueFrom": "${singleLine(result.continuationHandle, 128)}" only when it directly benefits from this child's context; same capabilities, new facts only; revalidate mutable state.`,
    result.resumeHandle && `Short resume available: \`${singleLine(result.resumeHandle, 128)}\`. Use "resume": "${singleLine(result.resumeHandle, 128)}" solo, 30–180s, only if close to finishing.`,
    `Context: ${result.contextModeResolved ?? "isolated"}${result.contextFallbackReason ? `; ${singleLine(result.contextFallbackReason, 240)}` : ""}.`,
    result.errorMessage && `Error: ${singleLine(result.errorMessage, 320)}`,
    result.artifactPath && Buffer.byteLength(result.artifactPath) <= 768
      ? `Full answer: read ${result.artifactPath}`
      : result.sessionPath && Buffer.byteLength(result.sessionPath) <= 768
        ? `Full conversation: read JSONL ${result.sessionPath} (assistant message content; paginate as needed).`
        : "Full conversation: inspect the persistent Pi session above.",
  ].filter(Boolean).join("\n");
  const body = result.finalText || result.stderrTail || "(no output)";
  const budget = Math.max(0, CHILD_MODEL_MAX_BYTES - 512 - Buffer.byteLength(controls));
  const lines = body.split("\n").slice(0, CHILD_MODEL_MAX_LINES - 16).join("\n");
  const bounded = truncateUtf8(lines, budget);
  const truncated = bounded.truncated || lines !== body || Boolean(result.artifactPath);
  return `${controls}\n\n${result.status === "succeeded" ? "" : "Partial output:\n"}${bounded.text}${truncated ? "\n[Child output truncated; use the retrieval route above.]" : ""}`;
}

export function formatModelContent(details: DedeToolDetails): string {
  const succeeded = details.results.filter((result) => result.status === "succeeded").length;
  const sections = details.results.map((result) => `## ${result.id} — ${result.status}\n${boundedChild(result)}`);
  const raw = `# Delegation: ${succeeded}/${details.results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
  const truncation = truncateHead(raw, { maxBytes: MODEL_CONTENT_MAX_BYTES - 512, maxLines: MODEL_CONTENT_MAX_LINES - 3 });
  if (!truncation.truncated) return raw;
  return `${truncation.content}\n\n[Aggregate delegation output truncated to ${formatSize(MODEL_CONTENT_MAX_BYTES)}/${MODEL_CONTENT_MAX_LINES} lines. Bounded child texts remain in structured details.]`;
}

export function progressContent(details: DedeToolDetails): string {
  const done = details.results.filter((result) => !["queued", "running"].includes(result.status)).length;
  const running = details.results.filter((result) => result.status === "running").length;
  return `Đệ Đệ: ${done}/${details.results.length} done · ${running} running · ${Math.round(details.durationMs / 1000)}s elapsed`;
}

export function formatSettledSummary(results: readonly DedeChildResult[]): string | undefined {
  if (results.length === 0) return undefined;
  const byModel = new Map<string, { count: number; cost: number }>();
  for (const result of results) {
    const group = byModel.get(result.model) ?? { count: 0, cost: 0 };
    group.count++;
    group.cost += result.usage.cost;
    byModel.set(result.model, group);
  }

  const noun = results.length === 1 ? "subagent" : "subagents";
  const totalCost = results.reduce((sum, result) => sum + result.usage.cost, 0);
  const groups = [...byModel]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, usage]) => `${model}: ${usage.count} ${usage.count === 1 ? "subagent" : "subagents"} · $${usage.cost.toFixed(4)}`);
  return `Đệ Đệ: ${results.length} ${noun} · $${totalCost.toFixed(4)} total\n${groups.join("\n")}`;
}

export function cloneDetails(details: DedeToolDetails): DedeToolDetails {
  return {
    ...details,
    results: details.results.map((result) => ({
      ...result,
      tools: [...result.tools],
      forkedFrom: result.forkedFrom ? { ...result.forkedFrom } : undefined,
      diagnostics: result.diagnostics ? { ...result.diagnostics } : undefined,
      usage: { ...result.usage },
      activity: result.activity.map((activity) => ({ ...activity })),
    })),
  };
}

export function zeroUsage(): DetailedUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

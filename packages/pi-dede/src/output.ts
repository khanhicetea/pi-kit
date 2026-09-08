import type { DetailedUsage, DedeChildResult, DedeToolDetails } from "./types.ts";
import { truncateUtf8 } from "./runner.ts";
import { evidenceStatus } from "./handoff.ts";

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

function oneLine(value: string, bytes: number): string {
  return truncateUtf8(value.replace(/[\r\n]+/g, " "), bytes).text;
}

function usablePath(path: string | undefined): boolean {
  return Boolean(path && Buffer.byteLength(path) <= 768 && !/[\r\n]/.test(path));
}

function childMetadata(result: DedeChildResult): string {
  const lines = [
    `Evidence (child-reported): ${result.evidenceStatus ?? evidenceStatus(result.finalText)} · Context: ${result.contextModeResolved ?? "isolated"}`,
    `Model: ${oneLine(result.model, 160)} · turns: ${result.usage.turns} · time: ${Math.round(result.durationMs)}ms · cost: $${result.usage.cost.toFixed(4)}`,
    result.sessionId && `Session: \`${oneLine(result.sessionId, 128)}\` (pi --session ${oneLine(result.sessionId, 128)})`,
    result.continuationHandle && `Related continuation available: \`${oneLine(result.continuationHandle, 128)}\` ("continueFrom": "${oneLine(result.continuationHandle, 128)}") — only if it directly benefits from this child's context; revalidate mutable state.`,
    result.resumeHandle && `Short resume available: \`${oneLine(result.resumeHandle, 128)}\` ("resume": "${oneLine(result.resumeHandle, 128)}") — solo, 30–180s, only if almost done.`,
    usablePath(result.artifactPath) ? `Full answer: read ${result.artifactPath}`
      : usablePath(result.sessionPath) ? `Full conversation: read JSONL ${result.sessionPath} (assistant content; paginate).`
        : result.sessionId ? "Full conversation: inspect the persistent session above." : "No full-output retrieval route available.",
    result.contextFallbackReason && `Context fallback: ${oneLine(result.contextFallbackReason, 240)}`,
    result.errorMessage && `Error: ${oneLine(result.errorMessage, 320)}`,
    result.stopReason === "length" && "Stop: length; the answer may be incomplete.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function boundedChild(result: DedeChildResult, maxBytes: number, maxLines: number): string {
  const metadata = childMetadata(result);
  const body = result.finalText || result.stderrTail || "(no output)";
  const prefix = result.status === "succeeded" ? "" : "Partial output:\n";
  const bodyLines = body.split("\n");
  // Two join newlines plus one possible marker line count toward the section cap.
  const lineLimited = bodyLines.slice(0, Math.max(0, maxLines - metadata.split("\n").length - (prefix ? 1 : 0) - 2)).join("\n");
  const lineTruncated = lineLimited !== body;
  const marker = "\n[Child output truncated; use the retrieval route above.]";
  const metadataBytes = Buffer.byteLength(metadata);
  const markerBytes = Buffer.byteLength(marker);
  // Reserve the marker up front: a one-line answer can still exceed the byte limit.
  const room = Math.max(0, maxBytes - metadataBytes - Buffer.byteLength(prefix) - 2 - markerBytes);
  const bounded = truncateUtf8(lineLimited, room);
  const clipped = lineTruncated || bounded.truncated;
  const suffix = clipped ? marker : "";
  return metadata + "\n\n" + prefix + bounded.text + suffix;
}

export function formatModelContent(details: DedeToolDetails): string {
  const succeeded = details.results.filter((result) => result.status === "succeeded").length;
  const telemetry = `# Delegation: ${succeeded}/${details.results.length} succeeded\nRuntime telemetry: ${Math.round(details.durationMs)}ms`;
  if (details.results.length === 0) return telemetry;
  const headers = details.results.map((result) => `## ${result.id} — ${result.status}`);
  // Allocate the complete section (header plus child) before writing any body.
  // A one-child handoff also stays within the child limit for compatibility.
  const totalLimit = details.results.length === 1 ? CHILD_MODEL_MAX_BYTES : MODEL_CONTENT_MAX_BYTES;
  const separatorBytes = (details.results.length - 1) * Buffer.byteLength("\n\n---\n\n");
  const fixedBytes = Buffer.byteLength(telemetry) + 2 + headers.reduce((n, h) => n + Buffer.byteLength(h) + 1, 0) + separatorBytes;
  const fixedLines = telemetry.split("\n").length + headers.length + (details.results.length - 1) * 3 + 1;
  let bytesLeft = Math.max(0, totalLimit - fixedBytes);
  let linesLeft = Math.max(0, MODEL_CONTENT_MAX_LINES - fixedLines);
  const sections = details.results.map((result, index) => {
    const byteShare = Math.min(CHILD_MODEL_MAX_BYTES - Buffer.byteLength(headers[index]) - 1, Math.floor(bytesLeft / (details.results.length - index)));
    const lineShare = Math.min(CHILD_MODEL_MAX_LINES - 1, Math.floor(linesLeft / (details.results.length - index)));
    const body = boundedChild(result, Math.max(0, byteShare), Math.max(1, lineShare));
    const section = `${headers[index]}\n${body}`;
    bytesLeft -= Buffer.byteLength(body);
    linesLeft -= body.split("\n").length;
    return section;
  });
  return `${telemetry}\n\n${sections.join("\n\n---\n\n")}`;
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
  const groups = [...byModel].sort(([a], [b]) => a.localeCompare(b)).map(([model, usage]) => `${model}: ${usage.count} ${usage.count === 1 ? "subagent" : "subagents"} · $${usage.cost.toFixed(4)}`);
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
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

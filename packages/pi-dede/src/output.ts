import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { DetailedUsage, DedeChildResult, DedeToolDetails } from "./types.ts";
import { truncateUtf8 } from "./runner.ts";

const CHILD_MAX_BYTES = 16 * 1024;
const CHILD_MAX_LINES = 600;

export function deriveStatus(results: readonly DedeChildResult[]): DedeToolDetails["status"] {
  if (results.some((result) => result.status === "cancelled")) return "cancelled";
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  if (succeeded === results.length && results.length > 0) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial";
}

function childBody(result: DedeChildResult): string {
  if (result.status === "succeeded") return result.finalText || "(no output)";
  const diagnostics = [
    result.errorMessage,
    result.finalText && `Partial output:\n${result.finalText}`,
    result.stderrTail && `stderr (tail):\n\`\`\`\n${result.stderrTail}\n\`\`\``,
  ].filter(Boolean);
  return diagnostics.join("\n\n") || "(no diagnostic output)";
}

function boundedChild(result: DedeChildResult): string {
  const body = childBody(result);
  // Reserve room for the explicit truncation notice so each section stays near its advertised cap.
  let truncation = truncateHead(body, { maxBytes: CHILD_MAX_BYTES - 1024, maxLines: CHILD_MAX_LINES - 3 });
  let content = truncation.content;
  if (truncation.firstLineExceedsLimit) {
    const byteCap = truncateUtf8(body, CHILD_MAX_BYTES - 1024);
    content = byteCap.text;
    truncation = { ...truncation, truncated: true, outputBytes: Buffer.byteLength(content), outputLines: 1 };
  }
  if (!truncation.truncated) return content;

  const location = result.artifactPath
    ? ` Full output: ${result.artifactPath}`
    : " Full text remains available in structured tool details.";
  return `${content}\n\n[Child output truncated to ${truncation.outputLines}/${truncation.totalLines} lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}.${location}]`;
}

export function formatModelContent(details: DedeToolDetails): string {
  const succeeded = details.results.filter((result) => result.status === "succeeded").length;
  const sections = details.results.map((result) => `## ${result.id} — ${result.status}\n${boundedChild(result)}`);
  const raw = `# Đệ Đệ: ${succeeded}/${details.results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
  const truncation = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES - 300, maxLines: DEFAULT_MAX_LINES - 3 });
  if (!truncation.truncated) return raw;
  return `${truncation.content}\n\n[Aggregate output truncated to Pi's ${formatSize(DEFAULT_MAX_BYTES)}/${DEFAULT_MAX_LINES}-line tool limit. Full bounded child texts remain in structured details.]`;
}

export function progressContent(details: DedeToolDetails): string {
  const done = details.results.filter((result) => !["queued", "running"].includes(result.status)).length;
  const running = details.results.filter((result) => result.status === "running").length;
  return `Đệ Đệ: ${done}/${details.results.length} done · ${running} running`;
}

export function cloneDetails(details: DedeToolDetails): DedeToolDetails {
  return {
    ...details,
    results: details.results.map((result) => ({
      ...result,
      dependsOn: [...(result.dependsOn ?? [])],
      tools: [...result.tools],
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

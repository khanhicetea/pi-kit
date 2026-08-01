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

function childBody(result: DedeChildResult): string {
  const session = result.sessionId
    ? `Session: \`${result.sessionId}\` (inspect with \`pi --session ${result.sessionId}\`)`
    : undefined;
  if (result.status === "succeeded") return [session, result.finalText || "(no output)"].filter(Boolean).join("\n\n");
  const resume = result.resumeHandle
    ? `Short resume available: \`${result.resumeHandle}\`. Resume only if the partial work is close to useful completion. Call dede_delegate with one agent using \"resume\": \"${result.resumeHandle}\", a goal stating only what remains, and timeoutSeconds from 30 to 180.`
    : undefined;
  const diagnostics = [
    session,
    result.errorMessage,
    resume,
    result.finalText && `Partial output:\n${result.finalText}`,
    result.stderrTail && `stderr (tail):\n\`\`\`\n${result.stderrTail}\n\`\`\``,
  ].filter(Boolean);
  return diagnostics.join("\n\n") || "(no diagnostic output)";
}

function boundedChild(result: DedeChildResult): string {
  const body = childBody(result);
  // Reserve room for the explicit truncation notice so the complete child section remains bounded.
  let truncation = truncateHead(body, { maxBytes: CHILD_MODEL_MAX_BYTES - 768, maxLines: CHILD_MODEL_MAX_LINES - 3 });
  let content = truncation.content;
  if (truncation.firstLineExceedsLimit) {
    const byteCap = truncateUtf8(body, CHILD_MODEL_MAX_BYTES - 768);
    content = byteCap.text;
    truncation = { ...truncation, truncated: true, outputBytes: Buffer.byteLength(content), outputLines: 1 };
  }
  if (!truncation.truncated) return content;

  const location = result.artifactPath
    ? ` Full output: ${result.artifactPath}`
    : " More text remains in structured tool details.";
  return `${content}\n\n[Child output truncated to ${truncation.outputLines}/${truncation.totalLines} lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}.${location}]`;
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

export function cloneDetails(details: DedeToolDetails): DedeToolDetails {
  return {
    ...details,
    results: details.results.map((result) => ({
      ...result,
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

import { describe, expect, it } from "vitest";
import {
  CHILD_MODEL_MAX_BYTES,
  deriveStatus,
  formatModelContent,
  formatSettledSummary,
  MODEL_CONTENT_MAX_BYTES,
  MODEL_CONTENT_MAX_LINES,
} from "../src/output.ts";
import type { DedeChildResult, DedeToolDetails } from "../src/types.ts";

function child(id: string, status: DedeChildResult["status"], finalText = "## Answer\n- ok"): DedeChildResult {
  return {
    id,
    profile: "scout",
    goal: "inspect",
    status,
    model: "test/model",
    thinking: "low",
    tools: ["read"],
    timeoutSeconds: 120,
    finalText,
    durationMs: 10,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
    activity: [],
    ...(status === "failed" ? { errorMessage: "failed" } : {}),
  };
}

function details(results: DedeChildResult[]): DedeToolDetails {
  return { version: 2, runId: "run", status: deriveStatus(results), startedAt: 0, durationMs: 1, results };
}

describe("output", () => {
  it("derives aggregate statuses", () => {
    expect(deriveStatus([child("a", "succeeded")])).toBe("succeeded");
    expect(deriveStatus([child("a", "failed")])).toBe("failed");
    expect(deriveStatus([child("a", "succeeded"), child("b", "failed")])).toBe("partial");
    expect(deriveStatus([child("a", "cancelled")])).toBe("cancelled");
  });

  it("preserves request order, presents partial failures, and exposes child sessions", () => {
    const first = child("first", "succeeded");
    first.sessionId = "11111111-1111-4111-8111-111111111111";
    const text = formatModelContent(details([first, child("second", "failed")]));
    expect(text).toContain("# Delegation: 1/2 succeeded");
    expect(text.indexOf("## first")).toBeLessThan(text.indexOf("## second"));
    expect(text).toContain("failed");
    expect(text).toContain("Session: `11111111-1111-4111-8111-111111111111`");
    expect(text).toContain("pi --session 11111111-1111-4111-8111-111111111111");
  });

  it("exposes a successful child's related continuation capability", () => {
    const finished = child("scout", "succeeded");
    finished.continuationHandle = "dede_continue";
    finished.continuationIndex = 0;
    const text = formatModelContent(details([finished]));
    expect(text).toContain("Related continuation available: `dede_continue`");
    expect(text).toContain('"continueFrom": "dede_continue"');
    expect(text).toContain("directly benefits from this child's context");
  });

  it("puts the short resume instructions before partial timed-out output", () => {
    const timedOut = child("slow", "timed_out", "partial evidence");
    timedOut.errorMessage = "Timed out after 120 seconds";
    timedOut.resumeHandle = "dede_handle";
    const text = formatModelContent(details([timedOut]));
    expect(text).toContain("Short resume available: `dede_handle`");
    expect(text).toContain('"resume": "dede_handle"');
    expect(text.indexOf("Short resume available")).toBeLessThan(text.indexOf("Partial output"));
  });

  it("summarizes settled subagent count and cost by model id", () => {
    const first = child("first", "succeeded");
    first.model = "anthropic/claude-sonnet";
    first.usage.cost = 0.0123;
    const second = child("second", "failed");
    second.model = "openai-codex/gpt-5";
    second.usage.cost = 0.004;
    const third = child("third", "succeeded");
    third.model = "anthropic/claude-sonnet";
    third.usage.cost = 0.0007;

    expect(formatSettledSummary([first, second, third])).toBe([
      "Đệ Đệ: 3 subagents · $0.0170 total",
      "anthropic/claude-sonnet: 2 subagents · $0.0130",
      "openai-codex/gpt-5: 1 subagent · $0.0040",
    ].join("\n"));
    expect(formatSettledSummary([])).toBeUndefined();
  });

  it("reserves every handle and retrieval route for long Unicode answers", () => {
    const results = ["one", "two", "three"].map((id) => ({
      ...child(id, "succeeded", "🦊".repeat(8000)),
      continuationHandle: `dede_${id}`, sessionId: id, sessionPath: `/sessions/${id}.jsonl`,
      contextFallbackReason: "reason".repeat(2000), errorMessage: "error".repeat(2000),
    }));
    const text = formatModelContent(details(results));
    for (const result of results) {
      expect(text).toContain(result.continuationHandle);
      expect(text).toContain(result.sessionPath);
    }
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MODEL_CONTENT_MAX_BYTES);
    expect(text.split("\n").length).toBeLessThanOrEqual(MODEL_CONTENT_MAX_LINES);
  });

  it("bounds each child near 4 KiB and the aggregate to 12 KiB", () => {
    const huge = Array.from({ length: 5000 }, (_, index) => `line ${index} ${"x".repeat(100)}`).join("\n");
    const one = formatModelContent(details([child("one", "succeeded", huge)]));
    expect(Buffer.byteLength(one, "utf8")).toBeLessThanOrEqual(CHILD_MODEL_MAX_BYTES);
    expect(one).toContain("Child output truncated");

    const text = formatModelContent(details([
      child("one", "succeeded", huge),
      child("two", "succeeded", huge),
      child("three", "succeeded", huge),
    ]));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MODEL_CONTENT_MAX_BYTES);
    expect(text.split("\n").length).toBeLessThanOrEqual(MODEL_CONTENT_MAX_LINES);
    expect(text).toContain("truncated");
  });
});

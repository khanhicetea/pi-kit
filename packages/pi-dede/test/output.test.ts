import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { deriveStatus, formatModelContent } from "../src/output.ts";
import type { DedeChildResult, DedeToolDetails } from "../src/types.ts";

function child(id: string, status: DedeChildResult["status"], finalText = "## Summary\nok"): DedeChildResult {
  return {
    id,
    profile: "scout",
    goal: "inspect",
    dependsOn: [],
    status,
    model: "test/model",
    thinking: "low",
    tools: ["read"],
    finalText,
    durationMs: 10,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
    activity: [],
    ...(status === "failed" ? { errorMessage: "failed" } : {}),
  };
}

function details(results: DedeChildResult[]): DedeToolDetails {
  return { version: 1, runId: "run", status: deriveStatus(results), startedAt: 0, durationMs: 1, results };
}

describe("output", () => {
  it("derives aggregate statuses", () => {
    expect(deriveStatus([child("a", "succeeded")])).toBe("succeeded");
    expect(deriveStatus([child("a", "failed")])).toBe("failed");
    expect(deriveStatus([child("a", "succeeded"), child("b", "failed")])).toBe("partial");
    expect(deriveStatus([child("a", "cancelled")])).toBe("cancelled");
  });

  it("preserves request order and presents partial failures", () => {
    const text = formatModelContent(details([child("first", "succeeded"), child("second", "failed")]));
    expect(text).toContain("# Đệ Đệ: 1/2 succeeded");
    expect(text.indexOf("## first")).toBeLessThan(text.indexOf("## second"));
    expect(text).toContain("failed");
  });

  it("never exceeds standard aggregate byte and line limits", () => {
    const huge = Array.from({ length: 5000 }, (_, index) => `line ${index} ${"x".repeat(100)}`).join("\n");
    const text = formatModelContent(details([
      child("one", "succeeded", huge),
      child("two", "succeeded", huge),
      child("three", "succeeded", huge),
    ]));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
    expect(text).toContain("truncated");
  });
});

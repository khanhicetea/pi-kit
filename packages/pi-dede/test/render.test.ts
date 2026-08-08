import { describe, expect, it } from "vitest";
import { renderDedeCall, renderDedeResult } from "../src/render.ts";
import type { DedeToolDetails } from "../src/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("TUI rendering", () => {
  it("shows each agent's model, thinking, elapsed time, deadline, and cancellation hint", () => {
    const details: DedeToolDetails = {
      version: 2,
      runId: "run",
      status: "succeeded",
      startedAt: 0,
      durationMs: 1200,
      results: [{
        id: "scout",
        profile: "scout",
        goal: "inspect",
        status: "running",
        model: "test/model",
        thinking: "low",
        tools: ["read"],
        timeoutSeconds: 120,
        resumedFrom: "dede_handle",
        finalText: "",
        durationMs: 1200,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
        activity: [{ type: "status", text: "reading src/index.ts" }],
      }],
    };

    const component = renderDedeResult({ details }, { isPartial: true }, theme, {});
    const text = component.render(200).join("\n");
    expect(text).toContain("scout · resumed · scout · test/model · low · 1.2s/120s");
    expect(text).toContain("reading src/index.ts");
    expect(text).toContain("0/1 done · 1 running");
    expect(text).toContain("Esc to cancel");
  });

  it("shows the master objective and each lane contract in the call view", () => {
    const component = renderDedeCall({
      objective: "Decide whether token refresh is safe",
      agents: [{ id: "risk", profile: "reviewer", goal: "Review replay behavior and stop after five findings" }],
    }, theme, {});
    const text = component.render(200).join("\n");
    expect(text).toContain("objective · Decide whether token refresh is safe");
    expect(text).toContain("risk · reviewer · read-only · 180s");
    expect(text).toContain("Review replay behavior and stop after five findings");

    const resume = renderDedeCall({
      objective: "Finish one missing finding",
      agents: [{ id: "finish", resume: "dede_handle", goal: "Return only the missing finding" }],
    }, theme, {}).render(200).join("\n");
    expect(resume).toContain("finish · existing profile · existing capabilities · 60s");
    expect(resume).not.toContain("finish · custom");

    const continuation = renderDedeCall({
      objective: "Inspect a related path",
      agents: [{ id: "followup", continueFrom: "dede_continue", goal: "Inspect the related path and stop" }],
    }, theme, {}).render(200).join("\n");
    expect(continuation).toContain("related continuation · 1 agent");
    expect(continuation).toContain("followup · existing profile · existing capabilities · 180s · continue dede_continue");
  });

  it("shows the inspectable session ID in collapsed and expanded results", () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const details: DedeToolDetails = {
      version: 2,
      runId: "run",
      status: "succeeded",
      startedAt: 0,
      durationMs: 1200,
      results: [{
        id: "scout",
        profile: "scout",
        goal: "inspect",
        status: "succeeded",
        model: "test/model",
        thinking: "low",
        tools: ["read"],
        timeoutSeconds: 120,
        sessionId,
        continuationHandle: "dede_continue",
        continuationIndex: 0,
        finalText: "Done",
        durationMs: 1200,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
        activity: [],
      }],
    };

    const collapsed = renderDedeResult({ details }, { expanded: false }, theme, {}).render(200).join("\n");
    expect(collapsed).toContain(`session ${sessionId} · pi --session ${sessionId}`);

    const expanded = renderDedeResult({ details }, { expanded: true }, theme, { args: {} }).render(200).join("\n");
    expect(expanded).toContain(`Session: ${sessionId} · inspect with pi --session ${sessionId}`);
    expect(expanded).toContain("Related continuation: dede_continue · same session and capabilities");
  });

  it("distinguishes timeout state and bounds expanded activity history", () => {
    const details: DedeToolDetails = {
      version: 2,
      runId: "run",
      status: "failed",
      startedAt: 0,
      durationMs: 60_000,
      results: [{
        id: "risk",
        profile: "reviewer",
        goal: "review",
        status: "timed_out",
        model: "test/model",
        thinking: "medium",
        tools: ["read"],
        timeoutSeconds: 60,
        resumeHandle: "dede_handle",
        finalText: "partial",
        durationMs: 60_000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 1 },
        activity: Array.from({ length: 15 }, (_, index) => ({ type: "status" as const, text: `event-${String(index).padStart(2, "0")}` })),
      }],
    };

    const collapsed = renderDedeResult({ details }, { expanded: false }, theme, {}).render(200).join("\n");
    expect(collapsed).toContain("◷ risk · timed_out");
    expect(collapsed).toContain("1 timed out");

    const expanded = renderDedeResult({ details }, { expanded: true }, theme, { args: {} }).render(200).join("\n");
    expect(expanded).toContain("… 3 earlier events");
    expect(expanded).not.toContain("event-00");
    expect(expanded).toContain("event-14");
    expect(expanded).toContain("Short resume: dede_handle");
  });
});

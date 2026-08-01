import { describe, expect, it } from "vitest";
import { renderDedeResult } from "../src/render.ts";
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
    expect(text).toContain("scout · resumed · test/model · low · 1.2s/120s · reading src/index.ts");
    expect(text).toContain("Esc to cancel");
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
  });
});

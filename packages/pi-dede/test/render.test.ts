import { describe, expect, it } from "vitest";
import { renderDedeResult } from "../src/render.ts";
import type { DedeToolDetails } from "../src/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("TUI rendering", () => {
  it("shows each agent's model and thinking level in progress", () => {
    const details: DedeToolDetails = {
      version: 1,
      runId: "run",
      status: "succeeded",
      startedAt: 0,
      durationMs: 0,
      results: [{
        id: "scout",
        profile: "scout",
        goal: "inspect",
        dependsOn: [],
        status: "running",
        model: "test/model",
        thinking: "high",
        tools: ["read"],
        finalText: "",
        durationMs: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
        activity: [{ type: "status", text: "reading src/index.ts" }],
      }],
    };

    const component = renderDedeResult({ details }, { isPartial: true }, theme, {});
    expect(component.render(200).join("\n")).toContain("scout · test/model · high · reading src/index.ts");
  });
});

import { describe, expect, it } from "vitest";
import { validateAndResolve } from "../src/schema.ts";
import { buildSystemPrompt, addForkTaskContract } from "../src/profiles.ts";
import { PROFILES } from "../src/types.ts";

const model = { provider: "test", id: "model" };
const context = { model, models: [model] };

describe("specialist capabilities", () => {
  it.each(PROFILES)("resolves %s defaults and output contracts", (profile) => {
    const [agent] = validateAndResolve({ objective: "check", agents: [{ id: "child", profile, goal: "bounded task" }] }, context);
    const coding = ["worker", "tester", "documenter"].includes(profile);
    expect(agent.toolPreset).toBe(coding ? "coding" : "read-only");
    expect(agent.mutationCapable).toBe(coding);
    expect(buildSystemPrompt(agent).includes("## Files Changed")).toBe(coding);
    expect(addForkTaskContract("task", { ...agent, resolvedContextMode: "fork" }).includes("## Files Changed")).toBe(coding);
  });

  it("keeps specialist writers subject to the one-writer limit", () => {
    expect(() => validateAndResolve({ objective: "check", agents: [
      { id: "tests", profile: "tester", goal: "test" },
      { id: "docs", profile: "documenter", goal: "document" },
    ] }, context)).toThrow("At most one mutation-capable");
  });

  it("honors specialist configuration and read-only overrides", () => {
    const [agent] = validateAndResolve({ objective: "check", agents: [{
      id: "tests", profile: "tester", goal: "inspect tests", toolPreset: "read-only", contextMode: "isolated",
    }] }, { ...context, profileDefaults: { tester: { thinking: "low", model: "test/model" } } });
    expect(agent.mutationCapable).toBe(false);
    expect(agent.thinking).toBe("low");
    expect(agent.model).toBe("test/model");
  });
});

import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { DedeDelegateSchema, isMutationCapable, resolveModelPattern, validateAndResolve } from "../src/schema.ts";
import type { DedeDelegateParams, ValidationContext } from "../src/types.ts";

const context: ValidationContext = {
  model: { provider: "test", id: "main" },
  thinkingLevel: "high",
  models: [
    { provider: "test", id: "main", name: "Main" },
    { provider: "other", id: "small", name: "Small" },
  ],
};

const valid = (overrides: Partial<DedeDelegateParams> = {}): DedeDelegateParams => ({
  objective: "Inspect the project",
  agents: [{ id: "scout", goal: "Find the entry point" }],
  ...overrides,
});

afterEach(() => { delete process.env.PI_DEDE_DEPTH; });

describe("public schema", () => {
  it("accepts the guardrail fields and keeps dependencyContext closed", () => {
    const input = {
      objective: "Inspect",
      agents: [{
        id: "a",
        goal: "x",
        timeoutSeconds: 30,
        dependencyContext: { mode: "summary", maxBytes: 4096 },
      }],
      timeoutSeconds: 1800,
    };
    expect(Check(DedeDelegateSchema, input)).toBe(true);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], dependencyContext: { ...input.agents[0].dependencyContext, extra: true } }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], dependencyContext: { maxBytes: 4096 } }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], timeoutSeconds: 29 }],
    })).toBe(false);
  });
});

describe("semantic validation", () => {
  it("applies profile defaults and inherits model/thinking", () => {
    const [agent] = validateAndResolve(valid(), context);
    expect(agent).toMatchObject({
      profile: "custom",
      toolPreset: "read-only",
      tools: ["read", "grep", "find", "ls"],
      model: "test/main",
      thinking: "high",
      mutationCapable: false,
    });
  });

  it("resolves planners as read-only agents", () => {
    const [agent] = validateAndResolve(valid({ agents: [{ id: "plan", profile: "planner", goal: "Plan the change" }] }), context);
    expect(agent).toMatchObject({
      profile: "planner",
      toolPreset: "read-only",
      tools: ["read", "grep", "find", "ls"],
      mutationCapable: false,
    });
  });

  it("applies profile defaults below explicit fields and above master inheritance", () => {
    const defaults: ValidationContext = {
      ...context,
      profileDefaults: {
        scout: { model: "other/small", thinking: "low" },
      },
    };

    const [configured] = validateAndResolve(valid({ agents: [{ id: "a", profile: "scout", goal: "x" }] }), defaults);
    expect(configured).toMatchObject({ model: "other/small", thinking: "low" });

    const [explicit] = validateAndResolve(valid({ agents: [{
      id: "a",
      profile: "scout",
      goal: "x",
      model: "test/main",
      thinking: "max",
    }] }), defaults);
    expect(explicit).toMatchObject({ model: "test/main", thinking: "max" });

    const [inherited] = validateAndResolve(valid({ agents: [{ id: "a", profile: "reviewer", goal: "x" }] }), defaults);
    expect(inherited).toMatchObject({ model: "test/main", thinking: "high" });
  });

  it("requires explicit tools for custom and rejects tools on other presets", () => {
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom" }] }), context)).toThrow(/tools is required/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "none", tools: [] }] }), context)).toThrow(/allowed only/);
  });

  it("allows an explicitly empty custom toolset", () => {
    const [agent] = validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom", tools: [] }] }), context);
    expect(agent.tools).toEqual([]);
  });

  it("rejects duplicate ids and duplicate tools", () => {
    expect(() => validateAndResolve(valid({ agents: [{ id: "same", goal: "x" }, { id: "same", goal: "y" }] }), context)).toThrow(/Duplicate/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom", tools: ["read", "read"] }] }), context)).toThrow(/duplicates/);
  });

  it("accepts top-level timeout values from 1800 through 3600 seconds", () => {
    expect(() => validateAndResolve(valid({ timeoutSeconds: 1800 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 3600 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 1799 }), context)).toThrow(/1800 to 3600/);
    expect(() => validateAndResolve(valid({ timeoutSeconds: 3601 }), context)).toThrow(/1800 to 3600/);
  });

  it("resolves timeout precedence per agent and validates the wider agent range", () => {
    expect(validateAndResolve(valid(), context)[0].timeoutSeconds).toBe(1800);
    expect(validateAndResolve(valid({ timeoutSeconds: 2400 }), context)[0].timeoutSeconds).toBe(2400);
    expect(validateAndResolve(valid({
      timeoutSeconds: 2400,
      agents: [{ id: "a", goal: "x", timeoutSeconds: 30 }],
    }), context)[0].timeoutSeconds).toBe(30);
    expect(validateAndResolve(valid({ agents: [{ id: "a", goal: "x", timeoutSeconds: 3600 }] }), context)[0].timeoutSeconds).toBe(3600);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", timeoutSeconds: 29 }] }), context)).toThrow(/30 to 3600/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", timeoutSeconds: 30.5 }] }), context)).toThrow(/30 to 3600/);
  });

  it("resolves and validates dependency context policies", () => {
    const policy = { mode: "summary" as const, maxBytes: 4096 };
    const [agent] = validateAndResolve(valid({ agents: [{ id: "a", goal: "x", dependencyContext: policy }] }), context);
    expect(agent.dependencyContext).toEqual(policy);
    expect(agent.dependencyContext).not.toBe(policy);
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", dependencyContext: { mode: "full", maxBytes: 4095 } }],
    }), context)).toThrow(/4096 to 262144/);
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", dependencyContext: { mode: "full", maxBytes: 262145 } }],
    }), context)).toThrow(/4096 to 262144/);
    expect(() => validateAndResolve(valid({
      agents: [{
        id: "a",
        goal: "x",
        dependencyContext: { mode: "full", maxBytes: 4096, extra: true } as never,
      }],
    }), context)).toThrow(/unsupported properties: extra/);
  });

  it("accepts up to five agents and rejects a sixth", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => ({ id, goal: id }));
    expect(validateAndResolve(valid({ agents: five }), context)).toHaveLength(5);
    expect(() => validateAndResolve(valid({ agents: [...five, { id: "f", goal: "f" }] }), context)).toThrow(/one to five/);
  });

  it("accepts dependency DAGs, including forward references and fan-in", () => {
    const agents = validateAndResolve(valid({ agents: [
      { id: "review", goal: "review", dependsOn: ["scan", "tests"] },
      { id: "scan", goal: "scan" },
      { id: "tests", goal: "tests", dependsOn: ["scan"] },
    ] }), context);
    expect(agents.map((agent) => [agent.id, agent.dependsOn])).toEqual([
      ["review", ["scan", "tests"]],
      ["scan", []],
      ["tests", ["scan"]],
    ]);
  });

  it("rejects invalid dependency graphs", () => {
    expect(() => validateAndResolve(valid({ agents: [
      { id: "a", goal: "a" },
      { id: "b", goal: "b", dependsOn: ["missing"] },
    ] }), context)).toThrow(/unknown agent/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "a", dependsOn: ["a"] }] }), context)).toThrow(/itself/);
    expect(() => validateAndResolve(valid({ agents: [
      { id: "a", goal: "a" },
      { id: "b", goal: "b", dependsOn: ["a", "a"] },
    ] }), context)).toThrow(/duplicates/);
    expect(() => validateAndResolve(valid({ agents: [
      { id: "a", goal: "a", dependsOn: ["b"] },
      { id: "b", goal: "b", dependsOn: ["c"] },
      { id: "c", goal: "c", dependsOn: ["a"] },
    ] }), context)).toThrow(/cycle/);
  });

  it("treats bash, edit, and write as mutation-capable and rejects parallel mutation", () => {
    expect(isMutationCapable(["bash"])).toBe(true);
    expect(isMutationCapable(["edit"])).toBe(true);
    expect(isMutationCapable(["write"])).toBe(true);
    expect(isMutationCapable(["read", "grep"])).toBe(false);
    expect(() => validateAndResolve(valid({ agents: [
      { id: "worker", profile: "worker", goal: "change it" },
      { id: "reader", goal: "inspect it" },
    ] }), context)).toThrow(/must run alone/);
  });

  it("checks UTF-8 byte limits", () => {
    expect(() => validateAndResolve(valid({ objective: "🦊".repeat(3073) }), context)).toThrow(/UTF-8 bytes/);
    expect(() => validateAndResolve(valid({ sharedContext: "界".repeat(16385) }), context)).toThrow(/UTF-8 bytes/);
  });

  it("rejects recursion and extension-only providers", () => {
    process.env.PI_DEDE_DEPTH = "1";
    expect(() => validateAndResolve(valid(), context)).toThrow(/Recursive/);
    delete process.env.PI_DEDE_DEPTH;
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", model: "other/small" }] }), {
      ...context,
      extensionProviderIds: ["other"],
    })).toThrow(/registered by an extension/);
  });
});

describe("model resolution", () => {
  it("supports canonical, bare, partial, and glob patterns", () => {
    expect(resolveModelPattern("other/small", context.models)?.provider).toBe("other");
    expect(resolveModelPattern("main", context.models)?.id).toBe("main");
    expect(resolveModelPattern("sma", context.models)?.id).toBe("small");
    expect(resolveModelPattern("other/sm*", context.models)?.id).toBe("small");
    expect(resolveModelPattern("missing", context.models)).toBeUndefined();
  });
});

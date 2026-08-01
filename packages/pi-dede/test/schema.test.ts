import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHILD_TIMEOUT_SECONDS,
  DedeDelegateSchema,
  isMutationCapable,
  resolveModelPattern,
  validateAndResolve,
} from "../src/schema.ts";
import type { DedeDelegateParams, ValidationContext } from "../src/types.ts";

const context: ValidationContext = {
  model: { provider: "test", id: "main" },
  models: [
    { provider: "test", id: "main", name: "Main" },
    { provider: "other", id: "small", name: "Small" },
  ],
};

const valid = (overrides: Partial<DedeDelegateParams> = {}): DedeDelegateParams => ({
  objective: "Inspect the project",
  agents: [{ id: "scout", goal: "Answer one bounded question in src/auth and stop" }],
  ...overrides,
});

afterEach(() => { delete process.env.PI_DEDE_DEPTH; });

describe("public schema", () => {
  it("accepts v0.2 budgets and rejects removed workflow fields", () => {
    const input = {
      objective: "Inspect",
      agents: [{ id: "a", goal: "x", timeoutSeconds: 30, env: { CHILD_MODE: "inspect" } }],
      timeoutSeconds: 600,
    };
    expect(Check(DedeDelegateSchema, input)).toBe(true);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], dependsOn: ["b"] }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], profile: "planner" }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ ...input.agents[0], timeoutSeconds: 601 }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      objective: "Finish",
      agents: [{ id: "a", goal: "Return the remaining evidence", resume: "dede_handle", timeoutSeconds: 60 }],
    })).toBe(true);
    expect(Check(DedeDelegateSchema, {
      ...input,
      agents: [{ id: "a", goal: "x", env: { CHILD_MODE: 1 } }],
    })).toBe(false);
  });
});

describe("semantic validation", () => {
  it("uses bounded built-in defaults instead of inheriting master thinking", () => {
    const [agent] = validateAndResolve(valid(), context);
    expect(agent).toMatchObject({
      profile: "custom",
      toolPreset: "read-only",
      tools: ["read", "grep", "find", "ls"],
      model: "test/main",
      thinking: "low",
      timeoutSeconds: DEFAULT_CHILD_TIMEOUT_SECONDS,
      mutationCapable: false,
    });
  });

  it("resolves profile capabilities and thinking defaults", () => {
    const [reviewer] = validateAndResolve(valid({
      agents: [{ id: "review", profile: "reviewer", goal: "Review only token expiry" }],
    }), context);
    expect(reviewer).toMatchObject({ profile: "reviewer", thinking: "medium", toolPreset: "read-only", mutationCapable: false });

    const [worker] = validateAndResolve(valid({
      agents: [{ id: "worker", profile: "worker", goal: "Apply the supplied one-file change" }],
    }), context);
    expect(worker).toMatchObject({ profile: "worker", thinking: "medium", toolPreset: "coding", mutationCapable: true });
  });

  it("applies profile defaults below explicit fields and above built-in defaults", () => {
    const defaults: ValidationContext = {
      ...context,
      profileDefaults: {
        scout: { model: "other/small", thinking: "minimal", env: { CONFIG_ONLY: "yes", SHARED: "config" } },
      },
    };

    const [configured] = validateAndResolve(valid({ agents: [{ id: "a", profile: "scout", goal: "x" }] }), defaults);
    expect(configured).toMatchObject({
      model: "other/small",
      thinking: "minimal",
      env: { CONFIG_ONLY: "yes", SHARED: "config" },
    });

    const [explicit] = validateAndResolve(valid({ agents: [{
      id: "a",
      profile: "scout",
      goal: "x",
      model: "test/main",
      thinking: "high",
      env: { REQUEST_ONLY: "yes", SHARED: "request" },
    }] }), defaults);
    expect(explicit).toMatchObject({
      model: "test/main",
      thinking: "high",
      env: { CONFIG_ONLY: "yes", REQUEST_ONLY: "yes", SHARED: "request" },
    });
  });

  it("rejects protected and malformed environment overrides", () => {
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", env: { NODE_OPTIONS: "--require=/tmp/inject.js" } }],
    }), context)).toThrow(/protected variable: NODE_OPTIONS/);
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", env: { "NOT-PORTABLE": "value" } }],
    }), context)).toThrow(/invalid variable name/);
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", env: { TOKEN: "x\0y" } }],
    }), context)).toThrow(/NUL bytes/);

    const configured = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`CONFIG_${index}`, "x"]));
    const requested = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`REQUEST_${index}`, "x"]));
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", profile: "scout", goal: "x", env: requested }],
    }), { ...context, profileDefaults: { scout: { env: configured } } })).toThrow(/effectiveEnv.*at most 64/);
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

  it("accepts timeout values from 30 through 600 seconds", () => {
    expect(() => validateAndResolve(valid({ timeoutSeconds: 30 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 600 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 29 }), context)).toThrow(/30 to 600/);
    expect(() => validateAndResolve(valid({ timeoutSeconds: 601 }), context)).toThrow(/30 to 600/);
  });

  it("resolves per-agent timeout ahead of run default", () => {
    expect(validateAndResolve(valid(), context)[0].timeoutSeconds).toBe(120);
    expect(validateAndResolve(valid({ timeoutSeconds: 240 }), context)[0].timeoutSeconds).toBe(240);
    expect(validateAndResolve(valid({
      timeoutSeconds: 240,
      agents: [{ id: "a", goal: "x", timeoutSeconds: 45 }],
    }), context)[0].timeoutSeconds).toBe(45);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", timeoutSeconds: 30.5 }] }), context)).toThrow(/30 to 600/);
  });

  it("resumes one timed-out child with its original identity and a short deadline", () => {
    const sourceAgent = validateAndResolve(valid({
      agents: [{
        id: "old",
        profile: "reviewer",
        goal: "Review token expiry",
        model: "other/small",
        env: { REVIEW_TOKEN: "kept" },
      }],
    }), context)[0];
    const resumeContext: ValidationContext = {
      ...context,
      resumeLookup: (handle) => handle === "dede_handle" ? {
        handle,
        sessionId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
        agent: sourceAgent,
      } : undefined,
    };

    const [resumed] = validateAndResolve({
      objective: "Finish only the missing expiry finding",
      agents: [{ id: "finish", goal: "Return the last finding and stop", resume: "dede_handle" }],
    }, resumeContext);
    expect(resumed).toMatchObject({
      id: "finish",
      profile: "reviewer",
      model: "other/small",
      thinking: "medium",
      tools: ["read", "grep", "find", "ls"],
      env: { REVIEW_TOKEN: "kept" },
      timeoutSeconds: 60,
      resume: { handle: "dede_handle", sessionId: "11111111-1111-4111-8111-111111111111", attempt: 1 },
    });

    expect(() => validateAndResolve({
      objective: "resume",
      agents: [{ id: "a", goal: "finish", resume: "missing" }],
    }, resumeContext)).toThrow(/unavailable, expired, or already in use/);
    expect(() => validateAndResolve({
      objective: "resume",
      agents: [{ id: "a", goal: "finish", resume: "dede_handle", model: "test/main" }],
    }, resumeContext)).toThrow(/cannot override model/);
    expect(() => validateAndResolve({
      objective: "resume",
      agents: [{ id: "a", goal: "finish", resume: "dede_handle", env: { REVIEW_TOKEN: "changed" } }],
    }, resumeContext)).toThrow(/cannot override env/);
    expect(() => validateAndResolve({
      objective: "resume",
      agents: [{ id: "a", goal: "finish", resume: "dede_handle", timeoutSeconds: 181 }],
    }, resumeContext)).toThrow(/must not exceed 180/);
    expect(() => validateAndResolve({
      objective: "resume",
      agents: [
        { id: "a", goal: "finish", resume: "dede_handle" },
        { id: "b", goal: "new work" },
      ],
    }, resumeContext)).toThrow(/resume must run alone/);
  });

  it("accepts up to three agents and rejects a fourth", () => {
    const three = ["a", "b", "c"].map((id) => ({ id, goal: id }));
    expect(validateAndResolve(valid({ agents: three }), context)).toHaveLength(3);
    expect(() => validateAndResolve(valid({ agents: [...three, { id: "d", goal: "d" }] }), context)).toThrow(/one to 3/);
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

  it("checks reduced UTF-8 byte limits", () => {
    expect(() => validateAndResolve(valid({ objective: "🦊".repeat(1025) }), context)).toThrow(/UTF-8 bytes/);
    expect(() => validateAndResolve(valid({ sharedContext: "界".repeat(5462) }), context)).toThrow(/UTF-8 bytes/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "🦊".repeat(1025) }] }), context)).toThrow(/UTF-8 bytes/);
  });

  it("rejects recursion and gives an actionable extension-provider error", () => {
    process.env.PI_DEDE_DEPTH = "1";
    expect(() => validateAndResolve(valid(), context)).toThrow(/Recursive/);
    delete process.env.PI_DEDE_DEPTH;
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", model: "other/small" }] }), {
      ...context,
      extensionProviderIds: ["other"],
    })).toThrow(/additionalArgs.*configure profiles\.custom\.model.*test\/main/);
  });

  it("allows an extension-provider model when an extension is explicitly loaded in children", () => {
    const [agent] = validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", model: "other/small" }],
    }), {
      ...context,
      extensionProviderIds: ["other"],
      extensionProvidersAvailableToChild: true,
    });
    expect(agent.model).toBe("other/small");
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

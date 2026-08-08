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
      timeoutSeconds: 1800,
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
      agents: [{ ...input.agents[0], timeoutSeconds: 1801 }],
    })).toBe(false);
    expect(Check(DedeDelegateSchema, {
      objective: "Finish",
      agents: [{ id: "a", goal: "Return the remaining evidence", resume: "dede_handle", timeoutSeconds: 60 }],
    })).toBe(true);
    expect(Check(DedeDelegateSchema, {
      objective: "Continue related work",
      agents: [{ id: "a", goal: "Inspect the related path", continueFrom: "dede_handle", timeoutSeconds: 300 }],
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
      additionalArgs: ["--shared-child-arg"],
      profileDefaults: {
        scout: { model: "other/small", thinking: "minimal", env: { CONFIG_ONLY: "yes", SHARED: "config" }, additionalArgs: ["-e", "/scout/ext.ts"] },
        reviewer: { additionalArgs: [] },
      },
    };

    const [configured] = validateAndResolve(valid({ agents: [{ id: "a", profile: "scout", goal: "x" }] }), defaults);
    expect(configured).toMatchObject({
      model: "other/small",
      thinking: "minimal",
      env: { CONFIG_ONLY: "yes", SHARED: "config" },
      additionalArgs: ["-e", "/scout/ext.ts"],
    });

    const [shared] = validateAndResolve(valid({ agents: [{ id: "a", profile: "custom", goal: "x" }] }), defaults);
    expect(shared.additionalArgs).toEqual(["--shared-child-arg"]);

    const [emptyOverride] = validateAndResolve(valid({ agents: [{ id: "a", profile: "reviewer", goal: "x" }] }), defaults);
    expect(emptyOverride.additionalArgs).toEqual([]);

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
      additionalArgs: ["-e", "/scout/ext.ts"],
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

  it("auto-selects the custom preset when tools are supplied and requires tools only for an explicit custom preset", () => {
    // Explicit custom preset with no tools is still invalid.
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom" }] }), context)).toThrow(/tools is required/);
    // Providing tools selects custom directly; no toolPreset needed.
    const [promoted] = validateAndResolve(valid({ agents: [{ id: "a", goal: "x", tools: ["read", "grep"] }] }), context);
    expect(promoted).toMatchObject({ toolPreset: "custom", tools: ["read", "grep"] });
    // tools wins even when a named preset is also present.
    const [override] = validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "none", tools: [] }] }), context);
    expect(override).toMatchObject({ toolPreset: "custom", tools: [] });
  });

  it("allows an explicitly empty custom toolset", () => {
    const [agent] = validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom", tools: [] }] }), context);
    expect(agent.tools).toEqual([]);
  });

  it("rejects duplicate ids and duplicate tools", () => {
    expect(() => validateAndResolve(valid({ agents: [{ id: "same", goal: "x" }, { id: "same", goal: "y" }] }), context)).toThrow(/Duplicate/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", toolPreset: "custom", tools: ["read", "read"] }] }), context)).toThrow(/duplicates/);
  });

  it("accepts timeout values from 30 through 1800 seconds", () => {
    expect(() => validateAndResolve(valid({ timeoutSeconds: 30 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 1800 }), context)).not.toThrow();
    expect(() => validateAndResolve(valid({ timeoutSeconds: 29 }), context)).toThrow(/30 to 1800/);
    expect(() => validateAndResolve(valid({ timeoutSeconds: 1801 }), context)).toThrow(/30 to 1800/);
  });

  it("resolves per-agent timeout ahead of run default", () => {
    expect(validateAndResolve(valid(), context)[0].timeoutSeconds).toBe(180);
    expect(validateAndResolve(valid({ timeoutSeconds: 240 }), context)[0].timeoutSeconds).toBe(240);
    expect(validateAndResolve(valid({
      timeoutSeconds: 240,
      agents: [{ id: "a", goal: "x", timeoutSeconds: 45 }],
    }), context)[0].timeoutSeconds).toBe(45);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "x", timeoutSeconds: 30.5 }] }), context)).toThrow(/30 to 1800/);
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
        continuationIndex: 0,
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
      resume: { handle: "dede_handle", sessionId: "11111111-1111-4111-8111-111111111111", attempt: 1, continuationIndex: 0 },
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

  it("continues a successful child with immutable capabilities and a normal deadline", () => {
    const sourceAgent = validateAndResolve(valid({
      agents: [{ id: "old", profile: "worker", goal: "Apply the approved fix", model: "other/small" }],
    }), context)[0];
    const continuationContext: ValidationContext = {
      ...context,
      continuationLookup: (handle) => handle === "dede_continue" ? {
        handle,
        sessionId: "22222222-2222-4222-8222-222222222222",
        attempt: 0,
        continuationIndex: 2,
        agent: sourceAgent,
      } : undefined,
    };

    const [continued] = validateAndResolve({
      objective: "Fix the review finding",
      agents: [{ id: "fix-review", goal: "Revalidate the diff, fix the named finding, and run the focused test", continueFrom: "dede_continue", timeoutSeconds: 300 }],
    }, continuationContext);
    expect(continued).toMatchObject({
      id: "fix-review",
      profile: "worker",
      model: "other/small",
      mutationCapable: true,
      timeoutSeconds: 300,
      continueFrom: {
        handle: "dede_continue",
        sessionId: "22222222-2222-4222-8222-222222222222",
        continuationIndex: 3,
      },
    });
    expect(continued.resume).toBeUndefined();

    expect(() => validateAndResolve({
      objective: "continue",
      agents: [{ id: "a", goal: "x", continueFrom: "dede_continue", tools: ["read"] }],
    }, continuationContext)).toThrow(/cannot override tools/);
    expect(() => validateAndResolve({
      objective: "continue",
      agents: [{ id: "a", goal: "x", continueFrom: "dede_continue", resume: "dede_continue" }],
    }, continuationContext)).toThrow(/both resume and continueFrom/);
    expect(() => validateAndResolve({
      objective: "continue",
      agents: [
        { id: "a", goal: "x", continueFrom: "dede_continue" },
        { id: "b", goal: "y", continueFrom: "dede_continue" },
      ],
    }, continuationContext)).toThrow(/only once/);
  });

  it("accepts up to three agents and rejects a fourth", () => {
    const three = ["a", "b", "c"].map((id) => ({ id, goal: id }));
    expect(validateAndResolve(valid({ agents: three }), context)).toHaveLength(3);
    expect(() => validateAndResolve(valid({ agents: [...three, { id: "d", goal: "d" }] }), context)).toThrow(/one to 3/);
  });

  it("treats bash, edit, and write as mutation-capable, allows one worker with readers, and rejects parallel workers", () => {
    expect(isMutationCapable(["bash"])).toBe(true);
    expect(isMutationCapable(["edit"])).toBe(true);
    expect(isMutationCapable(["write"])).toBe(true);
    expect(isMutationCapable(["read", "grep"])).toBe(false);
    // One mutation-capable worker may run alongside read-only agents.
    const [worker, reader] = validateAndResolve(valid({ agents: [
      { id: "worker", profile: "worker", goal: "change it" },
      { id: "reader", profile: "scout", goal: "inspect it" },
    ] }), context);
    expect(worker.mutationCapable).toBe(true);
    expect(reader.mutationCapable).toBe(false);
    // Two concurrent writers can clobber edits, so they are rejected.
    expect(() => validateAndResolve(valid({ agents: [
      { id: "worker-a", profile: "worker", goal: "change it" },
      { id: "worker-b", profile: "worker", goal: "change it too" },
    ] }), context)).toThrow(/At most one mutation-capable agent/);
  });

  it("checks reduced UTF-8 byte limits", () => {
    expect(() => validateAndResolve(valid({ objective: "🦊".repeat(1025) }), context)).toThrow(/UTF-8 bytes/);
    expect(() => validateAndResolve(valid({ sharedContext: "界".repeat(5462) }), context)).toThrow(/UTF-8 bytes/);
    expect(() => validateAndResolve(valid({ agents: [{ id: "a", goal: "🦊".repeat(1025) }] }), context)).toThrow(/UTF-8 bytes/);
  });

  it("rejects recursive delegation", () => {
    process.env.PI_DEDE_DEPTH = "1";
    expect(() => validateAndResolve(valid(), context)).toThrow(/Recursive/);
  });

  it("allows an extension-provider model when children retain normal extension discovery", () => {
    const [agent] = validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", model: "other/small" }],
    }), {
      ...context,
      extensionProviderIds: ["other"],
    });
    expect(agent.model).toBe("other/small");
  });

  it("rejects an extension-provider model only when child discovery is disabled", () => {
    expect(() => validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", model: "other/small" }],
    }), {
      ...context,
      extensionProviderIds: ["other"],
      profileDefaults: { custom: { additionalArgs: ["--no-extensions"] } },
    })).toThrow(/Remove \"--no-extensions\"|explicitly load the provider/);
  });

  it("allows an extension-provider model when an extension is explicitly loaded in children", () => {
    const [agent] = validateAndResolve(valid({
      agents: [{ id: "a", goal: "x", model: "other/small" }],
    }), {
      ...context,
      extensionProviderIds: ["other"],
      profileDefaults: { custom: { additionalArgs: ["--no-extensions", "-e", "/tmp/provider-extension.ts"] } },
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

  it("requires an exact match when a provider is named so subagents get the requested model", () => {
    // Provider-scoped patterns must match exactly; partial substrings resolve to nothing.
    expect(resolveModelPattern("other/sma", context.models)).toBeUndefined();
    expect(resolveModelPattern("other/smallish", context.models)).toBeUndefined();
    expect(resolveModelPattern("other/missing", context.models)).toBeUndefined();
    // An explicit glob is still an intentional opt-in to fuzzy matching.
    expect(resolveModelPattern("other/sm*", context.models)?.id).toBe("small");
    // A bare name (no provider) still allows the partial fallback for convenience.
    expect(resolveModelPattern("sma", context.models)?.id).toBe("small");
  });
});

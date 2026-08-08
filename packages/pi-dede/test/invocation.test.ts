import { describe, expect, it } from "vitest";
import { buildChildInvocation } from "../src/invocation.ts";
import type { ResolvedAgent } from "../src/types.ts";

const agent = (tools: ResolvedAgent["tools"]): ResolvedAgent => ({
  id: "scout",
  profile: "scout",
  goal: "SECRET GOAL THAT MUST NOT BE IN ARGV",
  toolPreset: tools.length ? "custom" : "none",
  tools,
  additionalArgs: [],
  model: "test/model",
  thinking: "high",
  env: {},
  timeoutSeconds: 120,
  mutationCapable: tools.some((tool) => ["bash", "edit", "write"].includes(tool)),
});

const invocationOptions = {
  systemPromptPath: "/tmp/run/scout-system.md",
  sessionDirectory: "/tmp/pi-dede-sessions",
  sessionPath: "/tmp/pi-dede-sessions/child.jsonl",
  childSessionId: "11111111-1111-4111-8111-111111111111",
  runId: "run-1",
  parentSessionId: "parent-1",
};

describe("child invocation", () => {
  it("builds an isolated headless RPC command with a private resumable session", () => {
    const invocation = buildChildInvocation({
      agent: agent(["read", "grep", "find", "ls"]),
      ...invocationOptions,
      baseEnv: { PATH: process.env.PATH, PI_SESSION_ID: "secret-session", PI_SESSION_FILE: "/secret/file" },
    });
    const args = invocation.args.join(" ");
    expect(args).toContain("--mode rpc --session-dir /tmp/pi-dede-sessions --session /tmp/pi-dede-sessions/child.jsonl");
    expect(args).toContain("--no-approve --no-prompt-templates --no-themes");
    expect(args).not.toContain("--mode json");
    expect(args).not.toContain("--print");
    expect(args).not.toContain("--no-extensions");
    expect(args).not.toContain("--no-skills");
    expect(args).not.toContain("--no-context-files");
    expect(args).not.toContain("--no-session");
    expect(args).toContain("--tools read,grep,find,ls");
    expect(args).toContain("--model test/model --thinking high");
    expect(args).toContain("--append-system-prompt /tmp/run/scout-system.md");
    // The task is delivered over the RPC stdin channel, never as an argument.
    expect(args).not.toContain("@/tmp/run/scout-task.md");
    expect(args).not.toContain("Complete the delegated task");
    expect(args).not.toContain("SECRET GOAL");
    expect(invocation.env).toMatchObject({
      PI_DEDE_DEPTH: "1",
      PI_DEDE_RUN_ID: "run-1",
      PI_DEDE_AGENT_ID: "scout",
      PI_DEDE_PARENT_SESSION_ID: "parent-1",
      PI_DEDE_CHILD_SESSION_ID: "11111111-1111-4111-8111-111111111111",
      PI_DEDE_RESUME_ATTEMPT: "0",
    });
    expect(invocation.env.PI_SESSION_ID).toBeUndefined();
    expect(invocation.env.PI_SESSION_FILE).toBeUndefined();
  });

  it("overlays child environment while keeping internal variables authoritative", () => {
    const configured = {
      ...agent([]),
      env: {
        CHILD_ONLY: "yes",
        SHARED: "child",
        PI_SESSION_ID: "attacker-session",
        PI_DEDE_RUN_ID: "attacker-run",
      },
    };
    const invocation = buildChildInvocation({
      agent: configured,
      ...invocationOptions,
      baseEnv: { INHERITED_ONLY: "yes", SHARED: "parent", PI_SESSION_FILE: "/parent/session" },
    });
    expect(invocation.env).toMatchObject({
      INHERITED_ONLY: "yes",
      CHILD_ONLY: "yes",
      SHARED: "child",
      PI_DEDE_RUN_ID: "run-1",
    });
    expect(invocation.env.PI_SESSION_ID).toBeUndefined();
    expect(invocation.env.PI_SESSION_FILE).toBeUndefined();
  });

  it("reuses the exact child session and resume attempt for a short continuation", () => {
    const resumed: ResolvedAgent = {
      ...agent(["read"]),
      resume: {
        handle: "dede_handle",
        sessionId: invocationOptions.childSessionId,
        attempt: 1,
        continuationIndex: 0,
      },
      timeoutSeconds: 60,
    };
    const invocation = buildChildInvocation({ agent: resumed, ...invocationOptions });
    const args = invocation.args.join(" ");
    expect(args).toContain("--session-dir /tmp/pi-dede-sessions --session /tmp/pi-dede-sessions/child.jsonl");
    expect(invocation.env.PI_DEDE_RESUME_ATTEMPT).toBe("1");
    expect(invocation.env.PI_DEDE_CONTINUATION_INDEX).toBe("0");
  });

  it("appends configured CLI args after built-in options as the trailing arguments", () => {
    const invocation = buildChildInvocation({
      agent: agent(["read"]),
      ...invocationOptions,
      additionalArgs: ["-e", "/tmp/custom-extension.ts"],
    });
    const extensionIndex = invocation.args.indexOf("-e");
    expect(invocation.args.slice(extensionIndex, extensionIndex + 2)).toEqual(["-e", "/tmp/custom-extension.ts"]);
    expect(extensionIndex).toBeGreaterThan(invocation.args.indexOf("--no-themes"));
    // additionalArgs are the last arguments; no task message follows them.
    expect(extensionIndex).toBe(invocation.args.length - 2);
  });

  it("uses --no-tools for an empty toolset", () => {
    const invocation = buildChildInvocation({ agent: agent([]), ...invocationOptions });
    expect(invocation.args).toContain("--no-tools");
    expect(invocation.args).not.toContain("--tools");
  });
});

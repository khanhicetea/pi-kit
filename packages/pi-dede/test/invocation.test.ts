import { describe, expect, it } from "vitest";
import { buildChildInvocation } from "../src/invocation.ts";
import type { ResolvedAgent } from "../src/types.ts";

const agent = (tools: ResolvedAgent["tools"]): ResolvedAgent => ({
  id: "scout",
  profile: "scout",
  goal: "SECRET GOAL THAT MUST NOT BE IN ARGV",
  dependsOn: [],
  toolPreset: tools.length ? "custom" : "none",
  tools,
  model: "test/model",
  thinking: "high",
  timeoutSeconds: 1800,
  mutationCapable: tools.some((tool) => ["bash", "edit", "write"].includes(tool)),
});

describe("child invocation", () => {
  it("builds an isolated read-only command without task content", () => {
    const invocation = buildChildInvocation({
      agent: agent(["read", "grep", "find", "ls"]),
      systemPromptPath: "/tmp/run/scout-system.md",
      taskPath: "/tmp/run/scout-task.md",
      runId: "run-1",
      parentSessionId: "parent-1",
      baseEnv: { PATH: process.env.PATH, PI_SESSION_ID: "secret-session", PI_SESSION_FILE: "/secret/file" },
    });
    const args = invocation.args.join(" ");
    expect(args).toContain("--mode json --print --no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files");
    expect(args).toContain("--tools read,grep,find,ls");
    expect(args).toContain("--model test/model --thinking high");
    expect(args).toContain("@/tmp/run/scout-task.md");
    expect(args).not.toContain("SECRET GOAL");
    expect(invocation.env).toMatchObject({
      PI_DEDE_DEPTH: "1",
      PI_DEDE_RUN_ID: "run-1",
      PI_DEDE_AGENT_ID: "scout",
      PI_DEDE_PARENT_SESSION_ID: "parent-1",
    });
    expect(invocation.env.PI_SESSION_ID).toBeUndefined();
    expect(invocation.env.PI_SESSION_FILE).toBeUndefined();
  });

  it("uses --no-tools for an empty toolset", () => {
    const invocation = buildChildInvocation({
      agent: agent([]),
      systemPromptPath: "/tmp/system",
      taskPath: "/tmp/task",
      runId: "run",
      parentSessionId: "parent",
    });
    expect(invocation.args).toContain("--no-tools");
    expect(invocation.args).not.toContain("--tools");
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dedeExtension from "../src/index.ts";
import { ArtifactManager, ChildProcessManager, runChild } from "../src/runner.ts";
import type { ResolvedAgent } from "../src/types.ts";

const originalScript = process.argv[1];

afterEach(() => {
  process.argv[1] = originalScript;
  delete process.env.PI_DEDE_TEST_LOG;
});

const agent: ResolvedAgent = {
  id: "scout",
  profile: "scout",
  goal: "inspect",
  dependsOn: [],
  toolPreset: "read-only",
  tools: ["read", "grep", "find", "ls"],
  model: "fake/model",
  thinking: "low",
  timeoutSeconds: 1800,
  mutationCapable: false,
};

describe("fake Pi integration", () => {
  it("waits for dependencies and passes their final results to the dependent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-workflow-"));
    const fake = join(directory, "fake-pi.mjs");
    const logPath = join(directory, "events.jsonl");
    await writeFile(fake, `
      import { appendFileSync, readFileSync } from "node:fs";
      const id = process.env.PI_DEDE_AGENT_ID;
      const taskArg = process.argv.find((arg) => arg.startsWith("@"));
      const task = readFileSync(taskArg.slice(1), "utf8");
      const log = (event) => appendFileSync(process.env.PI_DEDE_TEST_LOG, JSON.stringify({ id, event, task }) + "\\n");
      log("start");
      if (id === "source") await new Promise((resolve) => setTimeout(resolve, 75));
      log("end");
      const text = id === "source"
        ? "preamble\\n## Summary\\nSOURCE FINAL RESULT\\n## Evidence\\nDETAILS MUST BE FILTERED"
        : "DEPENDENT SAW SOURCE: " + (
          task.includes("SOURCE FINAL RESULT") &&
          task.includes("mode=summary") &&
          !task.includes("DETAILS MUST BE FILTERED") &&
          !task.includes("preamble")
        );
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text }], provider: "fake", model: "model",
        responseId: id, timestamp: Date.now(), stopReason: "stop", usage
      }}));
      console.log(JSON.stringify({ type: "agent_end" }));
    `);

    process.argv[1] = fake;
    process.env.PI_DEDE_TEST_LOG = logPath;
    let tool: any;
    let shutdown: any;
    dedeExtension({
      registerTool(value: any) { tool = value; },
      on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: directory,
      model: { provider: "fake", id: "model" },
      thinkingLevel: "low",
      modelRegistry: {
        getAll: () => [{ provider: "fake", id: "model" }],
        getRegisteredProviderIds: () => [],
      },
      sessionManager: { getSessionId: () => "parent" },
      isProjectTrusted: () => false,
      ui: { setStatus: () => undefined },
    };

    try {
      const result = await tool.execute("call", {
        objective: "Run a dependency workflow",
        agents: [
          {
            id: "dependent",
            goal: "Use the source result",
            dependsOn: ["source"],
            toolPreset: "none",
            model: "fake/model",
            thinking: "low",
            timeoutSeconds: 30,
            dependencyContext: { mode: "summary", maxBytes: 4096 },
          },
          { id: "source", goal: "Produce the source result", toolPreset: "none", model: "fake/model", thinking: "low" },
        ],
        timeoutSeconds: 1800,
      }, undefined, undefined, ctx);

      expect(result.details.results.map((child: any) => child.id)).toEqual(["dependent", "source"]);
      expect(result.details.results[0]).toMatchObject({ status: "succeeded", dependsOn: ["source"], finalText: "DEPENDENT SAW SOURCE: true" });
      const logged = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(logged.map(({ id, event }: any) => `${id}:${event}`)).toEqual([
        "source:start", "source:end", "dependent:start", "dependent:end",
      ]);
      const dependentTask = logged.find((entry: any) => entry.id === "dependent" && entry.event === "start").task;
      expect(dependentTask).toContain("SOURCE FINAL RESULT");
      expect(dependentTask).toContain("kept 30/76 UTF-8 bytes");
      expect(dependentTask).not.toContain("DETAILS MUST BE FILTERED");
    } finally {
      await shutdown?.({}, ctx);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces the supplied child timeout and releases process tracking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-timeout-"));
    const fake = join(directory, "fake-pi.mjs");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    await writeFile(system, "system");
    await writeFile(task, "task");
    await writeFile(fake, "setInterval(() => undefined, 1000);\n");

    process.argv[1] = fake;
    const manager = new ChildProcessManager();
    const artifacts = new ArtifactManager("timeout-session");
    try {
      const { result } = await runChild({
        agent: { ...agent, timeoutSeconds: 0.02 },
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        runId: "timeout-run",
        parentSessionId: "parent",
        timeoutSeconds: 0.02,
        manager,
        artifacts,
      });
      expect(result).toMatchObject({
        status: "timed_out",
        errorMessage: "Timed out after 0.02 seconds",
      });
      expect(manager.size).toBe(0);
    } finally {
      await manager.killAll();
      await artifacts.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a child, parses JSON events, and accounts for usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-fake-"));
    const fake = join(directory, "fake-pi.mjs");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    await writeFile(system, "system");
    await writeFile(task, "task");
    await writeFile(fake, `
      const usage = { input: 12, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 20,
        cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .02, total: .33 } };
      console.log(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } }));
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "## Summary\\nDone" }],
        provider: "fake", model: "model", responseId: "one", timestamp: Date.now(), stopReason: "stop", usage
      }}));
      console.log(JSON.stringify({ type: "agent_end" }));
    `);

    process.argv[1] = fake;
    const manager = new ChildProcessManager();
    const artifacts = new ArtifactManager("test-session");
    try {
      const { result, detailedUsage } = await runChild({
        agent,
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        runId: "run",
        parentSessionId: "parent",
        timeoutSeconds: 1800,
        manager,
        artifacts,
      });
      expect(result.status).toBe("succeeded");
      expect(result.finalText).toBe("## Summary\nDone");
      expect(result.finalText).not.toContain("secret");
      expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(result.usage).toMatchObject({ input: 12, output: 5, cost: 0.33, turns: 1 });
      expect(detailedUsage.cost.total).toBe(0.33);
      expect(manager.size).toBe(0);
    } finally {
      await artifacts.cleanup();
      await manager.killAll();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

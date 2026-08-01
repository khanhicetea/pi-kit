import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dedeExtension from "../src/index.ts";
import { ArtifactManager, ChildProcessManager, runChild } from "../src/runner.ts";
import type { ResolvedAgent } from "../src/types.ts";

const originalScript = process.argv[1];

afterEach(() => {
  process.argv[1] = originalScript;
  delete process.env.DEDE_TEST_LOG;
});

const agent: ResolvedAgent = {
  id: "scout",
  profile: "scout",
  goal: "inspect",
  toolPreset: "read-only",
  tools: ["read", "grep", "find", "ls"],
  model: "fake/model",
  thinking: "low",
  env: {},
  timeoutSeconds: 120,
  mutationCapable: false,
};

describe("fake Pi integration", () => {
  it("runs independent evidence agents in parallel without forwarding sibling output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-parallel-"));
    const fake = join(directory, "fake-pi.mjs");
    const logPath = join(directory, "events.jsonl");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent-home");
    await writeFile(fake, `
      import { appendFileSync, readFileSync } from "node:fs";
      const id = process.env.PI_DEDE_AGENT_ID;
      const taskArg = process.argv.find((arg) => arg.startsWith("@"));
      const task = readFileSync(taskArg.slice(1), "utf8");
      const log = (event) => appendFileSync(process.env.DEDE_TEST_LOG, JSON.stringify({
        id, event, task, childScope: process.env.CHILD_SCOPE
      }) + "\\n");
      log("start");
      if (id === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
      log("end");
      const text = "## Answer\\n- " + id.toUpperCase() + " RESULT";
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      console.log(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text }], provider: "fake", model: "model",
        responseId: id, timestamp: Date.now(), stopReason: "stop", usage
      }}));
      console.log(JSON.stringify({ type: "agent_end" }));
    `);

    process.argv[1] = fake;
    process.env.DEDE_TEST_LOG = logPath;
    let tool: any;
    let shutdown: any;
    dedeExtension({
      registerTool(value: any) { tool = value; },
      on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: directory,
      model: { provider: "fake", id: "model" },
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
        objective: "Collect independent evidence for a master-owned decision",
        sharedContext: "Inspect only the assigned question.",
        agents: [
          {
            id: "slow",
            profile: "scout",
            goal: "Answer bounded question A and stop",
            toolPreset: "none",
            model: "fake/model",
            env: { CHILD_SCOPE: "slow-only" },
          },
          {
            id: "fast",
            profile: "scout",
            goal: "Answer bounded question B and stop",
            toolPreset: "none",
            model: "fake/model",
            env: { CHILD_SCOPE: "fast-only" },
          },
        ],
      }, undefined, undefined, ctx);

      expect(result.details.version).toBe(2);
      expect(result.details.results.map((child: any) => child.id)).toEqual(["slow", "fast"]);
      expect(result.details.results.every((child: any) => child.status === "succeeded" && child.timeoutSeconds === 120)).toBe(true);
      expect(result.details.results.every((child: any) => /^[0-9a-f-]{36}$/.test(child.sessionId))).toBe(true);
      expect(result.content[0].text).toContain(`pi --session ${result.details.results[0].sessionId}`);
      const logged = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const events = logged.map(({ id, event }: any) => `${id}:${event}`);
      expect(events.indexOf("fast:start")).toBeLessThan(events.indexOf("slow:end"));
      expect(logged.find((entry: any) => entry.id === "slow" && entry.event === "start").childScope).toBe("slow-only");
      expect(logged.find((entry: any) => entry.id === "fast" && entry.event === "start").childScope).toBe("fast-only");
      expect(result.details.results[0].env).toBeUndefined();
      const fastTask = logged.find((entry: any) => entry.id === "fast" && entry.event === "start").task;
      expect(fastTask).not.toContain("SLOW RESULT");
      expect(fastTask).toContain("# Your bounded assignment");
    } finally {
      await shutdown?.({}, ctx);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes the same persistent child conversation after a timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-resume-"));
    const fake = join(directory, "fake-pi.mjs");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent-home");
    await writeFile(fake, `
      import { existsSync, writeFileSync } from "node:fs";
      const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
      const sessionPath = value("--session");
      const state = sessionPath + ".state";
      if (!existsSync(state)) {
        writeFileSync(state, "evidence collected before timeout");
        setInterval(() => undefined, 1000);
      } else {
        const usage = { input: 2, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        console.log(JSON.stringify({ type: "message_end", message: {
          role: "assistant", content: [{ type: "text", text: "## Answer\\n- reused old session evidence" }],
          provider: "fake", model: "model", responseId: "resume", timestamp: Date.now(), stopReason: "stop", usage
        }}));
        console.log(JSON.stringify({ type: "agent_end" }));
      }
    `);

    process.argv[1] = fake;
    let tool: any;
    let shutdown: any;
    dedeExtension({
      registerTool(value: any) { tool = value; },
      on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: directory,
      model: { provider: "fake", id: "model" },
      modelRegistry: {
        getAll: () => [{ provider: "fake", id: "model" }],
        getRegisteredProviderIds: () => [],
      },
      sessionManager: { getSessionId: () => "resume-parent" },
      isProjectTrusted: () => false,
      ui: { setStatus: () => undefined },
    };

    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      nativeSetTimeout(handler, Math.min(timeout ?? 0, 150), ...args)) as typeof setTimeout);

    try {
      const first = await tool.execute("first", {
        objective: "Collect one bounded fact",
        agents: [{
          id: "slow",
          profile: "scout",
          goal: "Collect the fact and return it",
          toolPreset: "none",
          model: "fake/model",
          timeoutSeconds: 30,
        }],
      }, undefined, undefined, ctx);
      const timedOut = first.details.results[0];
      expect(timedOut).toMatchObject({ status: "timed_out", timeoutSeconds: 30 });
      expect(timedOut.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(timedOut.resumeHandle).toMatch(/^dede_/);
      expect(first.content[0].text).toContain(`"resume": "${timedOut.resumeHandle}"`);

      const resumed = await tool.execute("resume", {
        objective: "Finish the answer from existing evidence",
        agents: [{
          id: "finish",
          goal: "Return the already collected fact and stop",
          resume: timedOut.resumeHandle,
          timeoutSeconds: 30,
        }],
      }, undefined, undefined, ctx);
      expect(resumed.details.results[0]).toMatchObject({
        id: "finish",
        status: "succeeded",
        resumedFrom: timedOut.resumeHandle,
        sessionId: timedOut.sessionId,
        finalText: "## Answer\n- reused old session evidence",
      });

      await expect(tool.execute("used", {
        objective: "Do not reuse consumed handles",
        agents: [{ id: "again", goal: "finish", resume: timedOut.resumeHandle }],
      }, undefined, undefined, ctx)).rejects.toThrow(/unavailable, expired, or already in use/);
    } finally {
      timeoutSpy.mockRestore();
      await shutdown?.({}, ctx);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
        sessionDirectory: directory,
        sessionPath: join(directory, "timeout-session.jsonl"),
        childSessionId: "11111111-1111-4111-8111-111111111111",
        runId: "timeout-run",
        parentSessionId: "parent",
        timeoutSeconds: 0.02,
        manager,
        artifacts,
      });
      expect(result).toMatchObject({
        status: "timed_out",
        timeoutSeconds: 0.02,
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
        role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "## Answer\\n- Done" }],
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
        sessionDirectory: directory,
        sessionPath: join(directory, "success-session.jsonl"),
        childSessionId: "22222222-2222-4222-8222-222222222222",
        runId: "run",
        parentSessionId: "parent",
        timeoutSeconds: 120,
        manager,
        artifacts,
      });
      expect(result.status).toBe("succeeded");
      expect(result.finalText).toBe("## Answer\n- Done");
      expect(result.finalText).not.toContain("secret");
      expect(result.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(result.timeoutSeconds).toBe(120);
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

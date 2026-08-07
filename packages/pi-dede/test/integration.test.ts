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
  additionalArgs: [],
  model: "fake/model",
  thinking: "low",
  env: {},
  timeoutSeconds: 120,
  mutationCapable: false,
};

// Reads RPC commands (LF-delimited JSON) from stdin and invokes onCommand for each.
const RPC_READER = `
let __buf = "";
process.stdin.setEncoding("utf8");
function __send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (chunk) => {
  __buf += chunk;
  let i;
  while ((i = __buf.indexOf("\\n")) >= 0) {
    const line = __buf.slice(0, i).replace(/\\r$/, "");
    __buf = __buf.slice(i + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    onCommand(cmd);
  }
});`;

describe("fake Pi integration", () => {
  it("runs independent evidence agents in parallel without forwarding sibling output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-parallel-"));
    const fake = join(directory, "fake-pi.mjs");
    const logPath = join(directory, "events.jsonl");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(directory, "agent-home");
    await writeFile(fake, `
      import { appendFileSync } from "node:fs";
      ${RPC_READER}
      function onCommand(cmd) {
        if (cmd.type !== "prompt") return;
        const id = process.env.PI_DEDE_AGENT_ID;
        appendFileSync(process.env.DEDE_TEST_LOG, JSON.stringify({
          id, event: "start", task: cmd.message, childScope: process.env.CHILD_SCOPE
        }) + "\\n");
        __send({ type: "response", command: "prompt", id: cmd.id, success: true });
        setTimeout(() => {
          appendFileSync(process.env.DEDE_TEST_LOG, JSON.stringify({ id, event: "end" }) + "\\n");
          const text = "## Answer\\n- " + id.toUpperCase() + " RESULT";
          const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          __send({ type: "message_end", message: {
            role: "assistant", content: [{ type: "text", text }], provider: "fake", model: "model",
            responseId: id, timestamp: Date.now(), stopReason: "stop", usage
          }});
          __send({ type: "agent_end" });
          __send({ type: "agent_settled" });
        }, id === "slow" ? 250 : 0);
      }
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
      expect(result.details.results.every((child: any) => child.status === "succeeded" && child.timeoutSeconds === 180)).toBe(true);
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
      ${RPC_READER}
      function onCommand(cmd) {
        if (cmd.type !== "prompt") return;
        __send({ type: "response", command: "prompt", id: cmd.id, success: true });
        const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
        const sessionPath = value("--session");
        const state = sessionPath + ".state";
        if (!existsSync(state)) {
          writeFileSync(state, "evidence collected before timeout");
          setInterval(() => undefined, 1000);
        } else {
          const usage = { input: 2, output: 1, cacheRead: 1, cacheWrite: 0, totalTokens: 4,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          __send({ type: "message_end", message: {
            role: "assistant", content: [{ type: "text", text: "## Answer\\n- reused old session evidence" }],
            provider: "fake", model: "model", responseId: "resume", timestamp: Date.now(), stopReason: "stop", usage
          }});
          __send({ type: "agent_end" });
          __send({ type: "agent_settled" });
        }
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
    // Bare hang: never reads stdin, never settles.
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

  it("runs a child over RPC, parses JSON events, and accounts for usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-fake-"));
    const fake = join(directory, "fake-pi.mjs");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    await writeFile(system, "system");
    await writeFile(task, "task");
    await writeFile(fake, `
      ${RPC_READER}
      function onCommand(cmd) {
        if (cmd.type !== "prompt") return;
        __send({ type: "response", command: "prompt", id: cmd.id, success: true });
        const usage = { input: 12, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 20,
          cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: .02, total: .33 } };
        __send({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
        __send({ type: "message_end", message: {
          role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "## Answer\\n- Done" }],
          provider: "fake", model: "model", responseId: "one", timestamp: Date.now(), stopReason: "stop", usage
        }});
        __send({ type: "agent_end" });
        __send({ type: "agent_settled" });
      }
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

  it("steers a child toward a soft deadline before hard-terminating", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-steer-"));
    const fake = join(directory, "fake-pi.mjs");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    const steerLog = join(directory, "commands.log");
    await writeFile(system, "system");
    await writeFile(task, "task");
    // Responds to the prompt, then heeds a `steer` by finishing immediately.
    await writeFile(fake, `
      import { appendFileSync } from "node:fs";
      ${RPC_READER}
      function onCommand(cmd) {
        appendFileSync(process.env.DEDE_STEER_LOG, cmd.type + "\\n");
        if (cmd.type === "prompt") {
          __send({ type: "response", command: "prompt", id: cmd.id, success: true });
        } else if (cmd.type === "steer") {
          const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          __send({ type: "message_end", message: {
            role: "assistant", content: [{ type: "text", text: "## Answer\\n- heeded the deadline warning" }],
            provider: "fake", model: "model", responseId: "steered", timestamp: Date.now(), stopReason: "stop", usage
          }});
          __send({ type: "agent_end" });
          __send({ type: "agent_settled" });
        }
      }
    `);

    process.argv[1] = fake;
    process.env.DEDE_STEER_LOG = steerLog;
    const manager = new ChildProcessManager();
    const artifacts = new ArtifactManager("steer-session");

    try {
      const { result } = await runChild({
        agent: { ...agent, timeoutSeconds: 30 },
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        sessionDirectory: directory,
        sessionPath: join(directory, "steer-session.jsonl"),
        childSessionId: "33333333-3333-4333-8333-333333333333",
        runId: "steer-run",
        parentSessionId: "parent",
        timeoutSeconds: 30,
        manager,
        artifacts,
      });
      // The steer saved the child from a hard timeout.
      expect(result.status).toBe("succeeded");
      expect(result.finalText).toBe("## Answer\n- heeded the deadline warning");
      const commands = (await readFile(steerLog, "utf8")).trim().split("\n");
      expect(commands).toContain("prompt");
      expect(commands).toContain("steer");
      expect(commands.indexOf("steer")).toBeGreaterThan(commands.indexOf("prompt"));
      expect(manager.size).toBe(0);
    } finally {
      delete process.env.DEDE_STEER_LOG;
      await artifacts.cleanup();
      await manager.killAll();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);

  it("auto-cancels an extension UI dialog so a child can never block on a human", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-ui-"));
    const fake = join(directory, "fake-pi.mjs");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    const uiLog = join(directory, "ui.log");
    await writeFile(system, "system");
    await writeFile(task, "task");
    // Emits a dialog request, then finishes only once the master auto-cancels it.
    // Without auto-cancel the child would wait forever for a human and time out.
    await writeFile(fake, `
      import { appendFileSync } from "node:fs";
      ${RPC_READER}
      function onCommand(cmd) {
        if (cmd.type === "prompt") {
          __send({ type: "response", command: "prompt", id: cmd.id, success: true });
          __send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "ok?" });
        } else if (cmd.type === "extension_ui_response") {
          appendFileSync(process.env.DEDE_UI_LOG, JSON.stringify(cmd) + "\\n");
          if (cmd.cancelled) {
            const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
            __send({ type: "message_end", message: {
              role: "assistant", content: [{ type: "text", text: "## Answer\\n- proceeded after auto-cancel" }],
              provider: "fake", model: "model", responseId: "ui", timestamp: Date.now(), stopReason: "stop", usage
            }});
            __send({ type: "agent_end" });
            __send({ type: "agent_settled" });
          }
        }
      }
    `);

    process.argv[1] = fake;
    process.env.DEDE_UI_LOG = uiLog;
    const manager = new ChildProcessManager();
    const artifacts = new ArtifactManager("ui-session");
    try {
      const { result } = await runChild({
        agent: { ...agent, timeoutSeconds: 10 },
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        sessionDirectory: directory,
        sessionPath: join(directory, "ui-session.jsonl"),
        childSessionId: "44444444-4444-4444-8444-444444444444",
        runId: "ui-run",
        parentSessionId: "parent",
        timeoutSeconds: 10,
        manager,
        artifacts,
      });
      // The dialog was auto-cancelled, so the child proceeded instead of hanging.
      expect(result.status).toBe("succeeded");
      expect(result.finalText).toBe("## Answer\n- proceeded after auto-cancel");
      const responses = (await readFile(uiLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(responses[0]).toMatchObject({ type: "extension_ui_response", id: "ui-1", cancelled: true });
      expect(manager.size).toBe(0);
    } finally {
      delete process.env.DEDE_UI_LOG;
      await artifacts.cleanup();
      await manager.killAll();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

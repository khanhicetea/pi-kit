import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdrLayout, isInsideHerdr } from "../src/herdr.ts";
import { ArtifactManager, ChildProcessManager, runChild } from "../src/runner.ts";
import type { ResolvedAgent } from "../src/types.ts";

const originalScript = process.argv[1];
const originalHerdr = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_TAB_ID: process.env.HERDR_TAB_ID,
  HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
};

afterEach(() => {
  process.argv[1] = originalScript;
  for (const [name, value] of Object.entries(originalHerdr)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.DEDE_HERDR_LOG;
  delete process.env.DEDE_HANG;
  delete process.env.DEDE_HERDR_PANE_OUTPUT;
  delete process.env.DEDE_HERDR_NEXT_PANE;
});

const agent: ResolvedAgent = {
  id: "pane-scout",
  profile: "scout",
  goal: "inspect",
  toolPreset: "none",
  tools: [],
  additionalArgs: [],
  model: "fake/model",
  thinking: "low",
  env: {},
  timeoutSeconds: 10,
  mutationCapable: false,
};

describe("Herdr child transport", () => {
  it("requires both the Herdr marker and current pane id", () => {
    expect(isInsideHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })).toBe(true);
    expect(isInsideHerdr({ HERDR_ENV: "1" })).toBe(false);
    expect(isInsideHerdr({ HERDR_PANE_ID: "w1:p1" })).toBe(false);
  });

  it("runs the existing JSON child protocol through a Herdr child pane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-herdr-"));
    const fakePi = join(directory, "fake-pi.mjs");
    const fakeHerdr = join(directory, "fake-herdr.mjs");
    const logPath = join(directory, "herdr.jsonl");
    const paneOutputPath = join(directory, "pane-output.log");
    const system = join(directory, "system.md");
    const task = join(directory, "task.md");
    await Promise.all([
      writeFile(system, "system"),
      writeFile(task, "task"),
      writeFile(fakePi, `
        if (process.env.DEDE_HANG === "1") await new Promise(() => setInterval(() => {}, 1000));
        const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/example.ts", offset: 10, limit: 20 } }));
        console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false }));
        console.log(JSON.stringify({ type: "message_end", message: {
          role: "assistant", content: [{ type: "text", text: "## Answer\\n- visible pane result" }],
          provider: "fake", model: "model", timestamp: Date.now(), stopReason: "stop", usage
        }}));
        console.log(JSON.stringify({ type: "agent_end" }));
      `),
      writeFile(fakeHerdr, `#!/usr/bin/env node
        import { appendFileSync, openSync, readFileSync } from "node:fs";
        import { spawn } from "node:child_process";
        const args = process.argv.slice(2);
        appendFileSync(process.env.DEDE_HERDR_LOG, JSON.stringify(args) + "\\n");
        if (args[0] === "pane" && args[1] === "split") {
          const history = readFileSync(process.env.DEDE_HERDR_LOG, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
          const paneId = "w1:p" + (history.filter((entry) => entry[0] === "pane" && entry[1] === "split").length + 1);
          console.log(JSON.stringify({ result: { pane: { pane_id: paneId } } }));
        } else if (args[0] === "pane" && args[1] === "run") {
          const paneId = args[2];
          const output = openSync(process.env.DEDE_HERDR_PANE_OUTPUT, "a");
          const child = spawn("/bin/sh", ["-lc", args[3]], {
            detached: true,
            stdio: ["ignore", output, output],
            env: {
              ...process.env,
              HERDR_ENV: "1",
              HERDR_PANE_ID: paneId,
              HERDR_TAB_ID: "w1:t1",
              HERDR_WORKSPACE_ID: "w1",
            },
          });
          child.unref();
          console.log(JSON.stringify({ result: { pane_id: paneId } }));
        } else if (args[0] === "pane" && args[1] === "close") {
          console.log(JSON.stringify({ result: {} }));
        } else {
          console.log(JSON.stringify({ result: {} }));
        }
      `),
    ]);
    await chmod(fakeHerdr, 0o700);

    process.argv[1] = fakePi;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.HERDR_TAB_ID = "w1:t1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_BIN_PATH = fakeHerdr;
    process.env.DEDE_HERDR_LOG = logPath;
    process.env.DEDE_HERDR_PANE_OUTPUT = paneOutputPath;

    const manager = new ChildProcessManager();
    const artifacts = new ArtifactManager("herdr-test");
    try {
      const { result } = await runChild({
        agent,
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        sessionDirectory: directory,
        sessionPath: join(directory, "child.jsonl"),
        childSessionId: "33333333-3333-4333-8333-333333333333",
        runId: "herdr-run",
        parentSessionId: "parent",
        timeoutSeconds: 10,
        manager,
        artifacts,
      });

      expect(result).toMatchObject({
        status: "succeeded",
        finalText: "## Answer\n- visible pane result",
        exitCode: 0,
      });
      const commands = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const horizontalSplit = commands.find((args) =>
        args[0] === "pane" && args[1] === "split" && args.includes("down"),
      );
      expect(horizontalSplit).toEqual([
        "pane", "split", "w1:p1", "--direction", "down", "--cwd", directory, "--no-focus",
      ]);
      expect(commands.some((args) => args[0] === "tab" && args[1] === "create")).toBe(false);
      expect(commands.some((args) =>
        args[0] === "pane" && args[1] === "split" && args.includes("right"),
      )).toBe(false);
      expect(commands.some((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p2")).toBe(true);
      const paneOutput = await readFile(paneOutputPath, "utf8");
      expect(paneOutput).toContain("→ read src/example.ts:10-29");
      expect(paneOutput.match(/read src\/example\.ts/g)).toHaveLength(1);

      const layout = createHerdrLayout(directory, 2);
      expect(layout).toBeDefined();
      const firstPane = await layout!.allocate();
      expect(firstPane?.paneId).toBe("w1:p3");
      await firstPane?.release();
      const secondPane = await layout!.allocate();
      expect(secondPane?.paneId).toBe("w1:p4");
      const layoutCommands = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(layoutCommands.some((args) =>
        args[0] === "pane" && args[1] === "split" && args.includes("right"),
      )).toBe(true);
      await secondPane?.release();
      await firstPane?.release();

      process.env.DEDE_HANG = "1";
      const timedOut = await runChild({
        agent: { ...agent, timeoutSeconds: 0.1 },
        cwd: directory,
        systemPromptPath: system,
        taskPath: task,
        sessionDirectory: directory,
        sessionPath: join(directory, "timeout-child.jsonl"),
        childSessionId: "44444444-4444-4444-8444-444444444444",
        runId: "herdr-timeout-run",
        parentSessionId: "parent",
        timeoutSeconds: 0.1,
        manager,
        artifacts,
      });
      expect(timedOut.result).toMatchObject({
        status: "timed_out",
        errorMessage: "Timed out after 0.1 seconds",
      });
      expect(manager.size).toBe(0);
    } finally {
      await manager.killAll();
      await artifacts.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

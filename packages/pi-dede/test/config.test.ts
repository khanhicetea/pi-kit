import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDedeConfigPaths, loadDedeConfig, loadProfileDefaults } from "../src/config.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const directories: string[] = [];

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<{ cwd: string; globalPath: string; projectPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-dede-config-"));
  directories.push(root);
  const cwd = join(root, "project");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const paths = getDedeConfigPaths(cwd);
  await mkdir(dirname(paths.global), { recursive: true });
  await mkdir(dirname(paths.project), { recursive: true });
  return { cwd, globalPath: paths.global, projectPath: paths.project };
}

describe("profile default configuration", () => {
  it("loads global defaults and merges trusted project overrides by field", async () => {
    const { cwd, globalPath, projectPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: {
      scout: { model: " global/scout ", thinking: "low", env: { GLOBAL_ONLY: "yes", SHARED: "global" }, additionalArgs: ["-e", "/global/scout.ts"] },
      custom: { thinking: "minimal" },
      reviewer: { model: "global/reviewer", thinking: "medium" },
    } }));
    await writeFile(projectPath, JSON.stringify({ profiles: {
      scout: { thinking: "high", env: { PROJECT_ONLY: "yes", SHARED: "project" }, additionalArgs: ["-e", "/project/scout.ts"] },
      custom: { model: "project/custom" },
      worker: { model: "project/worker" },
    } }));

    await expect(loadProfileDefaults(cwd, true)).resolves.toEqual({
      scout: {
        model: "global/scout",
        thinking: "high",
        env: { GLOBAL_ONLY: "yes", SHARED: "project", PROJECT_ONLY: "yes" },
        additionalArgs: ["-e", "/project/scout.ts"],
      },
      reviewer: { model: "global/reviewer", thinking: "medium" },
      worker: { model: "project/worker" },
      custom: { model: "project/custom", thinking: "minimal" },
    });
  });

  it("ignores project configuration when the project is not trusted", async () => {
    const { cwd, globalPath, projectPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { thinking: "low", env: { SOURCE: "global" } } } }));
    await writeFile(projectPath, JSON.stringify({ profiles: { scout: { thinking: "max", env: { SOURCE: "project" } } } }));

    await expect(loadProfileDefaults(cwd, false)).resolves.toEqual({
      scout: { thinking: "low", env: { SOURCE: "global" } },
    });
  });

  it("returns no defaults when configuration files do not exist", async () => {
    const { cwd } = await setup();
    await expect(loadProfileDefaults(cwd, true)).resolves.toEqual({});
  });

  it("loads additional child CLI args with trusted project override", async () => {
    const { cwd, globalPath, projectPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ additionalArgs: ["-e", "/global/ext.ts"] }));
    await writeFile(projectPath, JSON.stringify({ additionalArgs: ["-e", "/project/ext.ts"] }));

    await expect(loadDedeConfig(cwd, true)).resolves.toEqual({
      profiles: {},
      additionalArgs: ["-e", "/project/ext.ts"],
    });
    await expect(loadDedeConfig(cwd, false)).resolves.toEqual({
      profiles: {},
      additionalArgs: ["-e", "/global/ext.ts"],
    });
  });

  it("supports profile additional child CLI args", async () => {
    const { cwd, globalPath } = await setup();
    await writeFile(globalPath, JSON.stringify({
      additionalArgs: ["--global-arg"],
      profiles: {
        scout: { additionalArgs: ["-e", "/scout/ext.ts"] },
        reviewer: { additionalArgs: [] },
      },
    }));

    await expect(loadDedeConfig(cwd, false)).resolves.toEqual({
      profiles: {
        scout: { additionalArgs: ["-e", "/scout/ext.ts"] },
        reviewer: { additionalArgs: [] },
      },
      additionalArgs: ["--global-arg"],
    });
  });

  it("validates additional child CLI args", async () => {
    const { cwd, globalPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ additionalArgs: "-e /tmp/ext.ts" }));
    await expect(loadDedeConfig(cwd, false)).rejects.toThrow(/additionalArgs must be an array/);

    await writeFile(globalPath, JSON.stringify({ additionalArgs: ["-e", 42] }));
    await expect(loadDedeConfig(cwd, false)).rejects.toThrow(/additionalArgs\[1\] must be a string/);

    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { additionalArgs: ["-e", 42] } } }));
    await expect(loadDedeConfig(cwd, false)).rejects.toThrow(/profiles\.scout\.additionalArgs\[1\] must be a string/);
  });

  it("rejects malformed and unknown configuration values with the file path", async () => {
    const { cwd, globalPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { thinking: "huge" } } }));
    await expect(loadProfileDefaults(cwd, false)).rejects.toThrow(new RegExp(`${globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*thinking`));

    await writeFile(globalPath, JSON.stringify({ profiles: { architect: { thinking: "low" } } }));
    await expect(loadProfileDefaults(cwd, false)).rejects.toThrow(/unknown field: architect/);
  });

  it("validates configured environment maps without exposing values", async () => {
    const { cwd, globalPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { env: { TOKEN: 42 } } } }));
    await expect(loadProfileDefaults(cwd, false)).rejects.toThrow(/\.env\.TOKEN must be a string/);

    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { env: { NODE_OPTIONS: "secret-sentinel" } } } }));
    try {
      await loadProfileDefaults(cwd, false);
      throw new Error("expected protected environment rejection");
    } catch (error) {
      expect(String(error)).toContain("protected variable: NODE_OPTIONS");
      expect(String(error)).not.toContain("secret-sentinel");
    }

    await writeFile(globalPath, "{\"profiles\":{\"scout\":{\"env\":{\"TOKEN\":secret-sentinel}}}}");
    try {
      await loadProfileDefaults(cwd, false);
      throw new Error("expected malformed JSON rejection");
    } catch (error) {
      expect(String(error)).toContain("invalid JSON");
      expect(String(error)).not.toContain("secret-sentinel");
    }
  });
});

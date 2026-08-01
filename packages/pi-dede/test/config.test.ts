import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDedeConfigPaths, loadProfileDefaults } from "../src/config.ts";

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
      scout: { model: " global/scout ", thinking: "low" },
      planner: { thinking: "medium" },
      reviewer: { model: "global/reviewer", thinking: "medium" },
    } }));
    await writeFile(projectPath, JSON.stringify({ profiles: {
      scout: { thinking: "high" },
      planner: { model: "project/planner" },
      worker: { model: "project/worker" },
    } }));

    await expect(loadProfileDefaults(cwd, true)).resolves.toEqual({
      scout: { model: "global/scout", thinking: "high" },
      planner: { model: "project/planner", thinking: "medium" },
      reviewer: { model: "global/reviewer", thinking: "medium" },
      worker: { model: "project/worker" },
    });
  });

  it("ignores project configuration when the project is not trusted", async () => {
    const { cwd, globalPath, projectPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { thinking: "low" } } }));
    await writeFile(projectPath, JSON.stringify({ profiles: { scout: { thinking: "max" } } }));

    await expect(loadProfileDefaults(cwd, false)).resolves.toEqual({ scout: { thinking: "low" } });
  });

  it("returns no defaults when configuration files do not exist", async () => {
    const { cwd } = await setup();
    await expect(loadProfileDefaults(cwd, true)).resolves.toEqual({});
  });

  it("rejects malformed and unknown configuration values with the file path", async () => {
    const { cwd, globalPath } = await setup();
    await writeFile(globalPath, JSON.stringify({ profiles: { scout: { thinking: "huge" } } }));
    await expect(loadProfileDefaults(cwd, false)).rejects.toThrow(new RegExp(`${globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*thinking`));

    await writeFile(globalPath, JSON.stringify({ profiles: { architect: { thinking: "low" } } }));
    await expect(loadProfileDefaults(cwd, false)).rejects.toThrow(/unknown field: architect/);
  });
});

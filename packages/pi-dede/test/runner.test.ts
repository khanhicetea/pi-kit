import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ArtifactManager, createSecureRunDirectory, removeRunDirectory, truncateUtf8, writeSecurePrompt } from "../src/runner.ts";

describe("runner utilities", () => {
  it("creates mode-0700 directories and mode-0600 prompt files", async () => {
    const directory = await createSecureRunDirectory("test");
    try {
      const prompt = await writeSecurePrompt(directory, "agent-task.md", "secret");
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(prompt)).mode & 0o777).toBe(0o600);
    } finally {
      await removeRunDirectory(directory);
    }
    await expect(stat(directory)).rejects.toThrow();
  });

  it("shares artifact initialization and drains writes during cleanup", async () => {
    const artifacts = new ArtifactManager("parallel");
    const writes = [artifacts.write("run", "one", "first"), artifacts.write("run", "two", "second")];
    const paths = await Promise.all(writes);
    expect(paths[0].slice(0, paths[0].lastIndexOf("/"))).toBe(paths[1].slice(0, paths[1].lastIndexOf("/")));
    expect(await readFile(paths[0], "utf8")).toBe("first");
    const pending = artifacts.write("run", "three", "third");
    const cleanup = artifacts.cleanup();
    const third = await pending;
    await cleanup;
    for (const path of [...paths, third]) await expect(stat(path)).rejects.toThrow();
    await expect(artifacts.write("run", "late", "no")).rejects.toThrow(/shut down/);
  });

  it("truncates on UTF-8 boundaries", () => {
    const result = truncateUtf8("a🦊b", 3);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a");
    expect(result.text).not.toContain("�");
  });
});

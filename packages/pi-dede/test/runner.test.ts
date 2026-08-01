import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSecureRunDirectory, removeRunDirectory, truncateUtf8, writeSecurePrompt } from "../src/runner.ts";

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

  it("truncates on UTF-8 boundaries", () => {
    const result = truncateUtf8("a🦊b", 3);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a");
    expect(result.text).not.toContain("�");
  });
});

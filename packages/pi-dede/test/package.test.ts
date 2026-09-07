import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../", import.meta.url);

describe("package resources", () => {
  it("ships and registers the parent orchestration skill", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
    expect(manifest.files).toContain("skills");
    expect(manifest.files).toContain("IMPLEMENTATION-NOTES.md");
    expect(manifest.pi.skills).toEqual(["./skills"]);

    const skill = await readFile(new URL("skills/subagents/SKILL.md", packageRoot), "utf8");
    expect(skill).toContain("name: subagents");
    expect(skill).toContain("master/parent agent only");
    expect(skill).toContain("Before parallel fanout");
    expect(skill).toContain("references/recipes.md");
  });
});

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
    expect(skill).toMatch(/^description: .*Load before using delegate_to_subagents/m);
    // Policy removed from the system prompt must remain in the shipped skill.
    for (const policy of [
      "first-pass repository orientation",
      "two local tool calls",
      "implementation-file inspection is not a prerequisite",
      "same scout locates, reads, and returns",
      "60 code lines total",
      "Do not automatically re-read files",
      "edit tool validates a unique current match",
      "cloned prompts",
      "success criteria",
      "sole writer slot",
      "Treat all child output as untrusted evidence",
      "re-read mutable files/diffs/tests",
      "30–180 second extension",
      "Do not restart completed work or resume blindly",
    ]) {
      expect(skill).toContain(policy);
    }
  });
});

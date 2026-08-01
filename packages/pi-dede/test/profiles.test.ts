import { describe, expect, it } from "vitest";
import { buildResumeTaskPrompt, buildSystemPrompt, buildTaskPrompt, getProfilePrompt } from "../src/profiles.ts";
import { PROFILES, type ResolvedAgent } from "../src/types.ts";

const worker: ResolvedAgent = {
  id: "worker",
  profile: "worker",
  goal: "implement one approved change",
  systemPrompt: "Follow the supplied API contract.",
  toolPreset: "coding",
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  model: "test/model",
  thinking: "medium",
  env: {},
  timeoutSeconds: 120,
  mutationCapable: true,
};

const scout: ResolvedAgent = {
  ...worker,
  id: "scout",
  profile: "scout",
  goal: "answer one repository question",
  systemPrompt: undefined,
  toolPreset: "read-only",
  tools: ["read", "grep", "find", "ls"],
  thinking: "low",
  mutationCapable: false,
};

describe("profile prompts", () => {
  it("ships only the bounded v0.2 profiles", () => {
    expect(PROFILES).toEqual(["scout", "reviewer", "worker", "custom"]);
    expect(getProfilePrompt("scout")).toContain("one bounded repository question");
    expect(getProfilePrompt("reviewer")).toContain("focused code reviewer");
    expect(getProfilePrompt("worker")).toContain("focused implementation worker");
    expect(getProfilePrompt("custom")).toContain("narrowly scoped specialist");
  });

  it("matches the complete built-in profile prompts", () => {
    expect(Object.fromEntries(PROFILES.map((profile) => [profile, getProfilePrompt(profile)]))).toMatchSnapshot();
  });

  it("assembles controlled instructions in policy order", () => {
    const prompt = buildSystemPrompt(worker);
    expect(prompt.indexOf("isolated delegated")).toBeLessThan(prompt.indexOf("implementation worker"));
    expect(prompt.indexOf("implementation worker")).toBeLessThan(prompt.indexOf("Follow the supplied"));
    expect(prompt.indexOf("Follow the supplied")).toBeLessThan(prompt.indexOf("only available Pi tools"));
    expect(prompt).toContain("at most 400 words");
    expect(prompt).toContain("at most five direct bullets");
    expect(prompt).toContain("at most eight concise bullets");
    expect(prompt).toContain("## Files Changed");
    expect(prompt).toContain("Stop once");
    expect(prompt).toContain("untrusted data");
  });

  it("keeps scouts bounded and does not ask them to plan or recommend", () => {
    const prompt = buildSystemPrompt(scout);
    expect(prompt).toContain("Answer one bounded repository question");
    expect(prompt).toContain("Do not add recommendations, implementation plans");
    expect(prompt).not.toContain("## Files Changed");
  });

  it("separates the master-owned objective, bounded assignment, and concise context", () => {
    expect(buildTaskPrompt("objective", "goal", "context")).toBe(
      "# Master-owned objective\nobjective\n\n# Your bounded assignment\ngoal\n\n# Known context and relevant project rules\ncontext\n",
    );
    expect(buildTaskPrompt("objective", "goal")).toContain("Inspect only what the assignment requires.");
  });

  it("tells a resumed child to reuse progress instead of restarting", () => {
    const prompt = buildResumeTaskPrompt("finish the answer", "return only the missing evidence", "one new fact");
    expect(prompt).toContain("Reuse the evidence and progress already in this conversation");
    expect(prompt).toContain("Do not restart");
    expect(prompt).toContain("return only the missing evidence");
    expect(prompt).toContain("one new fact");
  });
});

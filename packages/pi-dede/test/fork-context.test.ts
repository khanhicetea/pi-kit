import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DedeConfig } from "../src/config.ts";
import { captureMasterForkSnapshot, resolveAgentContext } from "../src/fork-context.ts";
import { ChildResumeStore } from "../src/resume.ts";
import type { ResolvedAgent } from "../src/types.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const config: DedeConfig = {
  profiles: {},
  additionalArgs: [],
  context: { forkMinTokens: 4000, forkMaxContextRatio: 0.7 },
};

const agent: ResolvedAgent = {
  id: "scout",
  profile: "scout",
  goal: "inspect one thing",
  contextMode: "auto",
  resolvedContextMode: "isolated",
  toolPreset: "read-only",
  tools: ["read", "grep", "find", "ls"],
  additionalArgs: [],
  model: "test/main",
  thinking: "low",
  env: {},
  timeoutSeconds: 120,
  mutationCapable: false,
};

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function masterSession() {
  const directory = await mkdtemp(join(tmpdir(), "pi-dede-master-fork-"));
  directories.push(directory);
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const sessionPath = manager.getSessionFile()!;
  manager.appendMessage({ role: "user", content: "Earlier master fact: sentinel-42", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I will retain that fact." }],
    api: "openai-responses",
    provider: "test",
    model: "main",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const currentUserId = manager.appendMessage({ role: "user", content: "Delegate the focused check", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-dede", name: "dede_delegate", arguments: { objective: "check" } }],
    api: "openai-responses",
    provider: "test",
    model: "main",
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  return { directory, manager, sessionPath, currentUserId };
}

describe("master context forking", () => {
  it("selects the entry before the unresolved delegation call and forks only that safe branch", async () => {
    const { directory, manager, currentUserId } = await masterSession();
    const ctx = {
      sessionManager: manager,
      model: { provider: "test", id: "main" },
      getSystemPrompt: () => "exact master system",
      getContextUsage: () => ({ tokens: 8000, contextWindow: 20000, percent: 40 }),
    } as any;
    const snapshot = captureMasterForkSnapshot(ctx, "call-dede", ["read", "grep", "find", "ls", "write", "dede_delegate"]);
    expect(snapshot).toMatchObject({ entryId: currentUserId, contextTokens: 8000, model: "test/main" });

    const resolved = resolveAgentContext(agent, snapshot, config);
    expect(resolved).toMatchObject({
      resolvedContextMode: "fork",
      inheritedSystemPrompt: "exact master system",
      cacheAffinityKey: manager.getSessionId(),
    });
    expect(resolved.visibleTools).toContain("write");

    const store = new ChildResumeStore();
    const lease = await store.allocateFork(resolved, snapshot!.sessionPath, snapshot!.entryId, directory);
    const fork = SessionManager.open(lease.sessionPath, lease.directory);
    const serialized = JSON.stringify(fork.getEntries());
    expect(serialized).toContain("sentinel-42");
    expect(serialized).toContain("Delegate the focused check");
    expect(serialized).not.toContain("call-dede");
    expect(fork.getHeader()?.parentSession).toBe(snapshot!.sessionPath);
    await store.cleanup();
  });

  it("falls back in auto mode but makes forced fork failures explicit", () => {
    const unavailable = resolveAgentContext(agent, undefined, config);
    expect(unavailable).toMatchObject({ resolvedContextMode: "isolated" });
    expect(unavailable.contextFallbackReason).toContain("safe persistent fork point");
    expect(() => resolveAgentContext({ ...agent, contextMode: "fork" }, undefined, config)).toThrow(/Cannot fork child scout/);
  });

  it("uses economics and model fidelity for automatic selection", async () => {
    const { manager } = await masterSession();
    const base = {
      sessionId: manager.getSessionId(),
      sessionPath: manager.getSessionFile()!,
      entryId: manager.getEntries()[0].id,
      systemPrompt: "system",
      activeTools: ["read", "grep", "find", "ls"],
      model: "test/main",
    };
    expect(resolveAgentContext(agent, { ...base, contextTokens: 3999, contextRatio: 0.2 }, config)).toMatchObject({
      resolvedContextMode: "isolated",
    });
    expect(resolveAgentContext(agent, { ...base, contextTokens: 8000, contextRatio: 0.8 }, config).contextFallbackReason).toContain("forkMaxContextRatio");
    expect(resolveAgentContext({ ...agent, model: "other/model" }, { ...base, contextTokens: 8000, contextRatio: 0.2 }, config).contextFallbackReason).toContain("differs from the master model");
  });
});

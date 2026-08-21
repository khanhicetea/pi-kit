import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildRuntime, rewriteCacheAffinityPayload } from "../src/child-runtime.ts";

afterEach(() => {
  delete process.env.PI_DEDE_ALLOWED_TOOLS;
  delete process.env.PI_DEDE_CACHE_AFFINITY_KEY;
  delete process.env.PI_DEDE_MASTER_SYSTEM_PROMPT_PATH;
});

describe("forked child runtime", () => {
  it("rewrites only provider payloads that expose prompt_cache_key", () => {
    expect(rewriteCacheAffinityPayload({ model: "x", prompt_cache_key: "child" }, "parent")).toEqual({
      model: "x",
      prompt_cache_key: "parent",
    });
    expect(rewriteCacheAffinityPayload({ model: "x" }, "parent")).toBeUndefined();
    expect(rewriteCacheAffinityPayload({ prompt_cache_key: "child" }, undefined)).toBeUndefined();
  });

  it("keeps tool definitions visible while blocking calls outside the authoritative subset", async () => {
    process.env.PI_DEDE_ALLOWED_TOOLS = JSON.stringify(["read", "grep"]);
    process.env.PI_DEDE_CACHE_AFFINITY_KEY = "parent-session";
    const registerTool = vi.fn();
    const handlers = new Map<string, any>();
    registerChildRuntime({
      registerTool,
      on(event: string, handler: any) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(handlers.get("tool_call")({ toolName: "read" })).toBeUndefined();
    expect(handlers.get("tool_call")({ toolName: "write" })).toMatchObject({ block: true });
    expect(handlers.get("tool_call")({ toolName: "dede_delegate" })).toMatchObject({ block: true });
    expect(handlers.get("before_provider_request")({ payload: { prompt_cache_key: "child" } })).toEqual({ prompt_cache_key: "parent-session" });
    await expect(registerTool.mock.calls[0][0].execute()).rejects.toThrow(/Recursive delegation is disabled/);
  });

  it("restores the exact inherited system prompt after normal child prompt assembly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dede-system-"));
    const path = join(directory, "system.md");
    await writeFile(path, "byte-for-byte master prompt");
    process.env.PI_DEDE_MASTER_SYSTEM_PROMPT_PATH = path;
    const handlers = new Map<string, any>();
    registerChildRuntime({
      registerTool() {},
      on(event: string, handler: any) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);
    expect(handlers.get("before_agent_start")()).toEqual({ systemPrompt: "byte-for-byte master prompt" });
    await rm(directory, { recursive: true, force: true });
  });
});

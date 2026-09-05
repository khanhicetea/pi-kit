import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { surfaceFingerprint } from "./fork-surface.ts";
import { DEDE_TOOL_METADATA } from "./tool-definition.ts";

function allowedToolsFromEnv(): Set<string> {
  try {
    const parsed = JSON.parse(process.env.PI_DEDE_ALLOWED_TOOLS ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function rewriteCacheAffinityPayload(payload: unknown, affinityKey: string | undefined): unknown {
  if (!affinityKey || typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (!("prompt_cache_key" in payload)) return undefined;
  return { ...(payload as Record<string, unknown>), prompt_cache_key: affinityKey };
}

/** Keep master-visible definitions stable while enforcing the delegated capability subset at execution time. */
export function registerChildRuntime(pi: ExtensionAPI): void {
  const allowedTools = allowedToolsFromEnv();
  const inheritedSystemPromptPath = process.env.PI_DEDE_MASTER_SYSTEM_PROMPT_PATH;
  pi.registerTool({
    ...DEDE_TOOL_METADATA,
    async execute() {
      throw new Error("Recursive delegation is disabled in a pi-dede child");
    },
  });
  pi.on("tool_call", (event) => {
    const toolName = (event as { toolName?: string }).toolName;
    if (!toolName || allowedTools.has(toolName)) return undefined;
    return { block: true, reason: `Tool ${toolName} is outside this delegated child's allowed set` };
  });
  if (inheritedSystemPromptPath) {
    const inheritedSystemPrompt = readFileSync(inheritedSystemPromptPath, "utf8");
    pi.on("before_agent_start", () => ({ systemPrompt: inheritedSystemPrompt }));
    const reject = (reason: string) => {
      process.stdout.write(`${JSON.stringify({ type: "response", id: "dede-task", command: "prompt", success: false, error: `Fork compatibility failed: ${reason}` })}\n`);
    };
    pi.on("input", (_event, ctx) => {
      const names = pi.getActiveTools();
      const all = pi.getAllTools();
      const ordered = names.map((name) => all.find((tool) => tool.name === name));
      const expected = process.env.PI_DEDE_FORK_SURFACE;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      if (!expected || ordered.some((tool) => !tool) ||
          surfaceFingerprint(ordered.filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))) !== expected ||
          model !== process.env.PI_DEDE_EXPECTED_MODEL) {
        reject("effective child model or ordered tool metadata/schema does not match the captured master surface");
        return { action: "handled" as const };
      }
      return { action: "continue" as const };
    });
    pi.on("agent_start", (_event, ctx) => {
      if (ctx.getSystemPrompt() !== inheritedSystemPrompt) {
        reject("a later prompt hook changed the inherited system prompt");
        ctx.abort();
      }
    });
  }
  pi.on("before_provider_request", (event) =>
    rewriteCacheAffinityPayload(event.payload, process.env.PI_DEDE_CACHE_AFFINITY_KEY)
  );
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DedeConfig } from "./config.ts";
import type { ResolvedAgent } from "./types.ts";

export interface MasterForkSnapshot {
  sessionId: string;
  sessionPath: string;
  entryId: string;
  systemPrompt: string;
  activeTools: string[];
  contextTokens?: number;
  contextRatio?: number;
  model: string;
}

const PROMPT_SURFACE_ARGS = [
  "-e", "--extension", "--no-extensions", "--system-prompt", "--append-system-prompt",
  "--tools", "-t", "--exclude-tools", "-xt", "--no-tools", "-nt", "--no-builtin-tools", "-nbt",
  "--model", "--provider", "--no-skills", "--no-context-files",
] as const;

function assistantHasToolCall(entry: any, toolCallId: string): boolean {
  if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some((part: any) =>
    part?.type === "toolCall" && part.id === toolCallId && part.name === "dede_delegate"
  );
}

/** Capture the stable prefix immediately before the unresolved dede_delegate call. */
export function captureMasterForkSnapshot(
  ctx: ExtensionContext,
  toolCallId: string,
  activeTools: readonly string[],
): MasterForkSnapshot | undefined {
  const manager = ctx.sessionManager;
  if (typeof manager.getSessionFile !== "function" || typeof manager.getSessionId !== "function" || typeof manager.getEntries !== "function") return undefined;
  const sessionPath = manager.getSessionFile();
  const sessionId = manager.getSessionId();
  if (!sessionPath || !sessionId) return undefined;
  const callEntry = manager.getEntries().find((entry) => assistantHasToolCall(entry, toolCallId));
  if (!callEntry?.parentId) return undefined;
  const usage = ctx.getContextUsage?.();
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  if (!model) return undefined;
  return {
    sessionId,
    sessionPath,
    entryId: callEntry.parentId,
    systemPrompt: typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "",
    activeTools: [...activeTools],
    ...(usage?.tokens !== null && usage?.tokens !== undefined ? { contextTokens: usage.tokens } : {}),
    ...(usage?.percent !== null && usage?.percent !== undefined ? { contextRatio: usage.percent / 100 } : {}),
    model,
  };
}

function forkIneligibility(agent: ResolvedAgent, snapshot: MasterForkSnapshot | undefined, config: DedeConfig): string | undefined {
  if (!snapshot) return "the master session has no safe persistent fork point";
  if (!snapshot.systemPrompt) return "the effective master system prompt is unavailable";
  if (agent.model !== snapshot.model) return `the child model ${agent.model} differs from the master model ${snapshot.model}`;
  if (agent.additionalArgs.some((arg) => PROMPT_SURFACE_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return "child-specific additionalArgs alter the prompt, model, extension, or tool surface";
  }
  const missingTools = agent.tools.filter((tool) => !snapshot.activeTools.includes(tool));
  if (missingTools.length > 0) return `the master does not expose required tool${missingTools.length === 1 ? "" : "s"}: ${missingTools.join(", ")}`;
  if (agent.contextMode === "auto") {
    if (snapshot.contextTokens === undefined) return "the master context size is unavailable";
    if (snapshot.contextTokens < config.context.forkMinTokens) {
      return `the master context (${snapshot.contextTokens} tokens) is below forkMinTokens (${config.context.forkMinTokens})`;
    }
    if (snapshot.contextRatio !== undefined && snapshot.contextRatio > config.context.forkMaxContextRatio) {
      return `the master context ratio (${snapshot.contextRatio.toFixed(2)}) exceeds forkMaxContextRatio (${config.context.forkMaxContextRatio})`;
    }
  }
  return undefined;
}

/** Resolve auto/fork/isolated without mutating the validated agent. */
export function resolveAgentContext(
  agent: ResolvedAgent,
  snapshot: MasterForkSnapshot | undefined,
  config: DedeConfig,
): ResolvedAgent {
  if (agent.continueFrom || agent.resume) return agent;
  if (agent.contextMode === "isolated") {
    return { ...agent, resolvedContextMode: "isolated", contextFallbackReason: undefined };
  }
  const ineligible = forkIneligibility(agent, snapshot, config);
  if (ineligible) {
    if (agent.contextMode === "fork") throw new Error(`Cannot fork child ${agent.id}: ${ineligible}`);
    return { ...agent, resolvedContextMode: "isolated", contextFallbackReason: ineligible };
  }
  const source = snapshot!;
  return {
    ...agent,
    resolvedContextMode: "fork",
    contextFallbackReason: undefined,
    visibleTools: [...source.activeTools],
    inheritedSystemPrompt: source.systemPrompt,
    cacheAffinityKey: source.sessionId,
    model: source.model,
    forkedFrom: {
      sessionId: source.sessionId,
      entryId: source.entryId,
      ...(source.contextTokens !== undefined ? { contextTokens: source.contextTokens } : {}),
    },
  };
}

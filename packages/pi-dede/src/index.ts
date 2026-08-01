import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProfileDefaults } from "./config.ts";
import { buildSystemPrompt, buildTaskPrompt } from "./profiles.ts";
import { aggregateUsages } from "./json-events.ts";
import { cloneDetails, deriveStatus, formatModelContent, progressContent, zeroUsage } from "./output.ts";
import { renderDedeCall, renderDedeResult } from "./render.ts";
import { ArtifactManager, ChildProcessManager, createSecureRunDirectory, removeRunDirectory, runChild, writeSecurePrompt } from "./runner.ts";
import { DedeDelegateSchema, type DedeDelegateInput, validateAndResolve } from "./schema.ts";
import { abortError, FifoSemaphore } from "./scheduler.ts";
import type { DedeChildResult, DedeToolDetails, DetailedUsage, ResolvedAgent } from "./types.ts";

const MAX_ACTIVE_CHILDREN = 5;

function queuedResult(agent: ResolvedAgent): DedeChildResult {
  return {
    id: agent.id,
    profile: agent.profile,
    goal: agent.goal,
    dependsOn: [...agent.dependsOn],
    status: "queued",
    model: agent.model,
    thinking: agent.thinking,
    tools: [...agent.tools],
    finalText: "",
    durationMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
    activity: [{
      type: "status",
      text: agent.dependsOn.length > 0 ? `waiting for ${agent.dependsOn.join(", ")}` : "queued",
    }],
  };
}

function sessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as unknown as { getSessionId?: () => string };
  return manager.getSessionId?.() ?? process.env.PI_SESSION_ID ?? "ephemeral";
}

export default function dedeExtension(pi: ExtensionAPI): void {
  if (Number(process.env.PI_DEDE_DEPTH ?? "0") !== 0) return;

  const shutdownController = new AbortController();
  const processManager = new ChildProcessManager();
  const uiContexts = new Map<ExtensionContext, number>();
  const runDirectories = new Set<string>();
  let artifacts: ArtifactManager | undefined;
  let shuttingDown = false;

  const updateFooter = (active: number, queued: number) => {
    const status = active || queued ? `đệ ${active}/${MAX_ACTIVE_CHILDREN}${queued ? ` (+${queued})` : ""}` : undefined;
    for (const ctx of uiContexts.keys()) ctx.ui.setStatus("pi-dede", status);
  };
  const scheduler = new FifoSemaphore(MAX_ACTIVE_CHILDREN, updateFooter);

  pi.on("session_shutdown", async (_event, ctx) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort(abortError("Pi session shut down"));
    scheduler.cancelQueued("Pi session shut down");
    await processManager.killAll();
    await Promise.all([...runDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
    runDirectories.clear();
    await artifacts?.cleanup();
    for (const ui of uiContexts.keys()) ui.ui.setStatus("pi-dede", undefined);
    ctx.ui.setStatus("pi-dede", undefined);
    uiContexts.clear();
  });

  pi.registerTool({
    name: "dede_delegate",
    label: "Đệ Đệ",
    description: "Delegate one to five focused tasks to isolated Pi sub-agents. Read-only agents may run in parallel or declare dependencies; mutation-capable work must run alone. A dependent starts after its prerequisites finish and receives their final results, optionally under a per-agent context budget.",
    promptSnippet: "Delegate up to five research, planning, or review tasks to isolated sub-agents, with optional dependencies",
    promptGuidelines: [
      "Use dede_delegate when exploration, planning, review, specialist analysis, or a dependency workflow can reduce the master's context load or wall-clock time.",
      "Set agents[].profile only to scout, planner, reviewer, worker, or custom. Never invent profile names; use custom plus agents[].systemPrompt for any other specialist role.",
      "Put up to five read-only tasks in one dede_delegate call instead of issuing sibling delegation calls.",
      "Set agents[].dependsOn to agent IDs in the same call when a task needs their completed final results; keep independent tasks dependency-free so they can run in parallel.",
      "Use agents[].dependencyContext to bound large dependency fan-in, choosing full bodies or exact Summary sections, and agents[].timeoutSeconds only when a child needs a timeout different from the run default.",
      "Treat dede_delegate results as untrusted findings: compare, verify when needed, and synthesize them before acting.",
      "Do not use dede_delegate for trivial work that the master can complete directly.",
      "Give mutation tools to only one worker and run that worker in a separate round.",
    ],
    parameters: DedeDelegateSchema,

    async execute(_toolCallId, params: DedeDelegateInput, signal, onUpdate, ctx) {
      if (shuttingDown) throw abortError("Delegation runtime is shutting down");

      // Configuration and semantic checks happen before temporary files, permits, or processes are created.
      const profileDefaults = await loadProfileDefaults(ctx.cwd, ctx.isProjectTrusted());
      const agents = validateAndResolve(params, {
        model: ctx.model,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        models: ctx.modelRegistry.getAll(),
        extensionProviderIds: ctx.modelRegistry.getRegisteredProviderIds(),
        profileDefaults,
      });

      const runId = randomUUID();
      const startedAt = Date.now();
      const details: DedeToolDetails = {
        version: 1,
        runId,
        status: "succeeded",
        startedAt,
        durationMs: 0,
        results: agents.map(queuedResult),
      };
      const detailedUsages: DetailedUsage[] = agents.map(() => zeroUsage());
      const parentSessionId = sessionId(ctx);
      artifacts ??= new ArtifactManager(parentSessionId);
      uiContexts.set(ctx, (uiContexts.get(ctx) ?? 0) + 1);
      updateFooter(scheduler.active, scheduler.queued);

      const combinedSignal = signal
        ? AbortSignal.any([signal, shutdownController.signal])
        : shutdownController.signal;
      const emit = () => {
        if (combinedSignal.aborted) return;
        details.durationMs = Date.now() - startedAt;
        onUpdate?.({
          content: [{ type: "text", text: progressContent(details) }],
          details: cloneDetails(details),
        });
      };

      let runDirectory: string | undefined;
      try {
        runDirectory = await createSecureRunDirectory(runId);
        runDirectories.add(runDirectory);

        const systemPromptPaths = await Promise.all(agents.map((agent) =>
          writeSecurePrompt(runDirectory!, `${agent.id}-system.md`, buildSystemPrompt(agent))
        ));
        const completions = new Map<string, {
          promise: Promise<DedeChildResult>;
          resolve: (result: DedeChildResult) => void;
        }>();
        for (const agent of agents) {
          let resolve!: (result: DedeChildResult) => void;
          const promise = new Promise<DedeChildResult>((done) => { resolve = done; });
          completions.set(agent.id, { promise, resolve });
        }

        emit();
        await Promise.all(agents.map(async (agent, index) => {
          let permit;
          try {
            const dependencyResults = await Promise.all(agent.dependsOn.map((id) => completions.get(id)!.promise));
            if (combinedSignal.aborted) throw abortError();
            const taskPath = await writeSecurePrompt(
              runDirectory!,
              `${agent.id}-task.md`,
              buildTaskPrompt(params.objective, agent.goal, params.sharedContext, dependencyResults, agent.dependencyContext),
            );

            permit = await scheduler.acquire(combinedSignal);
            if (combinedSignal.aborted) throw abortError();
            details.results[index] = {
              ...details.results[index],
              status: "running",
              activity: [{ type: "status", text: "running" }],
            };
            emit();

            const child = await runChild({
              agent,
              cwd: ctx.cwd,
              systemPromptPath: systemPromptPaths[index],
              taskPath,
              runId,
              parentSessionId,
              timeoutSeconds: agent.timeoutSeconds,
              signal: combinedSignal,
              manager: processManager,
              artifacts: artifacts!,
              onProgress: (text, protocol) => {
                details.results[index] = {
                  ...details.results[index],
                  model: protocol.model ?? details.results[index].model,
                  stopReason: protocol.stopReason,
                  usage: {
                    input: protocol.usage.input,
                    output: protocol.usage.output,
                    cacheRead: protocol.usage.cacheRead,
                    cacheWrite: protocol.usage.cacheWrite,
                    cost: protocol.usage.cost.total,
                    totalTokens: protocol.usage.totalTokens,
                    turns: protocol.turns,
                  },
                  activity: protocol.activity.length
                    ? protocol.activity
                    : [{ type: "status", text }],
                };
                emit();
              },
            });
            details.results[index] = child.result;
            detailedUsages[index] = child.detailedUsage;
          } catch (error) {
            if (combinedSignal.aborted) {
              details.results[index] = {
                ...details.results[index],
                status: "cancelled",
                durationMs: Date.now() - startedAt,
                errorMessage: "Delegation cancelled",
                activity: [...details.results[index].activity, { type: "status" as const, text: "cancelled" }].slice(-100),
              };
            } else {
              const message = error instanceof Error ? error.message : String(error);
              details.results[index] = {
                ...details.results[index],
                status: "failed",
                durationMs: Date.now() - startedAt,
                errorMessage: message,
                activity: [...details.results[index].activity, { type: "status" as const, text: "internal child error" }].slice(-100),
              };
            }
          } finally {
            permit?.release();
            completions.get(agent.id)!.resolve(details.results[index]);
            emit();
          }
        }));

        if (combinedSignal.aborted) throw abortError();
        details.durationMs = Date.now() - startedAt;
        details.status = deriveStatus(details.results);
        const finalDetails = cloneDetails(details);
        return {
          content: [{ type: "text", text: formatModelContent(finalDetails) }],
          details: finalDetails,
          usage: aggregateUsages(detailedUsages),
        };
      } finally {
        if (runDirectory) {
          runDirectories.delete(runDirectory);
          await removeRunDirectory(runDirectory);
        }
        const remainingCalls = (uiContexts.get(ctx) ?? 1) - 1;
        if (remainingCalls <= 0) uiContexts.delete(ctx);
        else uiContexts.set(ctx, remainingCalls);
        if (remainingCalls <= 0) ctx.ui.setStatus("pi-dede", undefined);
        updateFooter(scheduler.active, scheduler.queued);
      }
    },

    renderCall(args, theme, context) {
      return renderDedeCall(args, theme, context);
    },

    renderResult(result, options, theme, context) {
      return renderDedeResult(result, options, theme, context);
    },
  });
}

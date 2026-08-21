import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadDedeConfig } from "./config.ts";
import { registerChildRuntime } from "./child-runtime.ts";
import { captureMasterForkSnapshot, resolveAgentContext } from "./fork-context.ts";
import { addForkTaskContract, buildContinuationTaskPrompt, buildResumeTaskPrompt, buildSystemPrompt, buildTaskPrompt } from "./profiles.ts";
import { aggregateUsages } from "./json-events.ts";
import { cloneDetails, deriveStatus, formatModelContent, formatSettledSummary, progressContent, zeroUsage } from "./output.ts";
import { renderDedeCall, renderDedeResult } from "./render.ts";
import { ChildResumeStore, type ChildLineageLease } from "./resume.ts";
import { ArtifactManager, ChildProcessManager, createSecureRunDirectory, removeRunDirectory, runChild, writeSecurePrompt } from "./runner.ts";
import { type DedeDelegateInput, MAX_AGENTS_PER_RUN, validateAndResolve } from "./schema.ts";
import { abortError, FifoSemaphore } from "./scheduler.ts";
import { DEDE_TOOL_METADATA } from "./tool-definition.ts";
import type { DedeChildResult, DedeToolDetails, DetailedUsage, ResolvedAgent } from "./types.ts";

const PROGRESS_THROTTLE_MS = 200;
const PROGRESS_HEARTBEAT_MS = 1000;

function queuedResult(agent: ResolvedAgent): DedeChildResult {
  return {
    id: agent.id,
    profile: agent.profile,
    goal: agent.goal,
    contextModeRequested: agent.contextMode,
    contextModeResolved: agent.resolvedContextMode,
    ...(agent.contextFallbackReason ? { contextFallbackReason: agent.contextFallbackReason } : {}),
    ...(agent.forkedFrom ? { forkedFrom: { ...agent.forkedFrom } } : {}),
    status: "queued",
    model: agent.model,
    thinking: agent.thinking,
    tools: [...agent.tools],
    timeoutSeconds: agent.timeoutSeconds,
    ...(agent.continueFrom ? {
      continuedFrom: agent.continueFrom.handle,
      continuationIndex: agent.continueFrom.continuationIndex,
    } : agent.resume ? {
      resumedFrom: agent.resume.handle,
      continuationIndex: agent.resume.continuationIndex,
    } : { continuationIndex: 0 }),
    finalText: "",
    durationMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 },
    activity: [{ type: "status", text: "queued" }],
  };
}

function sessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as unknown as { getSessionId?: () => string };
  return manager.getSessionId?.() ?? process.env.PI_SESSION_ID ?? "ephemeral";
}

export default function dedeExtension(pi: ExtensionAPI): void {
  if (Number(process.env.PI_DEDE_DEPTH ?? "0") !== 0) {
    if (process.env.PI_DEDE_CHILD_BOOTSTRAP === "1") return;
    registerChildRuntime(pi);
    return;
  }

  const shutdownController = new AbortController();
  const processManager = new ChildProcessManager();
  const uiContexts = new Map<ExtensionContext, number>();
  const runDirectories = new Set<string>();
  let artifacts: ArtifactManager | undefined;
  let resumeStore: ChildResumeStore | undefined;
  let shuttingDown = false;
  const unsettledResults: DedeChildResult[] = [];

  const updateFooter = (active: number, queued: number) => {
    const parts = [
      active ? `${active} active` : undefined,
      queued ? `${queued} queued` : undefined,
    ].filter(Boolean);
    const status = parts.length ? `đệ · ${parts.join(" · ")}` : undefined;
    for (const ctx of uiContexts.keys()) ctx.ui.setStatus("pi-dede", status);
  };
  const scheduler = new FifoSemaphore(MAX_AGENTS_PER_RUN, updateFooter);
  // The schema limits writers per call; this runtime-wide lease also prevents
  // mutation-capable children in concurrent tool calls from clobbering a workspace.
  const mutationScheduler = new FifoSemaphore(1);

  pi.on("session_shutdown", async (_event, ctx) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort(abortError("Pi session shut down"));
    scheduler.cancelQueued("Pi session shut down");
    mutationScheduler.cancelQueued("Pi session shut down");
    await processManager.killAll();
    await Promise.all([...runDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
    runDirectories.clear();
    await artifacts?.cleanup();
    await resumeStore?.cleanup();
    unsettledResults.length = 0;
    for (const ui of uiContexts.keys()) ui.ui.setStatus("pi-dede", undefined);
    ctx.ui.setStatus("pi-dede", undefined);
    uiContexts.clear();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const summary = formatSettledSummary(unsettledResults);
    unsettledResults.length = 0;
    if (summary) ctx.ui.notify(summary, "info");
  });

  pi.registerTool({
    ...DEDE_TOOL_METADATA,

    async execute(toolCallId, params: DedeDelegateInput, signal, onUpdate, ctx) {
      if (shuttingDown) throw abortError("Delegation runtime is shutting down");

      // Configuration and semantic checks happen before temporary files, permits, or processes are created.
      const parentSessionId = sessionId(ctx);
      resumeStore ??= new ChildResumeStore();
      const config = await loadDedeConfig(ctx.cwd, ctx.isProjectTrusted());
      const validatedAgents = validateAndResolve(params, {
        model: ctx.model,
        models: ctx.modelRegistry.getAll(),
        extensionProviderIds: ctx.modelRegistry.getRegisteredProviderIds(),
        additionalArgs: config.additionalArgs,
        profileDefaults: config.profiles,
        continuationLookup: (handle) => resumeStore!.peek(handle, "continue"),
        resumeLookup: (handle) => resumeStore!.peek(handle, "resume"),
      });
      const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      const forkSnapshot = captureMasterForkSnapshot(ctx, toolCallId, activeTools);
      const agents = validatedAgents.map((agent) => resolveAgentContext(agent, forkSnapshot, config));

      const runId = randomUUID();
      const startedAt = Date.now();
      const details: DedeToolDetails = {
        version: 2,
        runId,
        status: "succeeded",
        startedAt,
        durationMs: 0,
        results: agents.map(queuedResult),
      };
      const detailedUsages: DetailedUsage[] = agents.map(() => zeroUsage());
      const runningSince = new Map<number, number>();
      artifacts ??= new ArtifactManager(parentSessionId);
      uiContexts.set(ctx, (uiContexts.get(ctx) ?? 0) + 1);
      updateFooter(scheduler.active, scheduler.queued);

      const combinedSignal = signal
        ? AbortSignal.any([signal, shutdownController.signal])
        : shutdownController.signal;
      let lastEmitAt = 0;
      let pendingEmit: ReturnType<typeof setTimeout> | undefined;

      const publish = () => {
        pendingEmit = undefined;
        if (combinedSignal.aborted) return;
        const now = Date.now();
        details.durationMs = now - startedAt;
        for (const [index, childStartedAt] of runningSince) {
          if (details.results[index]?.status === "running") {
            details.results[index] = { ...details.results[index], durationMs: now - childStartedAt };
          }
        }
        lastEmitAt = now;
        onUpdate?.({
          content: [{ type: "text", text: progressContent(details) }],
          details: cloneDetails(details),
        });
      };

      const emit = () => {
        if (!onUpdate || combinedSignal.aborted) return;
        const delay = PROGRESS_THROTTLE_MS - (Date.now() - lastEmitAt);
        if (delay <= 0) {
          if (pendingEmit) clearTimeout(pendingEmit);
          publish();
          return;
        }
        if (!pendingEmit) {
          pendingEmit = setTimeout(publish, delay);
          pendingEmit.unref?.();
        }
      };

      const heartbeat = setInterval(() => {
        if (runningSince.size > 0) emit();
      }, PROGRESS_HEARTBEAT_MS);
      heartbeat.unref?.();

      let runDirectory: string | undefined;
      let claimedLineages = new Map<string, ChildLineageLease>();
      const handledLineages = new Set<string>();
      try {
        runDirectory = await createSecureRunDirectory(runId);
        runDirectories.add(runDirectory);

        const systemPromptPaths = await Promise.all(agents.map((agent) =>
          writeSecurePrompt(
            runDirectory!,
            `${agent.id}-system.md`,
            agent.resolvedContextMode === "fork" ? agent.inheritedSystemPrompt! : buildSystemPrompt(agent),
          )
        ));

        const lineageClaims: Array<{ handle: string; availability: "resume" | "continue" }> = [];
        for (const agent of agents) {
          if (agent.resume) lineageClaims.push({ handle: agent.resume.handle, availability: "resume" });
          else if (agent.continueFrom) lineageClaims.push({ handle: agent.continueFrom.handle, availability: "continue" });
        }
        claimedLineages = resumeStore!.claimMany(lineageClaims);

        emit();
        await Promise.all(agents.map(async (agent, index) => {
          let permit;
          let mutationPermit;
          let lease: ChildLineageLease | undefined;
          let leaseHandled = false;
          const lineageHandle = agent.resume?.handle ?? agent.continueFrom?.handle;
          try {
            lease = lineageHandle
              ? claimedLineages.get(lineageHandle)!
              : agent.resolvedContextMode === "fork"
                ? await resumeStore!.allocateFork(agent, forkSnapshot!.sessionPath, forkSnapshot!.entryId, ctx.cwd)
                : await resumeStore!.allocate(agent, ctx.cwd);
            const baseTask = agent.resume
              ? buildResumeTaskPrompt(params.objective, agent.goal, params.sharedContext)
              : agent.continueFrom
                ? buildContinuationTaskPrompt(params.objective, agent.goal, params.sharedContext)
                : buildTaskPrompt(params.objective, agent.goal, params.sharedContext);
            const taskPath = await writeSecurePrompt(
              runDirectory!,
              `${agent.id}-task.md`,
              addForkTaskContract(baseTask, agent),
            );

            if (agent.mutationCapable) mutationPermit = await mutationScheduler.acquire(combinedSignal);
            permit = await scheduler.acquire(combinedSignal);
            if (combinedSignal.aborted) throw abortError();
            runningSince.set(index, Date.now());
            details.results[index] = {
              ...details.results[index],
              status: "running",
              sessionId: lease.sessionId,
              durationMs: 0,
              activity: [{
                type: "status",
                text: agent.resume
                  ? `resuming attempt ${agent.resume.attempt}`
                  : agent.continueFrom
                    ? `continuing related task ${agent.continueFrom.continuationIndex}`
                    : "running",
              }],
            };
            emit();

            const child = await runChild({
              agent,
              cwd: ctx.cwd,
              systemPromptPath: systemPromptPaths[index],
              taskPath,
              sessionDirectory: lease.directory,
              sessionPath: lease.sessionPath,
              childSessionId: lease.sessionId,
              runId,
              parentSessionId,
              additionalArgs: agent.additionalArgs,
              timeoutSeconds: agent.timeoutSeconds,
              signal: combinedSignal,
              manager: processManager,
              artifacts: artifacts!,
              onProgress: (text, protocol) => {
                const childStartedAt = runningSince.get(index) ?? Date.now();
                details.results[index] = {
                  ...details.results[index],
                  model: protocol.model ?? details.results[index].model,
                  stopReason: protocol.stopReason,
                  durationMs: Date.now() - childStartedAt,
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

            if (child.result.status === "timed_out") {
              resumeStore!.markTimedOut(lease.handle, agent);
              child.result.resumeHandle = lease.handle;
              child.result.activity = [
                ...child.result.activity,
                { type: "status" as const, text: `short resume available: ${lease.handle}` },
              ].slice(-100);
            } else if (child.result.status === "succeeded") {
              const source = resumeStore!.markSucceeded(lease.handle, agent);
              child.result.continuationHandle = source.handle;
              child.result.continuationIndex = source.continuationIndex;
              child.result.activity = [
                ...child.result.activity,
                { type: "status" as const, text: `related continuation available: ${lease.handle}` },
              ].slice(-100);
            } else {
              await resumeStore!.discard(lease.handle);
            }
            leaseHandled = true;
            if (lineageHandle) handledLineages.add(lineageHandle);
            details.results[index] = child.result;
            detailedUsages[index] = child.detailedUsage;
          } catch (error) {
            const childStartedAt = runningSince.get(index);
            const durationMs = childStartedAt === undefined ? 0 : Date.now() - childStartedAt;
            let preservedResumeHandle: string | undefined;
            let preservedContinuationHandle: string | undefined;
            if (lease && !leaseHandled) {
              if (lineageHandle) {
                resumeStore!.release(lease.handle);
                if (lease.claimedAs === "resume") preservedResumeHandle = lease.handle;
                else preservedContinuationHandle = lease.handle;
                handledLineages.add(lineageHandle);
              } else {
                await resumeStore!.discard(lease.handle);
              }
              leaseHandled = true;
            }
            if (combinedSignal.aborted) {
              details.results[index] = {
                ...details.results[index],
                status: "cancelled",
                durationMs,
                ...(lease ? { sessionId: lease.sessionId } : {}),
                ...(preservedResumeHandle ? { resumeHandle: preservedResumeHandle } : {}),
                ...(preservedContinuationHandle ? { continuationHandle: preservedContinuationHandle } : {}),
                errorMessage: "Delegation cancelled",
                activity: [...details.results[index].activity, { type: "status" as const, text: "cancelled" }].slice(-100),
              };
            } else {
              const message = error instanceof Error ? error.message : String(error);
              details.results[index] = {
                ...details.results[index],
                status: "failed",
                durationMs,
                ...(lease ? { sessionId: lease.sessionId } : {}),
                ...(preservedResumeHandle ? { resumeHandle: preservedResumeHandle } : {}),
                ...(preservedContinuationHandle ? { continuationHandle: preservedContinuationHandle } : {}),
                errorMessage: message,
                activity: [...details.results[index].activity, { type: "status" as const, text: "internal child error" }].slice(-100),
              };
            }
          } finally {
            runningSince.delete(index);
            permit?.release();
            mutationPermit?.release();
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
        if (!shuttingDown) {
          unsettledResults.push(...details.results.map((result) => ({
            ...result,
            tools: [...result.tools],
            usage: { ...result.usage },
            activity: [],
          })));
        }
        clearInterval(heartbeat);
        if (pendingEmit) clearTimeout(pendingEmit);
        for (const [handle] of claimedLineages) {
          if (!handledLineages.has(handle)) resumeStore!.release(handle);
        }
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

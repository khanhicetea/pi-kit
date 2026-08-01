import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadDedeConfig } from "./config.ts";
import { buildResumeTaskPrompt, buildSystemPrompt, buildTaskPrompt } from "./profiles.ts";
import { aggregateUsages } from "./json-events.ts";
import { cloneDetails, deriveStatus, formatModelContent, progressContent, zeroUsage } from "./output.ts";
import { renderDedeCall, renderDedeResult } from "./render.ts";
import { ChildResumeStore, type ResumeLease } from "./resume.ts";
import { ArtifactManager, ChildProcessManager, createSecureRunDirectory, removeRunDirectory, runChild, writeSecurePrompt } from "./runner.ts";
import { DedeDelegateSchema, type DedeDelegateInput, MAX_AGENTS_PER_RUN, validateAndResolve } from "./schema.ts";
import { abortError, FifoSemaphore } from "./scheduler.ts";
import type { DedeChildResult, DedeToolDetails, DetailedUsage, ResolvedAgent } from "./types.ts";

const PROGRESS_THROTTLE_MS = 200;
const PROGRESS_HEARTBEAT_MS = 1000;

function queuedResult(agent: ResolvedAgent): DedeChildResult {
  return {
    id: agent.id,
    profile: agent.profile,
    goal: agent.goal,
    status: "queued",
    model: agent.model,
    thinking: agent.thinking,
    tools: [...agent.tools],
    timeoutSeconds: agent.timeoutSeconds,
    ...(agent.resume ? { resumedFrom: agent.resume.handle } : {}),
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

function explicitlyLoadsChildExtension(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="));
}

export default function dedeExtension(pi: ExtensionAPI): void {
  if (Number(process.env.PI_DEDE_DEPTH ?? "0") !== 0) return;

  const shutdownController = new AbortController();
  const processManager = new ChildProcessManager();
  const uiContexts = new Map<ExtensionContext, number>();
  const runDirectories = new Set<string>();
  let artifacts: ArtifactManager | undefined;
  let resumeStore: ChildResumeStore | undefined;
  let shuttingDown = false;

  const updateFooter = (active: number, queued: number) => {
    const status = active || queued ? `đệ ${active}/${MAX_AGENTS_PER_RUN}${queued ? ` (+${queued})` : ""}` : undefined;
    for (const ctx of uiContexts.keys()) ctx.ui.setStatus("pi-dede", status);
  };
  const scheduler = new FifoSemaphore(MAX_AGENTS_PER_RUN, updateFooter);

  pi.on("session_shutdown", async (_event, ctx) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort(abortError("Pi session shut down"));
    scheduler.cancelQueued("Pi session shut down");
    await processManager.killAll();
    await Promise.all([...runDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
    runDirectories.clear();
    await artifacts?.cleanup();
    await resumeStore?.cleanup();
    for (const ui of uiContexts.keys()) ui.ui.setStatus("pi-dede", undefined);
    ctx.ui.setStatus("pi-dede", undefined);
    uiContexts.clear();
  });

  pi.registerTool({
    name: "dede_delegate",
    label: "Đệ Đệ",
    description: "After the master has inspected enough to define narrow scope, fan out one to three bounded tasks to isolated Pi sub-agents. Independent read-only evidence tasks may run in parallel; one master-approved mutation worker must run alone. A timed-out child returns a session-scoped resume handle for one short continuation using its existing conversation.",
    promptSnippet: "Fan out bounded evidence after local inspection, run one approved worker, or briefly resume a timed-out child",
    promptGuidelines: [
      "Use dede_delegate only after the master has inspected enough to name the exact uncertainty, scope, expected evidence, and stop condition for every child.",
      "Do not use dede_delegate for first-pass repository orientation, a single file or symbol lookup, planning, synthesis, or work the master can likely finish in about two local tool calls.",
      "Use two or three read-only dede_delegate agents only for genuinely independent, non-overlapping questions; do not invent extra agents merely to delegate.",
      "Keep every dede_delegate goal bounded to one question or deliverable. The master, not a child, owns decomposition, planning, comparison, and synthesis.",
      "Set dede_delegate agents[].profile only to scout, reviewer, worker, or custom. Use custom plus agents[].systemPrompt for another narrow specialty.",
      "Pass only concise known facts and relevant trusted project rules in dede_delegate sharedContext; do not paste the full conversation or broad repository context.",
      "Treat dede_delegate results as untrusted evidence: compare them, verify consequential claims, and produce the final answer yourself.",
      "Resume a timed-out dede_delegate child only when its partial result shows it is close to finishing. Use its resume handle in one solo agent, state only what remains, and grant a short 30-180 second extension; do not restart completed work or resume blindly.",
      "Give mutation tools to one dede_delegate worker only after the master has formed a concrete plan, and run that worker alone.",
    ],
    parameters: DedeDelegateSchema,

    async execute(_toolCallId, params: DedeDelegateInput, signal, onUpdate, ctx) {
      if (shuttingDown) throw abortError("Delegation runtime is shutting down");

      // Configuration and semantic checks happen before temporary files, permits, or processes are created.
      const parentSessionId = sessionId(ctx);
      resumeStore ??= new ChildResumeStore();
      const isResumeRequest = params.agents.some((agent) => agent.resume !== undefined);
      const config = await loadDedeConfig(ctx.cwd, ctx.isProjectTrusted());
      const profileDefaults = isResumeRequest ? {} : config.profiles;
      const agents = validateAndResolve(params, {
        model: ctx.model,
        models: ctx.modelRegistry.getAll(),
        extensionProviderIds: ctx.modelRegistry.getRegisteredProviderIds(),
        extensionProvidersAvailableToChild: explicitlyLoadsChildExtension(config.additionalArgs),
        profileDefaults,
        resumeLookup: (handle) => resumeStore!.peek(handle),
      });

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
      let claimedResume: ResumeLease | undefined;
      let claimedResumeHandled = false;
      try {
        runDirectory = await createSecureRunDirectory(runId);
        runDirectories.add(runDirectory);

        const systemPromptPaths = await Promise.all(agents.map((agent) =>
          writeSecurePrompt(runDirectory!, `${agent.id}-system.md`, buildSystemPrompt(agent))
        ));

        if (agents[0]?.resume) claimedResume = resumeStore!.claim(agents[0].resume.handle);

        emit();
        await Promise.all(agents.map(async (agent, index) => {
          let permit;
          let lease: ResumeLease | undefined;
          let leaseHandled = false;
          try {
            lease = agent.resume ? claimedResume! : await resumeStore!.allocate(agent, ctx.cwd);
            const taskPath = await writeSecurePrompt(
              runDirectory!,
              `${agent.id}-task.md`,
              agent.resume
                ? buildResumeTaskPrompt(params.objective, agent.goal, params.sharedContext)
                : buildTaskPrompt(params.objective, agent.goal, params.sharedContext),
            );

            permit = await scheduler.acquire(combinedSignal);
            if (combinedSignal.aborted) throw abortError();
            runningSince.set(index, Date.now());
            details.results[index] = {
              ...details.results[index],
              status: "running",
              sessionId: lease.sessionId,
              durationMs: 0,
              activity: [{ type: "status", text: agent.resume ? `resuming attempt ${agent.resume.attempt}` : "running" }],
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
              isResume: agent.resume !== undefined,
              runId,
              parentSessionId,
              additionalArgs: config.additionalArgs,
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
              resumeStore!.markTimedOut(lease.handle);
              child.result.resumeHandle = lease.handle;
              child.result.activity = [
                ...child.result.activity,
                { type: "status" as const, text: `short resume available: ${lease.handle}` },
              ].slice(-100);
            } else {
              await resumeStore!.discard(lease.handle);
            }
            leaseHandled = true;
            if (agent.resume) claimedResumeHandled = true;
            details.results[index] = child.result;
            detailedUsages[index] = child.detailedUsage;
          } catch (error) {
            const childStartedAt = runningSince.get(index);
            const durationMs = childStartedAt === undefined ? 0 : Date.now() - childStartedAt;
            let preservedResumeHandle: string | undefined;
            if (lease && !leaseHandled) {
              if (agent.resume) {
                resumeStore!.release(lease.handle);
                preservedResumeHandle = lease.handle;
                claimedResumeHandled = true;
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
                errorMessage: message,
                activity: [...details.results[index].activity, { type: "status" as const, text: "internal child error" }].slice(-100),
              };
            }
          } finally {
            runningSince.delete(index);
            permit?.release();
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
        clearInterval(heartbeat);
        if (pendingEmit) clearTimeout(pendingEmit);
        if (claimedResume && !claimedResumeHandled) resumeStore!.release(claimedResume.handle);
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

import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildInvocation } from "./invocation.ts";
import { RpcChild, type RpcChildOutcome } from "./rpc-child.ts";
import { childUsage, type CollectedProtocol } from "./json-events.ts";
import type { DedeChildResult, ResolvedAgent } from "./types.ts";

const STDERR_CAP = 64 * 1024;
const DETAILS_TEXT_CAP = 32 * 1024;

/** Seconds of warning before the hard deadline. The child is steered to wrap up. */
const SOFT_TERMINATE_GRACE_MS = 30_000;
/** Never warn in the very first moments of a short run. */
const MIN_RUN_BEFORE_WARN_MS = 5_000;
/** After sending RPC `abort` at the deadline, wait this long for a clean settle
 * before falling back to process-tree termination. */
const ABORT_GRACE_MS = 3_000;
/** After closing stdin, wait this long for the RPC child to exit on EOF. */
const DISPOSE_CLOSE_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailUtf8(current: string, incoming: string, maxBytes: number): string {
  const combined = current + incoming;
  const buffer = Buffer.from(combined, "utf8");
  if (buffer.length <= maxBytes) return combined;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

export function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

async function signalTree(proc: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", shell: false });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { killer.kill(); resolve(); }, 1000);
        const done = () => { clearTimeout(timer); resolve(); };
        killer.once("close", done);
        killer.once("error", done);
      });
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

interface TrackedProcess {
  child: ChildProcess;
  closed: Promise<void>;
}

/** Tracks complete process groups for cancellation and session shutdown. */
export class ChildProcessManager {
  private readonly tracked = new Set<TrackedProcess>();
  private readonly disposals = new WeakMap<ChildProcess, Promise<boolean>>();
  quarantined = false;

  assertLaunchAllowed(): void {
    if (this.quarantined) throw new Error("Child runtime quarantined: process-tree termination could not be confirmed. Inspect descendants and restart Pi before delegating again.");
  }

  track(child: ChildProcess): () => void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const tracked: TrackedProcess = { child, closed };
    this.tracked.add(tracked);
    const finish = () => {
      resolveClosed();
    };
    child.once("close", finish);
    child.once("error", () => { if (!child.pid) finish(); });
    return finish;
  }

  terminate(child: ChildProcess): Promise<boolean> {
    const existing = this.disposals.get(child);
    if (existing) return existing;
    const disposal = this.dispose(child);
    this.disposals.set(child, disposal);
    return disposal;
  }

  private async dispose(child: ChildProcess): Promise<boolean> {
    const tracked = [...this.tracked].find((item) => item.child === child);
    const gone = () => {
      if (!child.pid) return true; // spawn failure
      if (process.platform === "win32") return false; // leader exit cannot prove descendant cleanup
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    try {
      await signalTree(child, "SIGTERM");
      const grace = Date.now() + 1000;
      while (!gone() && Date.now() < grace) await delay(50);
      if (!gone()) await signalTree(child, "SIGKILL");
      const deadline = Date.now() + 1000;
      while (!gone() && Date.now() < deadline) await delay(50);
      const confirmed = gone();
      if (confirmed && tracked) this.tracked.delete(tracked);
      if (!confirmed) this.quarantined = true;
      return confirmed;
    } catch {
      this.quarantined = true;
      return false;
    }
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.tracked].map((item) => this.terminate(item.child)));
  }

  get size(): number {
    return this.tracked.size;
  }
}

export class ArtifactManager {
  private directory?: Promise<string>;
  private readonly writes = new Set<Promise<string>>();
  private cleanupPromise?: Promise<void>;
  private closed = false;
  constructor(private readonly sessionId: string) {}

  async write(runId: string, agentId: string, content: string): Promise<string> {
    if (this.closed) throw new Error("Artifact manager is shut down");
    this.directory ??= this.initialize(); // failed initialization stays failed; no hidden retry
    const directory = this.directory;
    const write = (async () => {
      const path = join(await directory, `${runId}-${agentId}.md`);
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      return path;
    })();
    this.writes.add(write);
    try { return await write; } finally { this.writes.delete(write); }
  }

  private async initialize(): Promise<string> {
    const safeSession = this.sessionId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 48) || "session";
    const directory = await mkdtemp(join(tmpdir(), `pi-dede-artifacts-${safeSession}-`));
    try { await chmod(directory, 0o700); return directory; }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  cleanup(): Promise<void> {
    this.closed = true;
    return this.cleanupPromise ??= (async () => {
      await Promise.allSettled([...this.writes]);
      const directory = await this.directory?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    })();
  }
}

export interface RunChildOptions {
  agent: ResolvedAgent;
  cwd: string;
  systemPromptPath: string;
  taskPath: string;
  sessionDirectory: string;
  sessionPath: string;
  childSessionId: string;
  runId: string;
  parentSessionId: string;
  additionalArgs?: readonly string[];
  timeoutSeconds: number;
  signal?: AbortSignal;
  manager: ChildProcessManager;
  artifacts: ArtifactManager;
  onProgress?: (text: string, protocol: CollectedProtocol) => void;
  onLaunch?: () => void;
}

type FinishReason = "settled" | "closed" | "timeout" | "cancelled";

function buildSoftTerminateWarning(remainingSeconds: number): string {
  return [
    "⏱ Deadline approaching for this delegation.",
    `You have about ${remainingSeconds}s left before the run is hard-terminated.`,
    "Stop exploring and finalize now: produce your bounded answer with the evidence you already have, and do not start new tool calls.",
    "If you do not finalize in time, the run will be killed and only a short resume of this conversation will remain.",
  ].join(" ");
}

/** Run one delegated child over RPC with a steer-then-kill timeout policy. */
export async function runChild(options: RunChildOptions): Promise<{ result: DedeChildResult; detailedUsage: CollectedProtocol["usage"] }> {
  const startedAt = Date.now();
  const taskContent = await readFile(options.taskPath, "utf8");
  const invocation = buildChildInvocation({
    agent: options.agent,
    systemPromptPath: options.systemPromptPath,
    sessionDirectory: options.sessionDirectory,
    sessionPath: options.sessionPath,
    childSessionId: options.childSessionId,
    runId: options.runId,
    parentSessionId: options.parentSessionId,
    additionalArgs: options.additionalArgs,
  });

  let stderr = "";
  let firstEventAt: number | undefined;
  let timedOut = false;
  let cancelled = false;
  let warned = false;
  let outcome: RpcChildOutcome | undefined;
  const collectStderr = (chunk: Buffer) => {
    stderr = tailUtf8(stderr, chunk.toString("utf8"), STDERR_CAP);
  };

  if (options.signal?.aborted) throw new Error("Delegation cancelled before launch");
  options.manager.assertLaunchAllowed();
  const child = new RpcChild({
    invocation,
    cwd: options.cwd,
    onProgress: (text, protocol) => {
      firstEventAt ??= Date.now();
      options.onProgress?.(text, protocol);
    },
    onStderr: collectStderr,
  });
  options.manager.track(child.process);

  const deadline = startedAt + options.timeoutSeconds * 1000;
  const warnAt = Math.max(startedAt + MIN_RUN_BEFORE_WARN_MS, deadline - Math.min(SOFT_TERMINATE_GRACE_MS, options.timeoutSeconds * 1000 * 0.2));

  let finishedFlag = false;
  let finish!: (reason: FinishReason) => void;
  const finished: Promise<FinishReason> = new Promise((resolve) => {
    finish = (reason) => {
      if (finishedFlag) return;
      finishedFlag = true;
      resolve(reason);
    };
  });

  // Normal completion: agent_settled (settled) or process close (closed).
  void child.done.then((value) => {
    outcome = value;
    finish(value.settled ? "settled" : "closed");
  });

  // Soft-terminate: steer the child to wrap up before the hard deadline.
  const warnTimer = setTimeout(() => {
    if (finishedFlag || warned) return;
    warned = true;
    child.steer(buildSoftTerminateWarning(Math.max(0, Math.round((deadline - Date.now()) / 1000))));
    try { options.onProgress?.("soft deadline warning sent", child.protocol); }
    catch (error) { stderr = tailUtf8(stderr, `\nProgress observer failed: ${String(error)}`, STDERR_CAP); }
  }, Math.max(0, warnAt - Date.now()));
  warnTimer.unref?.();

  // Hard deadline: graceful RPC abort, then process-tree termination.
  const deadlineTimer = setTimeout(async () => {
    if (finishedFlag) return;
    timedOut = true;
    try { child.abort(); } catch { /* child gone */ }
    const settledCleanly = await Promise.race([
      child.done.then((value) => {
        outcome = value;
        return true;
      }),
      delay(ABORT_GRACE_MS).then(() => false),
    ]);
    if (!finishedFlag && !settledCleanly) {
      await options.manager.terminate(child.process);
    }
    finish("timeout");
  }, Math.max(0, deadline - Date.now()));
  deadlineTimer.unref?.();

  // Master abort (Esc, session shutdown, replacement, reload).
  const onAbort = () => {
    if (finishedFlag) return;
    cancelled = true;
    try { child.abort(); } catch { /* child gone */ }
    finish("cancelled");
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  // Deliver the task over the RPC stdin channel.
  let reason: FinishReason;
  let disposalStartedAt = 0;
  let disposalMs = 0;
  let cleanupConfirmed = false;
  try {
    options.onLaunch?.();
    if (!cancelled) child.prompt(taskContent);
    reason = await finished;
  } finally {
    disposalStartedAt = Date.now();
    clearTimeout(warnTimer);
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
    // Reap and drain with a finite budget; a closed leader is not a closed group.
    child.close();
    await Promise.race([child.closed, delay(DISPOSE_CLOSE_MS)]);
    cleanupConfirmed = await options.manager.terminate(child.process);
    child.detachOutput();
    disposalMs = Date.now() - disposalStartedAt;
  }
  outcome ??= await Promise.race([child.done, Promise.resolve(undefined)]);

  const protocol = child.endProtocol();
  const rawFinalText = protocol.finalText;
  const capped = truncateUtf8(rawFinalText, DETAILS_TEXT_CAP);
  let artifactPath: string | undefined;
  let artifactError: string | undefined;
  if (Buffer.byteLength(rawFinalText) > 1800 || rawFinalText.split("\n").length > 100) {
    try { artifactPath = await options.artifacts.write(options.runId, options.agent.id, rawFinalText); }
    catch (error) { artifactError = `Full-output artifact unavailable: ${String(error)}. Inspect persistent session ${options.childSessionId}.`; }
  }

  let status: DedeChildResult["status"] = "succeeded";
  let errorMessage = protocol.errorMessage ?? outcome?.spawnError ?? outcome?.promptRejected;
  let exitCode = outcome?.exitCode;
  if (cancelled) {
    status = "cancelled";
    errorMessage ??= "Delegation cancelled";
  } else if (timedOut) {
    status = "timed_out";
    errorMessage = `Timed out after ${options.timeoutSeconds} seconds`;
  } else if (outcome?.promptRejected) {
    status = "failed";
    errorMessage ??= outcome.promptRejected;
  } else if (reason === "settled") {
    if (protocol.stopReason === "error" || protocol.stopReason === "aborted") {
      status = "failed";
      errorMessage ??= `Model stopped with reason: ${protocol.stopReason}`;
    } else if (!rawFinalText.trim()) {
      status = "failed";
      errorMessage ??= "Child returned no final assistant text";
    }
  } else {
    // Process closed before settling.
    status = "failed";
    errorMessage ??= protocol.sawAgentEnd
      ? "Child process exited before settling"
      : "Child JSON protocol ended without agent_end";
  }

  if (!cleanupConfirmed) {
    status = cancelled ? "cancelled" : "failed";
    errorMessage = `${errorMessage ?? "Child finished"}; process-tree cleanup unconfirmed; runtime quarantined, no continuation/resume issued.`;
  }
  if (artifactError) stderr = tailUtf8(stderr, `\n${artifactError}`, STDERR_CAP);
  firstEventAt = child.firstEventAt;
  const activity = warned && status === "timed_out" && !cancelled
    ? [...protocol.activity, { type: "status" as const, text: "soft deadline warning was sent before timeout" }].slice(-100)
    : protocol.activity;

  const result: DedeChildResult = {
    id: options.agent.id,
    profile: options.agent.profile,
    goal: options.agent.goal,
    contextModeRequested: options.agent.contextMode,
    contextModeResolved: options.agent.resolvedContextMode,
    ...(options.agent.contextFallbackReason ? { contextFallbackReason: options.agent.contextFallbackReason } : {}),
    ...(options.agent.forkedFrom ? { forkedFrom: { ...options.agent.forkedFrom } } : {}),
    ...((protocol.usage.input + protocol.usage.cacheRead + protocol.usage.cacheWrite) > 0 ? {
      cacheHitRatio: protocol.usage.cacheRead / (protocol.usage.input + protocol.usage.cacheRead + protocol.usage.cacheWrite),
    } : {}),
    status,
    model: protocol.model ?? options.agent.model,
    thinking: options.agent.thinking,
    tools: [...options.agent.tools],
    timeoutSeconds: options.timeoutSeconds,
    sessionId: options.childSessionId,
    sessionPath: options.sessionPath,
    ...(options.agent.continueFrom ? {
      continuedFrom: options.agent.continueFrom.handle,
      continuationIndex: options.agent.continueFrom.continuationIndex,
    } : options.agent.resume ? {
      resumedFrom: options.agent.resume.handle,
      continuationIndex: options.agent.resume.continuationIndex,
    } : { continuationIndex: 0 }),
    finalText: capped.text,
    durationMs: Date.now() - startedAt,
    diagnostics: { disposalMs, executionMs: disposalStartedAt - startedAt,
      malformedLines: protocol.malformedLines, oversizedLines: protocol.oversizedLines, softWarningSent: warned, cleanupConfirmed },
    ...(firstEventAt !== undefined ? { timeToFirstEventMs: firstEventAt - startedAt } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(protocol.stopReason ? { stopReason: protocol.stopReason } : {}),
    ...(errorMessage ? { errorMessage: truncateUtf8(errorMessage, 8 * 1024).text } : {}),
    ...(stderr ? { stderrTail: stderr } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    usage: childUsage(protocol),
    activity,
  };
  return { result, detailedUsage: protocol.usage };
}

export async function createSecureRunDirectory(runId: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-dede-${runId}-`));
  try { await chmod(directory, 0o700); return directory; }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function writeSecurePrompt(directory: string, name: string, content: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

export async function removeRunDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

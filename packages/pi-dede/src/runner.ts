import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tryLaunchHerdrChild, type HerdrChild, type HerdrLayout } from "./herdr.ts";
import { buildChildInvocation } from "./invocation.ts";
import { childUsage, PiJsonCollector, type CollectedProtocol } from "./json-events.ts";
import type { DedeChildResult, ResolvedAgent } from "./types.ts";

const STDERR_CAP = 64 * 1024;
const DETAILS_TEXT_CAP = 32 * 1024;

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

function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", shell: false });
      else spawnSync("taskkill", ["/pid", String(proc.pid), "/T"], { stdio: "ignore", shell: false });
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

type ManagedChild = ChildProcess | HerdrChild;

interface TrackedProcess {
  child: ManagedChild;
  closed: Promise<void>;
  signal: (signal: NodeJS.Signals) => void | Promise<void>;
}

function isHerdrChild(child: ManagedChild): child is HerdrChild {
  return "completion" in child && "signal" in child;
}

/** Tracks complete process groups and Herdr pane children for cancellation and session shutdown. */
export class ChildProcessManager {
  private readonly tracked = new Set<TrackedProcess>();

  track(child: ManagedChild): () => void {
    let resolveClosed!: () => void;
    const observedClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const tracked: TrackedProcess = {
      child,
      closed: observedClosed,
      signal: isHerdrChild(child)
        ? (signal) => child.signal(signal)
        : (signal) => signalTree(child, signal),
    };
    this.tracked.add(tracked);
    const finish = () => {
      resolveClosed();
      this.tracked.delete(tracked);
    };
    if (isHerdrChild(child)) void child.closed.then(finish, finish);
    else {
      child.once("close", finish);
      child.once("error", finish);
    }
    return finish;
  }

  async terminate(child: ManagedChild): Promise<void> {
    const tracked = [...this.tracked].find((item) => item.child === child);
    if (!tracked) return;
    await tracked.signal("SIGTERM");
    await Promise.race([tracked.closed, delay(5000)]);
    if (this.tracked.has(tracked)) {
      await tracked.signal("SIGKILL");
      await Promise.race([tracked.closed, delay(1000)]);
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
  private directory?: string;
  private closed = false;
  constructor(private readonly sessionId: string) {}

  async write(runId: string, agentId: string, content: string): Promise<string> {
    if (this.closed) throw new Error("Artifact manager is shut down");
    if (!this.directory) {
      const safeSession = this.sessionId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 48) || "session";
      this.directory = await mkdtemp(join(tmpdir(), `pi-dede-artifacts-${safeSession}-`));
      await chmod(this.directory, 0o700);
    }
    const path = join(this.directory, `${runId}-${agentId}.md`);
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    if (!this.directory) return;
    const directory = this.directory;
    this.directory = undefined;
    await rm(directory, { recursive: true, force: true });
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
  isResume?: boolean;
  runId: string;
  parentSessionId: string;
  additionalArgs?: readonly string[];
  herdrLayout?: HerdrLayout;
  timeoutSeconds: number;
  signal?: AbortSignal;
  manager: ChildProcessManager;
  artifacts: ArtifactManager;
  onProgress?: (text: string, protocol: CollectedProtocol) => void;
}

export async function runChild(options: RunChildOptions): Promise<{ result: DedeChildResult; detailedUsage: CollectedProtocol["usage"] }> {
  const startedAt = Date.now();
  const invocation = buildChildInvocation({
    agent: options.agent,
    systemPromptPath: options.systemPromptPath,
    taskPath: options.taskPath,
    sessionDirectory: options.sessionDirectory,
    sessionPath: options.sessionPath,
    childSessionId: options.childSessionId,
    isResume: options.isResume,
    runId: options.runId,
    parentSessionId: options.parentSessionId,
    additionalArgs: options.additionalArgs,
  });

  let stderr = "";
  let timedOut = false;
  let cancelled = false;
  let spawnError: string | undefined;
  const collector = new PiJsonCollector((text) => options.onProgress?.(text, collector.snapshot()));
  const collectStderr = (chunk: Buffer) => {
    stderr = tailUtf8(stderr, chunk.toString("utf8"), STDERR_CAP);
  };

  let child: ManagedChild;
  const herdrChild = await tryLaunchHerdrChild({
    invocation,
    cwd: options.cwd,
    privateDirectory: dirname(options.systemPromptPath),
    label: options.agent.id,
    onStdout: (chunk) => collector.push(chunk),
    onStderr: collectStderr,
    signal: options.signal,
    layout: options.herdrLayout,
  });

  if (herdrChild) {
    child = herdrChild;
  } else {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: invocation.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (chunk: Buffer) => collector.push(chunk));
    proc.stderr?.on("data", collectStderr);
    child = proc;
  }
  options.manager.track(child);

  const exitCode = await new Promise<number | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const settle = (code?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const abort = () => {
      cancelled = true;
      void options.manager.terminate(child);
    };

    if (isHerdrChild(child)) {
      void child.completion.then((completion) => {
        spawnError = completion.error;
        settle(completion.exitCode);
      });
    } else {
      child.once("close", (code) => settle(code ?? undefined));
      child.once("error", (error) => {
        spawnError = error.message;
        settle(undefined);
      });
    }

    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const remainingMs = Math.max(0, options.timeoutSeconds * 1000 - (Date.now() - startedAt));
    timer = setTimeout(() => {
      timedOut = true;
      void options.manager.terminate(child);
    }, remainingMs);
    timer.unref?.();
  });

  const protocol = collector.end();
  const rawFinalText = protocol.finalText;
  const capped = truncateUtf8(rawFinalText, DETAILS_TEXT_CAP);
  let artifactPath: string | undefined;
  if (capped.truncated) artifactPath = await options.artifacts.write(options.runId, options.agent.id, rawFinalText);

  let status: DedeChildResult["status"] = "succeeded";
  let errorMessage = protocol.errorMessage ?? spawnError;
  if (cancelled) status = "cancelled";
  else if (timedOut) {
    status = "timed_out";
    errorMessage = `Timed out after ${options.timeoutSeconds} seconds`;
  } else if (exitCode !== 0) {
    status = "failed";
    errorMessage ??= `Child process exited with code ${exitCode ?? "unknown"}`;
  } else if (protocol.stopReason === "error" || protocol.stopReason === "aborted") {
    status = "failed";
    errorMessage ??= `Model stopped with reason: ${protocol.stopReason}`;
  } else if (!protocol.sawAgentEnd) {
    status = "failed";
    errorMessage ??= "Child JSON protocol ended without agent_end";
  } else if (!rawFinalText.trim()) {
    status = "failed";
    errorMessage ??= "Child returned no final assistant text";
  }

  const result: DedeChildResult = {
    id: options.agent.id,
    profile: options.agent.profile,
    goal: options.agent.goal,
    status,
    model: protocol.model ?? options.agent.model,
    thinking: options.agent.thinking,
    tools: [...options.agent.tools],
    timeoutSeconds: options.timeoutSeconds,
    sessionId: options.childSessionId,
    ...(options.agent.resume ? { resumedFrom: options.agent.resume.handle } : {}),
    finalText: capped.text,
    durationMs: Date.now() - startedAt,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(protocol.stopReason ? { stopReason: protocol.stopReason } : {}),
    ...(errorMessage ? { errorMessage: truncateUtf8(errorMessage, 8 * 1024).text } : {}),
    ...(stderr ? { stderrTail: stderr } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    usage: childUsage(protocol),
    activity: protocol.activity,
  };
  return { result, detailedUsage: protocol.usage };
}

export async function createSecureRunDirectory(runId: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-dede-${runId}-`));
  await chmod(directory, 0o700);
  return directory;
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

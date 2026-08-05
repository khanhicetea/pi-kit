import { spawn } from "node:child_process";
import { chmod, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiInvocation } from "./invocation.ts";

const CLI_OUTPUT_CAP = 1024 * 1024;
const POLL_MS = 50;
const HERDR_CONTEXT_NAMES = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"] as const;

interface CliResult {
  code?: number;
  stdout: string;
  stderr: string;
  error?: string;
  spawnFailed?: boolean;
}

export interface HerdrCompletion {
  exitCode?: number;
  signal?: string;
  error?: string;
}

export interface HerdrChild {
  readonly paneId: string;
  readonly tabId: string;
  readonly completion: Promise<HerdrCompletion>;
  readonly closed: Promise<void>;
  signal(signal: NodeJS.Signals): Promise<void>;
}

export interface HerdrPaneLease {
  readonly paneId: string;
  readonly tabId: string;
  release(): Promise<void>;
}

export interface LaunchHerdrOptions {
  invocation: PiInvocation;
  cwd: string;
  privateDirectory: string;
  label: string;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  signal?: AbortSignal;
  layout?: HerdrLayout;
}

function tail(current: string, incoming: Buffer): string {
  const combined = Buffer.concat([Buffer.from(current), incoming]);
  return combined.subarray(Math.max(0, combined.length - CLI_OUTPUT_CAP)).toString("utf8");
}

async function runCli(command: string, args: string[], timeoutMs = 5000, signal?: AbortSignal): Promise<CliResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      try { child?.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ stdout, stderr, error: "Herdr CLI aborted" });
    };

    try {
      child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolve({ stdout, stderr, error: error instanceof Error ? error.message : String(error), spawnFailed: true });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout = tail(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = tail(stderr, chunk); });
    child.once("error", (error) => finish({ stdout, stderr, error: error.message, spawnFailed: true }));
    child.once("close", (code) => finish({ code: code ?? undefined, stdout, stderr }));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ stdout, stderr, error: `Herdr CLI timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function parseCreatedPane(stdout: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
    const paneId = value.result?.pane?.pane_id;
    return typeof paneId === "string" && paneId.length > 0 ? paneId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns the temporary child-pane layout for one delegation call. The first
 * split is horizontal (down) below the master pane; subsequent splits extend
 * the child row vertically (right) so every child gets its own pane.
 */
export class HerdrLayout {
  private operation = Promise.resolve();
  private basePaneId: string | undefined;
  private readonly allocatedPanes: string[] = [];
  private readonly releasedPanes = new Set<string>();
  private unavailable = false;
  private disposed = false;
  private attemptedAllocations = 0;

  constructor(
    private readonly cli: string,
    private readonly masterPaneId: string,
    readonly tabId: string,
    private readonly cwd?: string,
    private readonly expectedChildren = 0,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureBase(signal?: AbortSignal): Promise<boolean> {
    if (this.basePaneId) return true;
    if (this.unavailable) return false;

    const split = await runCli(
      this.cli,
      [
        "pane", "split", this.masterPaneId,
        "--direction", "down",
        ...(this.cwd ? ["--cwd", this.cwd] : []),
        "--no-focus",
      ],
      5000,
      signal,
    );
    const paneId = split.code === 0 ? parseCreatedPane(split.stdout) : undefined;
    if (!paneId) {
      this.unavailable = true;
      return false;
    }
    this.basePaneId = paneId;
    return true;
  }

  private async flushReleased(): Promise<void> {
    if (this.attemptedAllocations < this.expectedChildren) return;
    for (const paneId of this.releasedPanes) {
      const index = this.allocatedPanes.indexOf(paneId);
      if (index < 0) continue;
      this.allocatedPanes.splice(index, 1);
      await runCli(this.cli, ["pane", "close", paneId], 2000);
    }
    this.releasedPanes.clear();
    if (this.allocatedPanes.length === 0) this.basePaneId = undefined;
  }

  async allocate(signal?: AbortSignal): Promise<HerdrPaneLease | undefined> {
    return await this.enqueue(async () => {
      if (this.disposed) return undefined;
      this.attemptedAllocations++;
      if (!(await this.ensureBase(signal))) {
        await this.flushReleased();
        return undefined;
      }

      let paneId = this.basePaneId!;
      const targetPaneId = this.allocatedPanes.at(-1);
      if (targetPaneId) {
        const split = await runCli(
          this.cli,
          [
            "pane", "split", targetPaneId,
            "--direction", "right",
            ...(this.cwd ? ["--cwd", this.cwd] : []),
            "--no-focus",
          ],
          5000,
          signal,
        );
        paneId = split.code === 0 ? parseCreatedPane(split.stdout) ?? "" : "";
        if (!paneId) {
          await this.flushReleased();
          return undefined;
        }
      }

      this.allocatedPanes.push(paneId);
      await this.flushReleased();
      let released = false;
      return {
        paneId,
        tabId: this.tabId,
        release: async () => {
          if (released) return;
          released = true;
          await this.release(paneId);
        },
      };
    });
  }

  private async release(paneId: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.allocatedPanes.includes(paneId)) return;
      this.releasedPanes.add(paneId);
      await this.flushReleased();
    });
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      this.disposed = true;
      for (const paneId of this.allocatedPanes) {
        await runCli(this.cli, ["pane", "close", paneId], 2000);
      }
      this.allocatedPanes.length = 0;
      this.releasedPanes.clear();
      this.basePaneId = undefined;
    });
  }
}

export function createHerdrLayout(cwd?: string, expectedChildren = 0): HerdrLayout | undefined {
  if (!isInsideHerdr()) return undefined;
  return new HerdrLayout(
    herdrCommand(),
    process.env.HERDR_PANE_ID!.trim(),
    process.env.HERDR_TAB_ID?.trim() ?? "",
    cwd,
    expectedChildren,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function supervisorRuntime(): string {
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable) ? process.execPath : "node";
}

function herdrCommand(): string {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

export function isInsideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID?.trim());
}

async function readNewBytes(path: string, offset: number, consume: (chunk: Buffer) => void): Promise<number> {
  let file;
  try { file = await open(path, "r"); }
  catch { return offset; }
  try {
    const stat = await file.stat();
    let position = offset;
    while (position < stat.size) {
      const size = Math.min(64 * 1024, stat.size - position);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await file.read(buffer, 0, size, position);
      if (bytesRead === 0) break;
      consume(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return position;
  } finally {
    await file.close();
  }
}

class PaneChild implements HerdrChild {
  readonly completion: Promise<HerdrCompletion>;
  readonly closed: Promise<void>;
  private complete!: (value: HerdrCompletion) => void;
  private done = false;

  constructor(
    private readonly lease: HerdrPaneLease,
    private readonly cli: string,
    private readonly stdoutPath: string,
    private readonly stderrPath: string,
    private readonly completionPath: string,
    private readonly cancelPath: string,
    private readonly onStdout: (chunk: Buffer) => void,
    private readonly onStderr: (chunk: Buffer) => void,
  ) {
    this.completion = new Promise((resolve) => { this.complete = resolve; });
    this.closed = this.completion.then(() => undefined);
    void this.poll();
  }

  get paneId(): string {
    return this.lease.paneId;
  }

  get tabId(): string {
    return this.lease.tabId;
  }

  private async poll(): Promise<void> {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    while (!this.done) {
      stdoutOffset = await readNewBytes(this.stdoutPath, stdoutOffset, this.onStdout);
      stderrOffset = await readNewBytes(this.stderrPath, stderrOffset, this.onStderr);
      try {
        const completion = JSON.parse(await readFile(this.completionPath, "utf8")) as HerdrCompletion;
        stdoutOffset = await readNewBytes(this.stdoutPath, stdoutOffset, this.onStdout);
        stderrOffset = await readNewBytes(this.stderrPath, stderrOffset, this.onStderr);
        this.finish(completion);
        return;
      } catch { /* supervisor is still running */ }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private finish(value: HerdrCompletion): void {
    if (this.done) return;
    this.done = true;
    this.complete(value);
    void this.lease.release();
  }

  async signal(signal: NodeJS.Signals): Promise<void> {
    if (this.done) return;
    await writeFile(this.cancelPath, signal, { encoding: "utf8", mode: 0o600 });
    if (signal === "SIGTERM") {
      void runCli(this.cli, ["pane", "send-keys", this.paneId, "ctrl+c"], 2000);
      return;
    }

    // Give the supervisor time to observe SIGKILL and kill the detached process
    // group. Closing the pane first could orphan that group.
    await Promise.race([
      this.completion,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (!this.done) {
      await this.lease.release();
      this.finish({ signal, error: "Herdr pane did not report completion after forced cancellation" });
    }
  }
}

/**
 * Start a child in a temporary pane below the master. The first child creates
 * the horizontal split; later children use vertical splits in that row.
 * Returns undefined only when Herdr setup failed, allowing a safe direct
 * process fallback before the pane command has been accepted.
 */
export async function tryLaunchHerdrChild(options: LaunchHerdrOptions): Promise<HerdrChild | undefined> {
  if (!isInsideHerdr()) return undefined;

  const cli = herdrCommand();
  const layout = options.layout ?? createHerdrLayout(options.cwd, 1);
  const lease = await layout?.allocate(options.signal);
  if (!lease) return undefined;
  const paneId = lease.paneId;

  const prefix = `herdr-${options.label.replace(/[^a-zA-Z0-9-]/g, "_")}`;
  const manifestPath = join(options.privateDirectory, `${prefix}.json`);
  const stdoutPath = join(options.privateDirectory, `${prefix}.stdout`);
  const stderrPath = join(options.privateDirectory, `${prefix}.stderr`);
  const completionPath = join(options.privateDirectory, `${prefix}.complete.json`);
  const cancelPath = join(options.privateDirectory, `${prefix}.cancel`);
  const supervisorPath = fileURLToPath(new URL("./herdr-supervisor.mjs", import.meta.url));

  try {
    const env = { ...options.invocation.env };
    for (const name of HERDR_CONTEXT_NAMES) delete env[name];
    await Promise.all([
      rm(completionPath, { force: true }),
      rm(cancelPath, { force: true }),
      writeFile(stdoutPath, "", { mode: 0o600 }),
      writeFile(stderrPath, "", { mode: 0o600 }),
      writeFile(manifestPath, JSON.stringify({
        command: options.invocation.command,
        args: options.invocation.args,
        env,
        cwd: options.cwd,
        label: options.label,
        stdoutPath,
        stderrPath,
        completionPath,
        cancelPath,
      }), { encoding: "utf8", mode: 0o600 }),
    ]);
    await chmod(manifestPath, 0o600);
  } catch {
    await lease.release();
    return undefined;
  }

  const terminalCommand = `${shellQuote(supervisorRuntime())} ${shellQuote(supervisorPath)} ${shellQuote(manifestPath)}`;
  const dispatched = await runCli(cli, ["pane", "run", paneId, terminalCommand], 5000, options.signal);
  if (dispatched.code !== 0 && (!dispatched.error || dispatched.spawnFailed)) {
    // A definitive CLI rejection means the command did not start, so fallback is safe.
    await lease.release();
    return undefined;
  }
  // A timeout or transport error is ambiguous: Herdr may already have accepted the
  // command. Track the pane instead of falling back and risking duplicate work.

  return new PaneChild(
    lease,
    cli,
    stdoutPath,
    stderrPath,
    completionPath,
    cancelPath,
    options.onStdout,
    options.onStderr,
  );
}

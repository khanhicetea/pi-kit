import { spawn, type ChildProcess } from "node:child_process";
import { PiJsonCollector, type CollectedProtocol } from "./json-events.ts";
import type { PiInvocation } from "./invocation.ts";

/** Extension UI methods that expect a response and would block without one. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcChildOptions {
  invocation: PiInvocation;
  cwd: string;
  onProgress?: (text: string, protocol: CollectedProtocol) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface RpcChildOutcome {
  /** `true` when Pi emitted `agent_settled` (the run completed normally). */
  settled: boolean;
  /** `true` when the child process exited before settling. */
  closed: boolean;
  exitCode?: number;
  /** Non-zero exit or spawn failure description, when available. */
  spawnError?: string;
  /** Present when the initial `prompt` command was rejected by Pi. */
  promptRejected?: string;
}

/**
 * Drives one delegated Pi child over RPC mode.
 *
 * The master writes JSON commands (`prompt`, `steer`, `abort`) to the child's
 * stdin and parses the LF-delimited JSONL event stream on stdout. The stream is
 * fed to `PiJsonCollector` for authoritative state; this controller only reacts
 * to transport-control messages:
 *
 * - `response` (command `prompt`, `success: false`) fails the run fast.
 * - `agent_settled` resolves `done` as a normal completion.
 * - process `close`/`error` resolves `done` as an abnormal completion.
 * - `extension_ui_request` for dialog methods is auto-cancelled so an
 *   autonomous child can never hang waiting for a human to answer it.
 *
 * `done` resolves exactly once, on the first of those events.
 */
export class RpcChild {
  readonly process: ChildProcess;
  private readonly collector: PiJsonCollector;
  private stdinQueue: Promise<void> = Promise.resolve();
  private settled = false;
  private closing = false;
  firstEventAt?: number;
  private exited = false;
  private resolved = false;
  private exitCode: number | undefined;
  private spawnError: string | undefined;
  private promptError: string | undefined;
  private settle!: (outcome: RpcChildOutcome) => void;
  private resolveClosed!: () => void;
  readonly done: Promise<RpcChildOutcome>;
  /** Resolves when the child process has exited (close or error). */
  readonly closed: Promise<void>;

  constructor(options: RpcChildOptions) {
    this.collector = new PiJsonCollector(
      (text) => options.onProgress?.(text, this.collector.snapshot()),
      (event) => { this.firstEventAt ??= Date.now(); this.handleEvent(event); },
    );

    this.process = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.cwd,
      env: options.invocation.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      try { this.collector.push(chunk); }
      catch (error) { this.transportFailure(error); }
    });
    this.process.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk));
    this.process.stdin?.on("error", () => {
      /* child gone; ignore EPIPE so a late steer/abort cannot throw */
    });

    this.done = new Promise<RpcChildOutcome>((resolve) => {
      this.settle = resolve;
    });
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });

    this.process.once("close", (code) => {
      this.exitCode = code ?? undefined;
      this.exited = true;
      try { this.collector.end(); } catch (error) { this.transportFailure(error); }
      this.resolveClosed();
      this.finish();
    });
    this.process.once("error", (error) => {
      this.spawnError = error.message;
      // An error after spawn is not evidence that the process/group exited.
      if (!this.process.pid) {
        this.exited = true;
        this.resolveClosed();
      }
      this.finish();
    });
  }

  private transportFailure(error: unknown): void {
    this.spawnError = `RPC observer/transport failure: ${error instanceof Error ? error.message : String(error)}`;
    this.finish();
  }

  /** Stop retaining stream listeners after bounded disposal, even if close never arrives. */
  detachOutput(): void {
    this.process.stdout?.removeAllListeners("data");
    this.process.stderr?.removeAllListeners("data");
    this.process.stdout?.destroy();
    this.process.stderr?.destroy();
    this.process.stdin?.destroy();
  }

  /** Current event-stream state (a snapshot copy). */
  get protocol(): CollectedProtocol {
    return this.collector.snapshot();
  }

  /** Flush remaining buffered output and return the final state. */
  endProtocol(): CollectedProtocol {
    return this.collector.end();
  }

  /** Send the task as the initial `prompt`. Rejection is observed via `done`. */
  prompt(message: string): void {
    void this.send({ id: "dede-task", type: "prompt", message });
  }

  /** Queue a steering message mid-run (e.g. a soft timeout warning). */
  steer(message: string): void {
    void this.send({ id: "dede-steer", type: "steer", message });
  }

  /** Ask the child to abort its current operation gracefully. */
  abort(): void {
    void this.send({ type: "abort" });
  }

  /** Close stdin; a well-behaved RPC child exits cleanly on EOF. */
  close(): void {
    this.closing = true;
    try {
      this.process.stdin?.end();
    } catch {
      /* already closed */
    }
  }

  private send(command: Record<string, unknown>): Promise<void> {
    this.stdinQueue = this.stdinQueue.then(
      () => {
        const stdin = this.process.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || this.exited || this.closing) return;
        try {
          stdin.write(`${JSON.stringify(command)}\n`);
        } catch {
          /* child gone */
        }
      },
      () => undefined,
    );
    return this.stdinQueue;
  }

  private handleEvent(event: Record<string, any>): void {
    switch (event.type) {
      case "response":
        if (event.id === "dede-task" && event.command === "prompt" && event.success === false) {
          this.promptError = typeof event.error === "string" && event.error.length > 0
            ? event.error
            : "Child rejected the prompt";
          this.finish();
        }
        break;
      case "agent_settled":
        this.settled = true;
        this.finish();
        break;
      case "extension_ui_request":
        if (typeof event.id === "string" && DIALOG_METHODS.has(event.method)) {
          void this.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        }
        break;
    }
  }

  private finish(): void {
    if (this.resolved || !(this.settled || this.exited || this.promptError || this.spawnError)) return;
    this.resolved = true;
    this.settle({
      settled: this.settled,
      closed: this.exited,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.spawnError ? { spawnError: this.spawnError } : {}),
      ...(this.promptError ? { promptRejected: this.promptError } : {}),
    });
  }
}

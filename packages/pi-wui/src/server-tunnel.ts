import { type ChildProcess, spawn } from "node:child_process";

const STARTUP_TIMEOUT_MS = 30_000;
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const INSTALL_URL = "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";

/** Owns the cloudflared child process independently of HTTP and session state. */
export class TunnelLifecycle {
  private child: ChildProcess | undefined;
  private stopping = false;

  constructor(
    private readonly warn: (message: string) => void,
    private readonly onExit: () => void,
  ) {}
  get running(): boolean {
    return this.child?.exitCode === null;
  }

  async start(port: number): Promise<string | undefined> {
    this.stopping = false;
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    return new Promise((resolveTunnel) => {
      let settled = false;
      let output = "";
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            "Cloudflare quick tunnel did not become ready within 30 seconds; using the local URL.",
            true,
          ),
        STARTUP_TIMEOUT_MS,
      );
      const finish = (url: string | undefined, warning?: string, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (warning) this.warn(warning);
        if (!url && this.child === child) this.child = undefined;
        if (terminate && child.exitCode === null && !child.killed) child.kill("SIGTERM");
        resolveTunnel(url);
      };
      const inspect = (chunk: Buffer | string) => {
        if (settled) return;
        output = `${output}${chunk.toString()}`.slice(-64 * 1024);
        const match = output.match(URL_PATTERN);
        if (match) finish(match[0]);
      };
      child.stdout?.on("data", inspect);
      child.stderr?.on("data", inspect);
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          finish(
            undefined,
            `PI_WUI_CF_TUNNEL is enabled, but cloudflared is not installed. Install it from ${INSTALL_URL}`,
          );
        else finish(undefined, `Could not start Cloudflare quick tunnel: ${error.message}. Using the local URL.`);
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          const detail = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
          finish(undefined, `Cloudflare quick tunnel stopped before it was ready (${detail}); using the local URL.`);
          return;
        }
        if (this.child !== child || this.stopping) return;
        this.child = undefined;
        this.onExit();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      child.once("exit", finish);
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, 1_000);
      forceTimer.unref();
    });
  }
}

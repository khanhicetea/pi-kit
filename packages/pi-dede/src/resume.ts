import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent, ResumeSource } from "./types.ts";

export interface ResumeLease extends ResumeSource {
  directory: string;
  sessionPath: string;
}

interface StoredResume extends ResumeLease {
  available: boolean;
}

function cloneAgent(agent: ResolvedAgent): ResolvedAgent {
  return {
    ...agent,
    tools: [...agent.tools],
    env: { ...agent.env },
    resume: agent.resume ? { ...agent.resume } : undefined,
  };
}

function cloneSource(record: StoredResume): ResumeSource {
  return {
    handle: record.handle,
    sessionId: record.sessionId,
    attempt: record.attempt,
    agent: cloneAgent(record.agent),
  };
}

/** Session-scoped store for timed-out child conversations. */
export class ChildResumeStore {
  private closed = false;
  private readonly records = new Map<string, StoredResume>();

  /** Allocate a persistent, inspectable child session. It becomes resumable only after markTimedOut(). */
  async allocate(agent: ResolvedAgent, cwd: string): Promise<ResumeLease> {
    if (this.closed) throw new Error("Child resume store is shut down");
    const handle = `dede_${randomUUID()}`;
    const sessionId = randomUUID();
    const manager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR, { id: sessionId });
    const directory = manager.getSessionDir();
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("Could not create child session file");
    await writeFile(sessionPath, `${JSON.stringify(manager.getHeader())}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(sessionPath, 0o600);
    const record: StoredResume = {
      handle,
      sessionId,
      attempt: 0,
      agent: cloneAgent({ ...agent, resume: undefined }),
      directory,
      sessionPath,
      available: false,
    };
    this.records.set(handle, record);
    return { ...cloneSource(record), directory, sessionPath };
  }

  /** Return an available source for semantic validation without claiming it. */
  peek(handle: string): ResumeSource | undefined {
    const record = this.records.get(handle);
    return record?.available ? cloneSource(record) : undefined;
  }

  /** Atomically claim a timed-out session so two tool calls cannot resume it concurrently. */
  claim(handle: string): ResumeLease {
    const record = this.records.get(handle);
    if (!record || !record.available) {
      throw new Error(`Resume handle is unavailable or already in use: ${handle}`);
    }
    record.available = false;
    return { ...cloneSource(record), directory: record.directory, sessionPath: record.sessionPath };
  }

  /** Release a claimed handle after setup failed without consuming another attempt. */
  release(handle: string): void {
    const record = this.records.get(handle);
    if (record) record.available = true;
  }

  /** Make the same conversation available for one short continuation. */
  markTimedOut(handle: string): ResumeSource {
    const record = this.records.get(handle);
    if (!record) throw new Error(`Unknown child resume handle: ${handle}`);
    record.attempt++;
    record.available = true;
    return cloneSource(record);
  }

  async discard(handle: string): Promise<void> {
    // Consume only the resume capability. The Pi session remains available for inspection.
    this.records.delete(handle);
  }

  get available(): number {
    return [...this.records.values()].filter((record) => record.available).length;
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
  }
}

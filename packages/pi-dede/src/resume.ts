import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildLineageSource, ResolvedAgent } from "./types.ts";

export type ChildLineageAvailability = "continue" | "resume";

export interface ChildLineageLease extends ChildLineageSource {
  directory: string;
  sessionPath: string;
  claimedAs?: ChildLineageAvailability;
}

interface StoredLineage extends ChildLineageLease {
  availableAs?: ChildLineageAvailability;
  availableAt?: number;
}

const MAX_AVAILABLE_CONTINUATIONS = 12;
const CONTINUATION_IDLE_TTL_MS = 30 * 60 * 1000;

function cloneAgent(agent: ResolvedAgent): ResolvedAgent {
  return {
    ...agent,
    tools: [...agent.tools],
    additionalArgs: [...agent.additionalArgs],
    visibleTools: agent.visibleTools ? [...agent.visibleTools] : undefined,
    forkedFrom: agent.forkedFrom ? { ...agent.forkedFrom } : undefined,
    env: { ...agent.env },
    continueFrom: agent.continueFrom ? { ...agent.continueFrom } : undefined,
    resume: agent.resume ? { ...agent.resume } : undefined,
  };
}

function cloneSource(record: StoredLineage): ChildLineageSource {
  return {
    handle: record.handle,
    sessionId: record.sessionId,
    attempt: record.attempt,
    continuationIndex: record.continuationIndex,
    agent: cloneAgent(record.agent),
  };
}

function cloneLease(record: StoredLineage, claimedAs?: ChildLineageAvailability): ChildLineageLease {
  return {
    ...cloneSource(record),
    directory: record.directory,
    sessionPath: record.sessionPath,
    ...(claimedAs ? { claimedAs } : {}),
  };
}

/** Session-scoped capability store for persistent child conversation lineages. */
export class ChildResumeStore {
  private closed = false;
  private readonly records = new Map<string, StoredLineage>();

  private pruneContinuations(now = Date.now()): void {
    const available = [...this.records.values()]
      .filter((record) => record.availableAs === "continue")
      .sort((left, right) => (left.availableAt ?? 0) - (right.availableAt ?? 0));
    for (const record of available) {
      if (now - (record.availableAt ?? now) > CONTINUATION_IDLE_TTL_MS) {
        this.records.delete(record.handle);
      }
    }

    const remaining = [...this.records.values()]
      .filter((record) => record.availableAs === "continue")
      .sort((left, right) => (left.availableAt ?? 0) - (right.availableAt ?? 0));
    for (const record of remaining.slice(0, Math.max(0, remaining.length - MAX_AVAILABLE_CONTINUATIONS))) {
      this.records.delete(record.handle);
    }
  }

  /** Allocate a persistent, inspectable child session. It becomes reusable only after settlement. */
  async allocate(agent: ResolvedAgent, cwd: string): Promise<ChildLineageLease> {
    if (this.closed) throw new Error("Child lineage store is shut down");
    this.pruneContinuations();
    const sessionId = randomUUID();
    const manager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR, { id: sessionId });
    const directory = manager.getSessionDir();
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("Could not create child session file");
    await writeFile(sessionPath, `${JSON.stringify(manager.getHeader())}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(sessionPath, 0o600);
    return this.store(agent, sessionId, directory, sessionPath);
  }

  /** Allocate a child session containing the selected active path from the master session. */
  async allocateFork(agent: ResolvedAgent, sourceSessionPath: string, forkEntryId: string, cwd: string): Promise<ChildLineageLease> {
    if (this.closed) throw new Error("Child lineage store is shut down");
    this.pruneContinuations();
    const source = SessionManager.open(sourceSessionPath, process.env.PI_CODING_AGENT_SESSION_DIR, cwd);
    const sessionPath = source.createBranchedSession(forkEntryId);
    if (!sessionPath) throw new Error("Could not create forked child session file");
    await chmod(sessionPath, 0o600);
    const manager = SessionManager.open(sessionPath, process.env.PI_CODING_AGENT_SESSION_DIR, cwd);
    return this.store(agent, manager.getSessionId(), manager.getSessionDir(), sessionPath);
  }

  private store(agent: ResolvedAgent, sessionId: string, directory: string, sessionPath: string): ChildLineageLease {
    // Persistent session files intentionally remain inspectable, but shutdown must
    // never publish a capability from an allocator that crossed an await.
    if (this.closed) throw new Error(`Child lineage store shut down during allocation; inspect ${sessionPath}`);
    const handle = `dede_${randomUUID()}`;
    const record: StoredLineage = {
      handle,
      sessionId,
      attempt: 0,
      continuationIndex: 0,
      agent: cloneAgent({ ...agent, continueFrom: undefined, resume: undefined }),
      directory,
      sessionPath,
    };
    this.records.set(handle, record);
    return cloneLease(record);
  }

  peek(handle: string, availability: ChildLineageAvailability): ChildLineageSource | undefined {
    this.pruneContinuations();
    const record = this.records.get(handle);
    return record?.availableAs === availability ? cloneSource(record) : undefined;
  }

  /** Atomically claim all requested lineages, or none when any capability is unavailable. */
  claimMany(requests: readonly { handle: string; availability: ChildLineageAvailability }[]): Map<string, ChildLineageLease> {
    this.pruneContinuations();
    const unique = new Set(requests.map((request) => request.handle));
    if (unique.size !== requests.length) throw new Error("A child lineage handle may be claimed only once per delegation");
    for (const request of requests) {
      const record = this.records.get(request.handle);
      if (!record || record.availableAs !== request.availability) {
        throw new Error(`${request.availability === "resume" ? "Resume" : "Continuation"} handle is unavailable, expired, or already in use: ${request.handle}`);
      }
    }
    const leases = new Map<string, ChildLineageLease>();
    for (const request of requests) {
      const record = this.records.get(request.handle)!;
      record.availableAs = undefined;
      record.availableAt = undefined;
      record.claimedAs = request.availability;
      leases.set(request.handle, cloneLease(record, request.availability));
    }
    return leases;
  }

  /** Release a claimed capability after setup failed without consuming it. */
  release(handle: string): void {
    const record = this.records.get(handle);
    if (!record?.claimedAs) return;
    record.availableAs = record.claimedAs;
    record.claimedAs = undefined;
    record.availableAt = Date.now();
  }

  /** Make a settled successful conversation available for another related bounded task. */
  markSucceeded(handle: string, agent: ResolvedAgent): ChildLineageSource {
    const record = this.records.get(handle);
    if (!record) throw new Error(`Unknown child lineage handle: ${handle}`);
    record.attempt = 0;
    record.continuationIndex = agent.continueFrom?.continuationIndex
      ?? agent.resume?.continuationIndex
      ?? record.continuationIndex;
    record.claimedAs = undefined;
    record.availableAs = "continue";
    record.availableAt = Date.now();
    this.pruneContinuations();
    return cloneSource(record);
  }

  /** Make an interrupted conversation available for one deliberate short resume. */
  markTimedOut(handle: string, agent?: ResolvedAgent): ChildLineageSource {
    const record = this.records.get(handle);
    if (!record) throw new Error(`Unknown child lineage handle: ${handle}`);
    record.attempt++;
    record.continuationIndex = agent?.continueFrom?.continuationIndex
      ?? agent?.resume?.continuationIndex
      ?? record.continuationIndex;
    record.claimedAs = undefined;
    record.availableAs = "resume";
    record.availableAt = Date.now();
    return cloneSource(record);
  }

  async discard(handle: string): Promise<void> {
    // Consume only the continuation capability. The Pi session remains available for inspection.
    this.records.delete(handle);
  }

  get available(): number {
    this.pruneContinuations();
    return [...this.records.values()].filter((record) => record.availableAs !== undefined).length;
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
  }
}

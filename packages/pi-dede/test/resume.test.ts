import { rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChildResumeStore } from "../src/resume.ts";
import type { ResolvedAgent } from "../src/types.ts";

const agent: ResolvedAgent = {
  id: "scout",
  profile: "scout",
  goal: "answer the bounded question",
  contextMode: "isolated",
  resolvedContextMode: "isolated",
  toolPreset: "read-only",
  tools: ["read", "grep"],
  additionalArgs: [],
  model: "test/model",
  thinking: "low",
  env: { CHILD_MODE: "review" },
  timeoutSeconds: 120,
  mutationCapable: false,
};

describe("ChildResumeStore", () => {
  it("exposes timed-out sessions only for resume and claims them atomically", async () => {
    const store = new ChildResumeStore();
    const lease = await store.allocate(agent, process.cwd());
    try {
      expect((await stat(lease.sessionPath)).mode & 0o777).toBe(0o600);
      expect(SessionManager.open(lease.sessionPath, lease.directory).getSessionId()).toBe(lease.sessionId);
      expect(store.peek(lease.handle, "resume")).toBeUndefined();

      const firstTimeout = store.markTimedOut(lease.handle, agent);
      expect(firstTimeout).toMatchObject({
        handle: lease.handle,
        sessionId: lease.sessionId,
        attempt: 1,
        continuationIndex: 0,
        agent: { env: { CHILD_MODE: "review" } },
      });
      firstTimeout.agent.env.CHILD_MODE = "mutated-copy";
      expect(store.peek(lease.handle, "resume")?.agent.env).toEqual({ CHILD_MODE: "review" });
      expect(store.peek(lease.handle, "continue")).toBeUndefined();
      expect(store.available).toBe(1);

      const claimed = store.claimMany([{ handle: lease.handle, availability: "resume" }]).get(lease.handle)!;
      expect(claimed).toMatchObject({ handle: lease.handle, sessionId: lease.sessionId, attempt: 1, claimedAs: "resume" });
      expect(() => store.claimMany([{ handle: lease.handle, availability: "resume" }])).toThrow(/unavailable/);

      store.markTimedOut(lease.handle, agent);
      expect(store.peek(lease.handle, "resume")?.attempt).toBe(2);
      await store.discard(lease.handle);
      expect(store.peek(lease.handle, "resume")).toBeUndefined();
      expect((await stat(lease.sessionPath)).isFile()).toBe(true);
      const sessions = await SessionManager.list(process.cwd());
      expect(sessions.some((session) => session.id === lease.sessionId)).toBe(true);
    } finally {
      await store.cleanup();
      await rm(lease.sessionPath, { force: true });
    }
  });

  it("makes successful lineages repeatedly continuable with one stable handle", async () => {
    const store = new ChildResumeStore();
    const lease = await store.allocate(agent, process.cwd());
    try {
      const finished = store.markSucceeded(lease.handle, agent);
      expect(store.peek(lease.handle, "continue")).toMatchObject({
        handle: lease.handle,
        sessionId: lease.sessionId,
        continuationIndex: 0,
      });
      expect(store.peek(lease.handle, "resume")).toBeUndefined();

      const claimed = store.claimMany([{ handle: finished.handle, availability: "continue" }]).get(finished.handle)!;
      const continuedAgent: ResolvedAgent = {
        ...agent,
        id: "follow-up",
        goal: "answer the related question",
        continueFrom: { handle: claimed.handle, sessionId: claimed.sessionId, continuationIndex: 1 },
      };
      const continued = store.markSucceeded(claimed.handle, continuedAgent);
      expect(continued).toMatchObject({ handle: lease.handle, continuationIndex: 1, attempt: 0 });
      expect(store.peek(lease.handle, "continue")?.continuationIndex).toBe(1);

      const interruptedLease = store.claimMany([{ handle: lease.handle, availability: "continue" }]).get(lease.handle)!;
      const interruptedAgent: ResolvedAgent = {
        ...agent,
        continueFrom: { handle: lease.handle, sessionId: lease.sessionId, continuationIndex: 2 },
      };
      const timedOut = store.markTimedOut(interruptedLease.handle, interruptedAgent);
      expect(timedOut).toMatchObject({ continuationIndex: 2, attempt: 1 });
      expect(store.peek(lease.handle, "continue")).toBeUndefined();
      expect(store.peek(lease.handle, "resume")).toBeDefined();

      store.claimMany([{ handle: lease.handle, availability: "resume" }]);
      const resumedAgent: ResolvedAgent = {
        ...agent,
        resume: { handle: lease.handle, sessionId: lease.sessionId, continuationIndex: 2, attempt: 1 },
      };
      store.markSucceeded(lease.handle, resumedAgent);
      expect(store.peek(lease.handle, "continue")).toMatchObject({ continuationIndex: 2, attempt: 0 });
    } finally {
      await store.cleanup();
      await rm(lease.sessionPath, { force: true });
    }
  });

  it("releases a claimed capability when continuation setup fails", async () => {
    const store = new ChildResumeStore();
    const lease = await store.allocate(agent, process.cwd());
    try {
      store.markSucceeded(lease.handle, agent);
      store.claimMany([{ handle: lease.handle, availability: "continue" }]);
      store.release(lease.handle);
      expect(store.peek(lease.handle, "continue")?.continuationIndex).toBe(0);
    } finally {
      await store.cleanup();
      await rm(lease.sessionPath, { force: true });
    }
  });

  it("retains only the 12 most recent successful continuation capabilities", async () => {
    const store = new ChildResumeStore();
    const leases = [];
    try {
      for (let index = 0; index < 13; index++) {
        const lease = await store.allocate({ ...agent, id: `scout-${index}` }, process.cwd());
        leases.push(lease);
        store.markSucceeded(lease.handle, agent);
      }
      expect(store.available).toBe(12);
      expect(store.peek(leases[0].handle, "continue")).toBeUndefined();
      expect(store.peek(leases[12].handle, "continue")).toBeDefined();
    } finally {
      await store.cleanup();
      await Promise.all(leases.map((lease) => rm(lease.sessionPath, { force: true })));
    }
  });

  it("claims multiple lineages all-or-nothing", async () => {
    const store = new ChildResumeStore();
    const first = await store.allocate(agent, process.cwd());
    const second = await store.allocate({ ...agent, id: "second" }, process.cwd());
    try {
      store.markSucceeded(first.handle, agent);
      store.markSucceeded(second.handle, agent);
      expect(() => store.claimMany([
        { handle: first.handle, availability: "continue" },
        { handle: "missing", availability: "continue" },
      ])).toThrow(/unavailable/);
      expect(store.peek(first.handle, "continue")).toBeDefined();
      expect(() => store.claimMany([
        { handle: first.handle, availability: "continue" },
        { handle: first.handle, availability: "continue" },
      ])).toThrow(/only once/);
    } finally {
      await store.cleanup();
      await rm(first.sessionPath, { force: true });
      await rm(second.sessionPath, { force: true });
    }
  });
});

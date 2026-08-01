import { rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ChildResumeStore } from "../src/resume.ts";
import type { ResolvedAgent } from "../src/types.ts";

const agent: ResolvedAgent = {
  id: "scout",
  profile: "scout",
  goal: "answer the bounded question",
  toolPreset: "read-only",
  tools: ["read", "grep"],
  model: "test/model",
  thinking: "low",
  env: { CHILD_MODE: "review" },
  timeoutSeconds: 120,
  mutationCapable: false,
};

describe("ChildResumeStore", () => {
  it("exposes only timed-out sessions and claims them atomically", async () => {
    const store = new ChildResumeStore();
    const lease = await store.allocate(agent, process.cwd());
    try {
      expect((await stat(lease.sessionPath)).mode & 0o777).toBe(0o600);
      expect(SessionManager.open(lease.sessionPath, lease.directory).getSessionId()).toBe(lease.sessionId);
      expect(store.peek(lease.handle)).toBeUndefined();

      const firstTimeout = store.markTimedOut(lease.handle);
      expect(firstTimeout).toMatchObject({
        handle: lease.handle,
        sessionId: lease.sessionId,
        attempt: 1,
        agent: { env: { CHILD_MODE: "review" } },
      });
      firstTimeout.agent.env.CHILD_MODE = "mutated-copy";
      expect(store.peek(lease.handle)?.agent.env).toEqual({ CHILD_MODE: "review" });
      expect(store.available).toBe(1);

      const claimed = store.claim(lease.handle);
      expect(claimed).toMatchObject({ handle: lease.handle, sessionId: lease.sessionId, attempt: 1 });
      expect(() => store.claim(lease.handle)).toThrow(/unavailable or already in use/);

      store.markTimedOut(lease.handle);
      expect(store.peek(lease.handle)?.attempt).toBe(2);
      await store.discard(lease.handle);
      expect(store.peek(lease.handle)).toBeUndefined();
      expect((await stat(lease.sessionPath)).isFile()).toBe(true);
      const sessions = await SessionManager.list(process.cwd());
      expect(sessions.some((session) => session.id === lease.sessionId)).toBe(true);
    } finally {
      await store.cleanup();
      await rm(lease.sessionPath, { force: true });
    }
  });

  it("releases a claimed session when resume setup fails", async () => {
    const store = new ChildResumeStore();
    const lease = await store.allocate(agent, process.cwd());
    try {
      store.markTimedOut(lease.handle);
      store.claim(lease.handle);
      store.release(lease.handle);
      expect(store.peek(lease.handle)?.attempt).toBe(1);
    } finally {
      await store.cleanup();
      await rm(lease.sessionPath, { force: true });
    }
  });
});

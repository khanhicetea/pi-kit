import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/history.ts";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function line(value: unknown): string { return JSON.stringify(value); }

describe("session enrichment", () => {
	it("segments a session tree by user ancestor and extracts bounded behavior signals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sevo-history-"));
		temporary.push(directory);
		const path = join(directory, "session.jsonl");
		const cwd = join(directory, "project");
		const entries = [
			{ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd },
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Fix login token=secret-value authentication failure with {\"password\":\"hidden-value\"}" } },
			{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/auth.ts" } }], usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.1 } }, stopReason: "toolUse" } },
			{ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "source" }], isError: false } },
			{ type: "message", id: "a2", parentId: "t1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/auth.ts" } }], usage: { input: 120, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } }, stopReason: "toolUse" } },
			{ type: "message", id: "t2", parentId: "a2", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: "Output truncated: source" }], isError: true } },
			{ type: "message", id: "a3", parentId: "t2", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "d1", name: "delegate_to_subagents", arguments: { agents: [{ id: "one" }, { id: "two" }] } }], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: "toolUse" } },
			{ type: "message", id: "t3", parentId: "a3", timestamp: "2026-01-01T00:00:07.000Z", message: { role: "toolResult", toolCallId: "d1", toolName: "delegate_to_subagents", content: [{ type: "text", text: "one status: timed_out; two status: failed" }], isError: false } },
			{ type: "message", id: "u2", parentId: "t3", timestamp: "2026-01-01T00:00:08.000Z", message: { role: "user", content: "Write documentation" } },
			// Alternate branch from the first user request must stay with task u1.
			{ type: "message", id: "a4", parentId: "u1", timestamp: "2026-01-01T00:00:09.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "r-alt", name: "read", arguments: { path: "src/auth.ts" } }], usage: { cost: { total: 0 } }, stopReason: "toolUse" } },
		];
		const content = entries.map(line).join("\n") + "\nnot-json\n";
		await writeFile(path, content);
		const digest = await parseSessionFile(path, { size: Buffer.byteLength(content), mtimeMs: 123 });

		expect(digest.sessionId).toBe("session-1");
		expect(digest.malformedLines).toBe(1);
		expect(digest.tasks).toHaveLength(2);
		const first = digest.tasks.find((task) => task.id === "u1")!;
		expect(first.prompt).toContain("token=<redacted>");
		expect(first.prompt).not.toContain("secret-value");
		expect(first.prompt).not.toContain("hidden-value");
		expect(first.stats).toMatchObject({
			assistantRequests: 4,
			toolBatches: 4,
			toolCalls: 4,
			singletonBatches: 4,
			consecutiveSingletonReadOnly: 1,
			repeatedExactCalls: 1,
			toolErrors: 1,
			truncatedResults: 1,
			delegatedRuns: 1,
			delegatedAgents: 2,
			delegateTimeouts: 1,
			delegateFailures: 1,
			inputTokens: 230,
		});
		expect(first.stats.parentCost).toBeCloseTo(0.31);
		expect(first.toolCalls).toEqual([
			{ name: "read", params: '{"path":"src/auth.ts"}', status: "success" },
			{ name: "read", params: '{"path":"src/auth.ts"}', status: "failed" },
			{ name: "delegate_to_subagents", params: '{"agents":[{"id":"one"},{"id":"two"}]}', status: "success" },
			{ name: "read", params: '{"path":"src/auth.ts"}' },
		]);
		expect(first.toolBatches).toEqual([[0], [1], [2], [3]]);
		expect(first.toolNgrams).toEqual([["read", "read"], ["read", "delegate_to_subagents"]]);
	});

	it("stores short parameters for any tool and records batches as zero-based call references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sevo-batches-"));
		temporary.push(directory);
		const path = join(directory, "batch.jsonl");
		const cwd = join(directory, "project");
		const longValue = "x".repeat(300);
		const entries = [
			{ type: "session", id: "batch", timestamp: "2026-01-01T00:00:00.000Z", cwd },
			{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "Inspect tools" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [
				{ type: "toolCall", id: "c1", name: "custom_tool", arguments: { query: "short" } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: longValue } },
			] } },
			{ type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: "ok", isError: false } },
			{ type: "message", id: "r2", parentId: "r1", message: { role: "toolResult", toolCallId: "c2", content: "bad", isError: true } },
		];
		const content = entries.map(line).join("\n");
		await writeFile(path, content);
		const task = (await parseSessionFile(path, { size: Buffer.byteLength(content), mtimeMs: 1 })).tasks[0];
		expect(task.toolCalls).toEqual([
			{ name: "custom_tool", params: '{"query":"short"}', status: "success" },
			{ name: "bash", status: "failed" },
		]);
		expect(task.toolBatches).toEqual([[0, 1]]);
	});

	it("rejects files without a valid project session header", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sevo-header-"));
		temporary.push(directory);
		const path = join(directory, "invalid.jsonl");
		await writeFile(path, `${line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "secret" } })}\n`);
		await expect(parseSessionFile(path, { size: 1, mtimeMs: 1 })).rejects.toThrow("no valid session header");
	});
});

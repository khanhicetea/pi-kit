import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectIndex, normalizeProjectIndex, refreshProjectIndex, saveReviewEvidence } from "../src/store.ts";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("project index store", () => {
	it("saves uniquely named review evidence Markdown", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-sevo-evidence-"));
		temporary.push(root);
		const reviews = join(root, "reviews");
		const timestamp = new Date("2026-01-01T00:00:00.000Z");
		const first = await saveReviewEvidence(reviews, "# Evidence one\n", timestamp);
		const second = await saveReviewEvidence(reviews, "# Evidence two\n", timestamp);
		expect(first).not.toBe(second);
		expect(first).toMatch(/\.evidence\.md$/);
		expect(await readFile(first, "utf8")).toBe("# Evidence one\n");
		expect(await readFile(second, "utf8")).toBe("# Evidence two\n");
	});

	it("reuses unchanged session digests and reparses appended sessions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-sevo-store-"));
		temporary.push(root);
		const cwd = join(root, "project");
		const sessions = join(root, "sessions");
		const indexPath = join(root, "store", "index.json");
		await mkdir(cwd);
		await mkdir(sessions);
		const path = join(sessions, "one.jsonl");
		const header = JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-01-01T00:00:00.000Z", cwd });
		const user = JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Fix login" } });
		await writeFile(path, `${header}\n${user}\n`);

		const first = await refreshProjectIndex({ cwd, sessionDir: sessions, indexPath });
		expect(first.stats).toMatchObject({ discovered: 1, parsed: 1, reused: 0 });
		expect(first.index.sessions["one.jsonl"].tasks).toHaveLength(1);

		const second = await refreshProjectIndex({ cwd, sessionDir: sessions, indexPath });
		expect(second.stats).toMatchObject({ parsed: 0, reused: 1 });

		const assistant = JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } }], usage: { cost: { total: 0 } }, stopReason: "toolUse" } });
		const result = JSON.stringify({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", content: "source", isError: false } });
		await writeFile(path, `${header}\n${user}\n${assistant}\n${result}\n`);
		const third = await refreshProjectIndex({ cwd, sessionDir: sessions, indexPath });
		expect(third.stats).toMatchObject({ parsed: 1, reused: 0 });
		expect(third.index.sessions["one.jsonl"].tasks[0].stats.assistantRequests).toBe(1);
		const loaded = (await loadProjectIndex(indexPath, cwd)).sessions["one.jsonl"];
		expect(loaded.file).toBe("one.jsonl");
		expect(loaded.tasks[0].toolCalls).toEqual([{ name: "read", params: '{"path":"src/auth.ts"}', status: "success" }]);
		expect(loaded.tasks[0].toolBatches).toEqual([[0]]);
	});

	it("rejects oversized source sessions before reading them", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-sevo-oversized-"));
		temporary.push(root);
		const cwd = join(root, "project");
		const sessions = join(root, "sessions");
		const indexPath = join(root, "store", "index.json");
		await mkdir(cwd);
		await mkdir(sessions);
		const path = join(sessions, "huge.jsonl");
		await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "huge", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
		await truncate(path, 512 * 1024 * 1024 + 1);
		const result = await refreshProjectIndex({ cwd, sessionDir: sessions, indexPath });
		expect(result.index.sessions).toEqual({});
		expect(result.stats.failed[0]).toMatchObject({ file: "huge.jsonl" });
		expect(result.stats.failed[0].error).toContain("Session exceeds");
	});

	it("rebuilds from sessions when the cache is corrupt", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-sevo-corrupt-"));
		temporary.push(root);
		const cwd = join(root, "project");
		const sessions = join(root, "sessions");
		const indexPath = join(root, "store", "index.json");
		await mkdir(cwd);
		await mkdir(sessions);
		await mkdir(join(root, "store"));
		await writeFile(indexPath, "not-json");
		await writeFile(join(sessions, "one.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
		const result = await refreshProjectIndex({ cwd, sessionDir: sessions, indexPath });
		expect(result.stats.parsed).toBe(1);
		expect(result.stats.cacheReset).toBe(true);
		expect(result.stats.failed).toEqual([]);
		expect((await loadProjectIndex(indexPath, cwd)).sessions["one.jsonl"].sessionId).toBe("one");
	});

	it("rejects an index for another project and normalizes unsafe fields", () => {
		const normalized = normalizeProjectIndex({ schemaVersion: 1, projectPath: "/other", sessions: { "../escape.jsonl": {} } }, "/repo");
		expect(normalized.projectPath).toBe("/repo");
		expect(normalized.sessions).toEqual({});
	});
});

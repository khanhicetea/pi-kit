import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { emptyTaskStats, parseSessionFile } from "./history.ts";
import { ENRICHMENT_VERSION, INDEX_SCHEMA_VERSION, type ProjectIndex, type RefreshStats, type SessionDigest, type TaskDigest, type TaskStats, type ToolCallDigest } from "./types.ts";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES = 512 * 1024 * 1024;
const MAX_STORED_TASKS_PER_SESSION = 10_000;
const MAX_PROJECT_TASKS = 50_000;
const MAX_SESSION_FILES = 5_000;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function cleanString(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function normalizeStats(value: unknown): TaskStats {
	const raw = record(value);
	const stats = emptyTaskStats();
	for (const key of Object.keys(stats) as Array<keyof TaskStats>) stats[key] = finite(raw[key]);
	return stats;
}

function normalizeToolCall(value: unknown): ToolCallDigest | undefined {
	const raw = record(value);
	const name = cleanString(raw.name, 80);
	if (!name) return undefined;
	const params = cleanString(raw.params, 255);
	let validParams = "";
	if (params && params.length < 256) {
		try { JSON.parse(params); validParams = params; } catch { /* discard malformed cached parameters */ }
	}
	const status = raw.status === "success" || raw.status === "failed" ? raw.status : undefined;
	return { name, ...(validParams ? { params: validParams } : {}), ...(status ? { status } : {}) };
}

function normalizeTask(value: unknown): TaskDigest | undefined {
	const raw = record(value);
	const id = cleanString(raw.id, 128);
	if (!id) return undefined;
	const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls.map(normalizeToolCall).filter((call): call is ToolCallDigest => Boolean(call)).slice(0, 80) : [];
	return {
		id,
		timestamp: cleanString(raw.timestamp, 64),
		prompt: cleanString(raw.prompt, 400),
		promptHash: cleanString(raw.promptHash, 128),
		intent: cleanString(raw.intent, 32) || "other",
		terms: Array.isArray(raw.terms) ? raw.terms.map((term) => cleanString(term, 40)).filter(Boolean).slice(0, 12) : [],
		toolCalls,
		toolBatches: Array.isArray(raw.toolBatches) ? raw.toolBatches.map((batch) => Array.isArray(batch) ? batch.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < toolCalls.length) : []).filter((batch) => batch.length > 0).slice(0, 80) : [],
		toolNgrams: Array.isArray(raw.toolNgrams) ? raw.toolNgrams.map((window) => Array.isArray(window) ? window.map((tool) => cleanString(tool, 80)).filter(Boolean).slice(0, 3) : []).filter((window) => window.length >= 2).slice(0, 160) : [],
		stats: normalizeStats(raw.stats),
	};
}

function normalizeSession(value: unknown, key: string): SessionDigest | undefined {
	const raw = record(value);
	const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask).filter((task): task is TaskDigest => Boolean(task)).slice(0, MAX_STORED_TASKS_PER_SESSION) : [];
	const file = basename(cleanString(raw.file, 512) || key);
	if (!file.endsWith(".jsonl") || raw.enrichmentVersion !== ENRICHMENT_VERSION) return undefined;
	return {
		enrichmentVersion: ENRICHMENT_VERSION,
		file,
		size: finite(raw.size),
		mtimeMs: finite(raw.mtimeMs),
		sessionId: cleanString(raw.sessionId, 128),
		cwd: cleanString(raw.cwd, 4096),
		createdAt: cleanString(raw.createdAt, 64),
		...(typeof raw.parentSession === "string" ? { parentSession: cleanString(raw.parentSession, 4096) } : {}),
		malformedLines: finite(raw.malformedLines),
		oversizedLines: finite(raw.oversizedLines),
		entryLimitReached: raw.entryLimitReached === true,
		taskLimitReached: raw.taskLimitReached === true,
		tasks,
	};
}

function normalizeRefresh(value: unknown): RefreshStats {
	const raw = record(value);
	return {
		discovered: finite(raw.discovered), parsed: finite(raw.parsed), reused: finite(raw.reused), skipped: finite(raw.skipped),
		limitedSessions: finite(raw.limitedSessions), retainedStale: finite(raw.retainedStale), cacheReset: raw.cacheReset === true,
		failed: Array.isArray(raw.failed) ? raw.failed.map(record).map((failure) => ({ file: cleanString(failure.file, 512), error: cleanString(failure.error, 2_000) })).filter((failure) => failure.file).slice(0, 100) : [],
	};
}

export function emptyProjectIndex(cwd: string): ProjectIndex {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION, projectPath: resolve(cwd), updatedAt: new Date(0).toISOString(),
		lastRefresh: normalizeRefresh(undefined), sessions: {},
	};
}

export function normalizeProjectIndex(value: unknown, cwd: string): ProjectIndex {
	const raw = record(value);
	if (raw.schemaVersion !== INDEX_SCHEMA_VERSION || resolve(cleanString(raw.projectPath, 4096) || cwd) !== resolve(cwd)) return emptyProjectIndex(cwd);
	const sessions: Record<string, SessionDigest> = {};
	for (const [key, value] of Object.entries(record(raw.sessions))) {
		const safeKey = basename(key);
		const session = normalizeSession(value, safeKey);
		if (session && session.file === safeKey) sessions[safeKey] = session;
	}
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		projectPath: resolve(cwd),
		updatedAt: cleanString(raw.updatedAt, 64) || new Date(0).toISOString(),
		lastRefresh: normalizeRefresh(raw.lastRefresh),
		sessions,
	};
}

export function getProjectStorePaths(cwd: string, agentDir = getAgentDir()): { directory: string; index: string; reviews: string } {
	const projectKey = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 20);
	const directory = join(agentDir, "pi-sevo", projectKey);
	return { directory, index: join(directory, "index.json"), reviews: join(directory, "reviews") };
}

export async function loadProjectIndex(path: string, cwd: string): Promise<ProjectIndex> {
	try {
		const info = await stat(path);
		if (info.size > MAX_INDEX_BYTES) throw new Error(`index exceeds ${MAX_INDEX_BYTES} bytes`);
		return normalizeProjectIndex(JSON.parse(await readFile(path, "utf8")), cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProjectIndex(cwd);
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		try { await rm(temporary, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

export async function saveProjectIndex(path: string, index: ProjectIndex): Promise<void> {
	const content = `${JSON.stringify(index, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES) throw new Error(`index exceeds ${MAX_INDEX_BYTES} bytes before save`);
	await atomicWrite(path, content);
}

export async function saveReviewEvidence(directory: string, markdown: string, timestamp = new Date()): Promise<string> {
	const file = `${timestamp.toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.evidence.md`;
	const path = join(directory, file);
	await atomicWrite(path, markdown);
	return path;
}

export async function saveReview(directory: string, markdown: string, timestamp = new Date()): Promise<string> {
	const file = `${timestamp.toISOString().replace(/[:.]/g, "-")}.md`;
	const path = join(directory, file);
	await atomicWrite(path, markdown);
	return path;
}

export interface RefreshOptions {
	cwd: string;
	sessionDir: string;
	indexPath: string;
}

/** Incrementally refresh a project index. Changed sessions replace their prior digest atomically. */
export async function refreshProjectIndex(options: RefreshOptions): Promise<{ index: ProjectIndex; stats: RefreshStats }> {
	const cwd = resolve(options.cwd);
	let previous: ProjectIndex;
	let cacheReset = false;
	try {
		previous = await loadProjectIndex(options.indexPath, cwd);
	} catch {
		previous = emptyProjectIndex(cwd);
		cacheReset = true;
	}
	const allNames = (await readdir(options.sessionDir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name)
		.sort();
	// Session filenames start with an ISO-like timestamp. Prefer recent evidence when a hard limit applies.
	const names = allNames.slice(-MAX_SESSION_FILES).reverse();
	const refresh: RefreshStats = {
		discovered: allNames.length, parsed: 0, reused: 0, skipped: 0,
		limitedSessions: allNames.length - names.length, retainedStale: 0, cacheReset,
		failed: [],
	};
	const sessions: Record<string, SessionDigest> = {};
	let retainedTasks = 0;
	const retainWithinBudget = (source: SessionDigest): SessionDigest => {
		const remaining = Math.max(0, MAX_PROJECT_TASKS - retainedTasks);
		const digest = source.tasks.length > remaining
			? {
				...source,
				size: 0,
				mtimeMs: 0,
				tasks: remaining ? source.tasks.slice(-remaining) : [],
				taskLimitReached: true,
			}
			: source;
		retainedTasks += digest.tasks.length;
		return digest;
	};

	for (const name of names) {
		const path = join(options.sessionDir, name);
		try {
			const before = await stat(path);
			if (before.size > MAX_SESSION_FILE_BYTES) throw new Error(`Session exceeds ${MAX_SESSION_FILE_BYTES} bytes`);
			const cached = previous.sessions[name];
			if (cached && cached.enrichmentVersion === ENRICHMENT_VERSION && cached.size === before.size && cached.mtimeMs === before.mtimeMs) {
				sessions[name] = retainWithinBudget(cached);
				refresh.reused += 1;
				continue;
			}
			const digest = await parseSessionFile(path, { size: before.size, mtimeMs: before.mtimeMs });
			if (resolve(digest.cwd) !== cwd) {
				refresh.skipped += 1;
				continue;
			}
			const after = await stat(path);
			if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
				// Keep the snapshot but force a reparse and qualify this review cycle.
				digest.size = 0;
				digest.mtimeMs = 0;
				refresh.failed.push({ file: name, error: "Session changed while being read; it will be reparsed next time" });
			}
			sessions[name] = retainWithinBudget(digest);
			refresh.parsed += 1;
		} catch (error) {
			refresh.failed.push({ file: name, error: error instanceof Error ? error.message : String(error) });
			if (previous.sessions[name]) {
				sessions[name] = retainWithinBudget(previous.sessions[name]);
				refresh.retainedStale += 1;
			}
		}
	}

	const index: ProjectIndex = {
		schemaVersion: INDEX_SCHEMA_VERSION,
		projectPath: cwd,
		updatedAt: new Date().toISOString(),
		lastRefresh: refresh,
		sessions,
	};
	await saveProjectIndex(options.indexPath, index);
	return { index, stats: refresh };
}

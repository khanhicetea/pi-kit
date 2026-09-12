import { describe, expect, it } from "vitest";
import { emptyTaskStats } from "../src/history.ts";
import { buildProjectReport, formatProjectReport } from "../src/report.ts";
import type { ProjectIndex, SessionDigest, TaskDigest } from "../src/types.ts";

function task(id: string, prompt: string, terms: string[], sequence: string[], changes: Partial<ReturnType<typeof emptyTaskStats>> = {}): TaskDigest {
	return {
		id,
		timestamp: `2026-01-0${id === "one" ? 1 : 2}T00:00:00.000Z`,
		prompt,
		promptHash: id,
		intent: "fix",
		terms,
		toolCalls: sequence.map((name) => ({ name, params: "{}", status: "success" })),
		toolBatches: sequence.map((_, index) => [index]),
		toolNgrams: [
			...sequence.slice(0, -1).map((tool, index) => [tool, sequence[index + 1]]),
			...(sequence.length >= 3 ? [sequence.slice(0, 3)] : []),
		],
		stats: { ...emptyTaskStats(), toolCalls: sequence.length, toolBatches: sequence.length, singletonBatches: sequence.length, ...changes },
	};
}

function session(file: string, tasks: TaskDigest[]): SessionDigest {
	return {
		enrichmentVersion: 2,
		file, size: 1, mtimeMs: 1, sessionId: file, cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z",
		malformedLines: 0, oversizedLines: 0, entryLimitReached: false, taskLimitReached: false, tasks,
	};
}

describe("project report", () => {
	it("finds recurring task families, operational patterns, and observable issues", () => {
		const index: ProjectIndex = {
			schemaVersion: 2,
			projectPath: "/repo",
			updatedAt: "2026-01-03T00:00:00.000Z",
			lastRefresh: { discovered: 2, parsed: 2, reused: 0, skipped: 0, limitedSessions: 0, retainedStale: 0, cacheReset: false, failed: [] },
			sessions: {
				"one.jsonl": session("one.jsonl", [task("one", "Fix authentication login failure", ["authentication", "login", "failure"], ["ffgrep", "read_symbol", "edit"], { toolErrors: 2, consecutiveSingletonReadOnly: 1 })]),
				"two.jsonl": session("two.jsonl", [task("two", "Fix authentication login timeout", ["authentication", "login", "timeout"], ["ffgrep", "read_symbol", "edit"], { delegateTimeouts: 1, repeatedExactCalls: 1 })]),
			},
		};
		const report = buildProjectReport(index);
		expect(report.totals).toMatchObject({ sessions: 2, tasks: 2, toolCalls: 6, toolErrors: 2 });
		expect(report.recurringTasks[0]).toMatchObject({ intent: "fix", occurrences: 2, sessionCount: 2 });
		expect(report.toolPatterns.some((pattern) => pattern.sequence.join("→") === "ffgrep→read_symbol" && pattern.taskCount === 2)).toBe(true);
		expect(report.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining(["tool-errors", "subagent-timeouts", "repeated-exact-calls"]));
		expect(formatProjectReport(report)).toContain("2 sessions · 2 tasks");
	});

	it("deduplicates copied task prefixes from forked sessions", () => {
		const original = task("one", "Fix authentication login failure", ["authentication", "login", "failure"], ["read"]);
		const continued = task("one", "Fix authentication login failure", ["authentication", "login", "failure"], ["read", "edit"]);
		const index: ProjectIndex = {
			schemaVersion: 2,
			projectPath: "/repo",
			updatedAt: "2026-01-03T00:00:00.000Z",
			lastRefresh: { discovered: 2, parsed: 2, reused: 0, skipped: 0, limitedSessions: 0, retainedStale: 0, cacheReset: false, failed: [] },
			sessions: {
				"original.jsonl": session("original.jsonl", [original]),
				"fork.jsonl": { ...session("fork.jsonl", [continued]), parentSession: "/sessions/original.jsonl" },
			},
		};
		const report = buildProjectReport(index);
		expect(report.totals.tasks).toBe(1);
		expect(report.totals.toolCalls).toBe(2);
		expect(report.coverage.deduplicatedTasks).toBe(1);
	});
});

import type {
	EvidenceRef, IssueAggregate, ProjectIndex, ProjectReport, ProjectTotals, RecurringTask, SessionDigest, TaskDigest, ToolPattern,
} from "./types.ts";
import { emptyTaskStats } from "./history.ts";

const MAX_GROUPS = 12;
const MAX_EXAMPLES = 3;
const LARGE_RESULT_BYTES = 128 * 1024;

interface LocatedTask {
	session: SessionDigest;
	task: TaskDigest;
}

interface MutableCluster {
	intent: string;
	termCounts: Map<string, number>;
	tools: Map<string, number>;
	tasks: LocatedTask[];
}

function evidence(item: LocatedTask): EvidenceRef {
	return {
		session: item.session.file,
		taskId: item.task.id,
		timestamp: item.task.timestamp,
		prompt: item.task.prompt,
	};
}

function addStats(target: ProjectTotals, source: TaskDigest["stats"]): void {
	for (const key of Object.keys(emptyTaskStats()) as Array<keyof TaskDigest["stats"]>) {
		target[key] += source[key];
	}
}

function representativeTerms(cluster: MutableCluster): string[] {
	return [...cluster.termCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([term]) => term);
}

function overlapScore(left: readonly string[], right: readonly string[]): { overlap: number; score: number } {
	const rightSet = new Set(right);
	const overlap = left.filter((term) => rightSet.has(term)).length;
	const union = new Set([...left, ...right]).size;
	return { overlap, score: union ? overlap / union : 0 };
}

function recurringTasks(tasks: LocatedTask[]): RecurringTask[] {
	const clusters: MutableCluster[] = [];
	const clustersByTerm = new Map<string, Set<number>>();
	for (const item of tasks) {
		if (item.task.terms.length < 2) continue;
		const candidateIds = new Set<number>();
		candidateSearch: for (const term of item.task.terms) {
			for (const id of clustersByTerm.get(term) ?? []) {
				candidateIds.add(id);
				if (candidateIds.size >= 500) break candidateSearch;
			}
		}
		let best: { id: number; cluster: MutableCluster; score: number } | undefined;
		for (const id of candidateIds) {
			const cluster = clusters[id];
			if (cluster.intent !== item.task.intent) continue;
			const match = overlapScore(item.task.terms, representativeTerms(cluster));
			if (match.overlap < 2 || match.score < 0.34) continue;
			if (!best || match.score > best.score) best = { id, cluster, score: match.score };
		}
		const cluster: MutableCluster = best?.cluster ?? { intent: item.task.intent, termCounts: new Map(), tools: new Map(), tasks: [] };
		const clusterId = best?.id ?? clusters.length;
		if (!best) clusters.push(cluster);
		cluster.tasks.push(item);
		for (const term of item.task.terms) {
			cluster.termCounts.set(term, (cluster.termCounts.get(term) ?? 0) + 1);
			const ids = clustersByTerm.get(term) ?? new Set<number>();
			ids.add(clusterId);
			clustersByTerm.set(term, ids);
		}
		for (const tool of new Set(item.task.toolCalls.map((call) => call.name))) cluster.tools.set(tool, (cluster.tools.get(tool) ?? 0) + 1);
	}
	return clusters
		.filter((cluster) => cluster.tasks.length >= 2)
		.map((cluster) => {
			const terms = representativeTerms(cluster).slice(0, 5);
			return {
				label: `${cluster.intent}: ${terms.join(" ")}`,
				intent: cluster.intent,
				terms,
				occurrences: cluster.tasks.length,
				sessionCount: new Set(cluster.tasks.map(({ session }) => session.file)).size,
				commonTools: [...cluster.tools].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([tool]) => tool),
				examples: cluster.tasks.slice(-MAX_EXAMPLES).map(evidence),
			};
		})
		.sort((a, b) => b.occurrences - a.occurrences || b.sessionCount - a.sessionCount || a.label.localeCompare(b.label))
		.slice(0, MAX_GROUPS);
}

function toolPatterns(tasks: LocatedTask[]): ToolPattern[] {
	const patterns = new Map<string, { sequence: string[]; count: number; tasks: Map<string, LocatedTask> }>();
	for (const item of tasks) {
		for (const sequence of item.task.toolNgrams) {
			if (sequence.length < 2 || sequence.length > 3) continue;
			const key = sequence.join("\u0000");
			const group = patterns.get(key) ?? { sequence, count: 0, tasks: new Map() };
			group.count += 1;
			group.tasks.set(`${item.session.file}\u0000${item.task.id}`, item);
			patterns.set(key, group);
		}
	}
	return [...patterns.values()]
		.filter((group) => group.tasks.size >= 2)
		.map((group) => {
			const examples = [...group.tasks.values()];
			return {
				sequence: group.sequence,
				occurrences: group.count,
				taskCount: group.tasks.size,
				sessionCount: new Set(examples.map(({ session }) => session.file)).size,
				examples: examples.slice(-MAX_EXAMPLES).map(evidence),
			};
		})
		.sort((a, b) => b.taskCount - a.taskCount || b.occurrences - a.occurrences || a.sequence.join("→").localeCompare(b.sequence.join("→")))
		.slice(0, MAX_GROUPS);
}

const ISSUE_DEFINITIONS: Array<{ kind: string; description: string; count: (task: TaskDigest) => number }> = [
	{ kind: "tool-errors", description: "Tool results marked as errors", count: (task) => task.stats.toolErrors },
	{ kind: "assistant-errors", description: "Assistant requests stopped with error or abort", count: (task) => task.stats.assistantErrors },
	{ kind: "subagent-timeouts", description: "Delegated agents reported as timed out", count: (task) => task.stats.delegateTimeouts },
	{ kind: "subagent-failures", description: "Delegated agents reported as failed", count: (task) => task.stats.delegateFailures },
	{ kind: "truncated-results", description: "Tool results reported as truncated", count: (task) => task.stats.truncatedResults },
	{ kind: "repeated-exact-calls", description: "Identical tool name and arguments repeated within one task", count: (task) => task.stats.repeatedExactCalls },
	{ kind: "singleton-read-chains", description: "Adjacent singleton read-only rounds on one branch", count: (task) => task.stats.consecutiveSingletonReadOnly },
	{ kind: "split-mutation-rounds", description: "Adjacent singleton edit/write rounds on one branch", count: (task) => task.stats.sequentialMutationRounds },
	{ kind: "same-path-sibling-mutations", description: "Sibling edit/write calls targeted the same normalized path", count: (task) => task.stats.samePathSiblingMutations },
	{ kind: "large-tool-results", description: `Tasks with more than ${LARGE_RESULT_BYTES / 1024} KiB of tool-result text`, count: (task) => task.stats.toolResultBytes > LARGE_RESULT_BYTES ? 1 : 0 },
];

function issues(tasks: LocatedTask[]): IssueAggregate[] {
	return ISSUE_DEFINITIONS.map((definition) => {
		const affected = tasks.map((item) => ({ item, count: definition.count(item.task) })).filter(({ count }) => count > 0);
		return {
			kind: definition.kind,
			description: definition.description,
			occurrences: affected.reduce((sum, item) => sum + item.count, 0),
			affectedTasks: affected.length,
			affectedSessions: new Set(affected.map(({ item }) => item.session.file)).size,
			examples: affected.sort((a, b) => b.count - a.count || a.item.task.timestamp.localeCompare(b.item.task.timestamp)).slice(0, MAX_EXAMPLES).map(({ item }) => evidence(item)),
		};
	}).filter((issue) => issue.occurrences > 0)
		.sort((a, b) => b.affectedTasks - a.affectedTasks || b.occurrences - a.occurrences || a.kind.localeCompare(b.kind))
		.slice(0, MAX_GROUPS);
}

export function buildProjectReport(index: ProjectIndex): ProjectReport {
	const sessions = Object.values(index.sessions).sort((a, b) => a.file.localeCompare(b.file));
	const sourceTasks = sessions.flatMap((session) => session.tasks.map((task) => ({ session, task })));
	const uniqueTasks = new Map<string, LocatedTask>();
	const activity = (item: LocatedTask) => item.task.stats.assistantRequests + item.task.stats.toolCalls + item.task.stats.toolResultBytes / 1024;
	for (const item of sourceTasks) {
		// Forked and cloned sessions retain entry IDs. Keep only the richest copy of a shared task prefix.
		const key = `${item.task.id}\u0000${item.task.promptHash}`;
		const earlier = uniqueTasks.get(key);
		if (!earlier || activity(item) > activity(earlier)) uniqueTasks.set(key, item);
	}
	const tasks = [...uniqueTasks.values()]
		.sort((a, b) => a.task.timestamp.localeCompare(b.task.timestamp) || a.task.id.localeCompare(b.task.id));
	const truncatedSessions = sessions.filter((session) => session.entryLimitReached || session.taskLimitReached || session.malformedLines > 0 || session.oversizedLines > 0).length;
	const coverage = {
		discoveredSessions: index.lastRefresh.discovered,
		indexedSessions: sessions.length,
		failedSessions: index.lastRefresh.failed.length,
		staleSessions: index.lastRefresh.retainedStale,
		skippedSessions: index.lastRefresh.skipped,
		limitedSessions: index.lastRefresh.limitedSessions,
		truncatedSessions,
		deduplicatedTasks: sourceTasks.length - tasks.length,
		cacheReset: index.lastRefresh.cacheReset,
		incomplete: index.lastRefresh.failed.length > 0 || index.lastRefresh.retainedStale > 0 || index.lastRefresh.limitedSessions > 0 || truncatedSessions > 0,
	};
	const totals: ProjectTotals = {
		...emptyTaskStats(), sessions: sessions.length, tasks: tasks.length,
		malformedLines: sessions.reduce((sum, session) => sum + session.malformedLines, 0),
		oversizedLines: sessions.reduce((sum, session) => sum + session.oversizedLines, 0),
	};
	for (const { task } of tasks) addStats(totals, task.stats);
	return {
		schemaVersion: 1,
		projectPath: index.projectPath,
		updatedAt: index.updatedAt,
		coverage,
		totals,
		recurringTasks: recurringTasks(tasks),
		toolPatterns: toolPatterns(tasks),
		issues: issues(tasks),
	};
}

export function formatProjectReport(report: ProjectReport): string {
	const totals = report.totals;
	const callsPerRound = totals.toolBatches ? totals.toolCalls / totals.toolBatches : 0;
	const singletonRate = totals.toolBatches ? totals.singletonBatches / totals.toolBatches : 0;
	return [
		`Pi Sevo · ${totals.sessions} sessions · ${totals.tasks} tasks`,
		`Tool activity: ${totals.toolCalls} calls / ${totals.toolBatches} rounds (${callsPerRound.toFixed(2)} calls/round, ${(singletonRate * 100).toFixed(0)}% singleton)`,
		`Delegation: ${totals.delegatedAgents} agents in ${totals.delegatedRuns} runs · ${totals.delegateTimeouts} timeouts · ${totals.delegateFailures} failures`,
		`Evidence groups: ${report.recurringTasks.length} recurring tasks · ${report.toolPatterns.length} tool patterns · ${report.issues.length} issue types`,
		`Coverage: ${report.coverage.indexedSessions}/${report.coverage.discoveredSessions} sessions · ${report.coverage.deduplicatedTasks} copied tasks deduplicated · ${report.coverage.incomplete ? "INCOMPLETE" : "complete"}`,
		`Diagnostics: ${totals.malformedLines} malformed lines · ${totals.oversizedLines} oversized lines`, 
	].join("\n");
}

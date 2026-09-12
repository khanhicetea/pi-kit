export const INDEX_SCHEMA_VERSION = 2;
export const ENRICHMENT_VERSION = 2;

export interface TaskStats {
	assistantRequests: number;
	toolBatches: number;
	toolCalls: number;
	singletonBatches: number;
	consecutiveSingletonReadOnly: number;
	sequentialMutationRounds: number;
	samePathSiblingMutations: number;
	repeatedExactCalls: number;
	toolErrors: number;
	truncatedResults: number;
	assistantErrors: number;
	toolResultBytes: number;
	delegatedRuns: number;
	delegatedAgents: number;
	delegateTimeouts: number;
	delegateFailures: number;
	parentCost: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	maxContextTokens: number;
}

export interface ToolCallDigest {
	name: string;
	/** Stable, redacted JSON when the encoded arguments are shorter than 256 characters. */
	params?: string;
	/** Omitted when the session has no matching tool result. */
	status?: "success" | "failed";
}

export interface TaskDigest {
	id: string;
	timestamp: string;
	prompt: string;
	promptHash: string;
	intent: string;
	terms: string[];
	toolCalls: ToolCallDigest[];
	/** Each batch contains zero-based indexes into toolCalls. */
	toolBatches: number[][];
	/** Path-aware observed tool bigrams/trigrams. */
	toolNgrams: string[][];
	stats: TaskStats;
}

export interface SessionDigest {
	enrichmentVersion: 2;
	file: string;
	size: number;
	mtimeMs: number;
	sessionId: string;
	cwd: string;
	createdAt: string;
	parentSession?: string;
	malformedLines: number;
	oversizedLines: number;
	entryLimitReached: boolean;
	taskLimitReached: boolean;
	tasks: TaskDigest[];
}

export interface ProjectIndex {
	schemaVersion: 2;
	projectPath: string;
	updatedAt: string;
	lastRefresh: RefreshStats;
	sessions: Record<string, SessionDigest>;
}

export interface EvidenceRef {
	session: string;
	taskId: string;
	timestamp: string;
	prompt: string;
}

export interface RecurringTask {
	label: string;
	intent: string;
	terms: string[];
	occurrences: number;
	sessionCount: number;
	commonTools: string[];
	examples: EvidenceRef[];
}

export interface ToolPattern {
	sequence: string[];
	occurrences: number;
	taskCount: number;
	sessionCount: number;
	examples: EvidenceRef[];
}

export interface IssueAggregate {
	kind: string;
	description: string;
	occurrences: number;
	affectedTasks: number;
	affectedSessions: number;
	examples: EvidenceRef[];
}

export interface ProjectTotals extends TaskStats {
	sessions: number;
	tasks: number;
	malformedLines: number;
	oversizedLines: number;
}

export interface ProjectCoverage {
	discoveredSessions: number;
	indexedSessions: number;
	failedSessions: number;
	staleSessions: number;
	skippedSessions: number;
	limitedSessions: number;
	truncatedSessions: number;
	deduplicatedTasks: number;
	cacheReset: boolean;
	incomplete: boolean;
}

export interface ProjectReport {
	schemaVersion: 1;
	projectPath: string;
	updatedAt: string;
	coverage: ProjectCoverage;
	totals: ProjectTotals;
	recurringTasks: RecurringTask[];
	toolPatterns: ToolPattern[];
	issues: IssueAggregate[];
}

export interface RefreshStats {
	discovered: number;
	parsed: number;
	reused: number;
	skipped: number;
	limitedSessions: number;
	retainedStale: number;
	cacheReset: boolean;
	failed: Array<{ file: string; error: string }>;
}

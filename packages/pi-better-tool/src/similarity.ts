/**
 * Bounded fuzzy line similarity used to locate the region of a file that a
 * failed oldText almost matched.
 */

import { normalizeForFuzzyMatch, normalizeToLF } from "./text.ts";

export interface AlignOp {
	type: "equal" | "similar" | "changed" | "file-only" | "old-only";
	/** 1-based line number in the file (for equal/similar/changed/file-only). */
	fileLine?: number;
	/** Original LF-normalized file text, never fuzzy-normalized. */
	fileText?: string;
	/** 1-based line number in the model-provided oldText. */
	oldLine?: number;
	/** Original LF-normalized oldText, never fuzzy-normalized. */
	oldText?: string;
	/** Heuristic similarity for aligned pairs. */
	similarity?: number;
}

export interface ClosestRegion {
	startLine: number;
	endLine: number;
	/** 0..1 order-preserving, one-to-one line similarity. */
	score: number;
	ops: AlignOp[];
	/** Number of exactly equal original lines. */
	equalCount: number;
	totalOldLines: number;
	/** oldText was truncated for comparison (very large oldText). */
	truncated: boolean;
	/** Best distinct, non-overlapping competitor, when retained by the bounded search. */
	competitor?: { startLine: number; endLine: number; score: number };
	/** A discarded window was too competitive to prove a safe score margin. */
	competitionIncomplete: boolean;
}

interface PreparedLine {
	text: string;
	grams: Map<string, number>;
	gramCount: number;
}

function prepareLine(text: string): PreparedLine {
	const grams = new Map<string, number>();
	for (let i = 0; i + 1 < text.length; i++) {
		const gram = text.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return { text, grams, gramCount: Math.max(0, text.length - 1) };
}

class WorkBudget {
	private remaining: number;
	constructor(remaining: number) {
		this.remaining = remaining;
	}
	spend(amount: number): boolean {
		this.remaining -= amount;
		return this.remaining >= 0;
	}
}

/** Dice coefficient over character bigrams; 1.0 for identical strings. */
export function lineSimilarity(a: string, b: string): number {
	return preparedSimilarity(prepareLine(a), prepareLine(b));
}

function preparedSimilarity(a: PreparedLine, b: PreparedLine, budget?: WorkBudget): number {
	if (budget && !budget.spend(1)) throw new Error("similarity-work-budget-exhausted");
	if (a.text === b.text) return 1;
	if (a.gramCount === 0 || b.gramCount === 0) return 0;
	const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
	if (budget && !budget.spend(small.size)) throw new Error("similarity-work-budget-exhausted");
	let overlap = 0;
	for (const [gram, count] of small) {
		const other = large.get(gram);
		if (other) overlap += Math.min(count, other);
	}
	return (2 * overlap) / (a.gramCount + b.gramCount);
}

const MAX_COMPARE_LINES = 300;
const MAX_SEARCH_FILE_LINES = 10_000;
const MAX_CANDIDATE_WINDOWS = 48;
const MAX_QUERY_BYTES = 128 * 1024;
const MAX_LINE_CHARS = 16 * 1024;
const MAX_SIMILARITY_WORK = 20_000_000;
const MIN_SCORE = 0.3;
const MATCH_THRESHOLD = 0.75;

interface CandidateWindow {
	start: number;
	size: number;
	positionalScore: number;
}

interface ScoredWindow extends CandidateWindow {
	score: number;
}

function originalLines(text: string): string[] {
	const lines = normalizeToLF(text).split("\n");
	// Remove only the synthetic segment after a terminal newline. Do not remove
	// a real, unterminated whitespace-only line.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Find the best window and a distinct runner-up under explicit input/work
 * budgets. Returning null is the safe fallback when a budget is exhausted.
 */
export function findClosestRegion(content: string, oldText: string): ClosestRegion | null {
	if (Buffer.byteLength(oldText, "utf8") > MAX_QUERY_BYTES) return null;
	const originalQ = originalLines(oldText);
	const originalContent = originalLines(content);
	if (originalQ.length === 0 || originalContent.length === 0 || originalContent.length > MAX_SEARCH_FILE_LINES) return null;
	if ([...originalQ, ...originalContent].some((line) => line.length > MAX_LINE_CHARS)) return null;

	const allQLines = originalQ.map(normalizeForFuzzyMatch);
	const cLines = originalContent.map(normalizeForFuzzyMatch);
	const truncated = allQLines.length > MAX_COMPARE_LINES;
	const q = truncated ? allQLines.slice(0, MAX_COMPARE_LINES) : allQLines;
	const qOriginal = truncated ? originalQ.slice(0, MAX_COMPARE_LINES) : originalQ;
	const L = q.length;
	const sizes = [...new Set([L - 1, L, L + 1].filter((size) => size >= 1 && size <= cLines.length))];
	const preparedQ = q.map(prepareLine);
	const preparedContent = cLines.map(prepareLine);
	const candidates: CandidateWindow[] = [];
	let discardedMaxPositionalScore = -1;
	const budget = new WorkBudget(MAX_SIMILARITY_WORK);

	try {
		for (const size of sizes) {
			for (let start = 0; start + size <= cLines.length; start++) {
				const pairs = Math.min(L, size);
				let sum = 0;
				for (let i = 0; i < pairs; i++) {
					sum += preparedSimilarity(preparedQ[i], preparedContent[start + i], budget);
				}
				const discarded = keepCandidate(candidates, { start, size, positionalScore: sum / Math.max(L, size) });
				if (discarded !== undefined) discardedMaxPositionalScore = Math.max(discardedMaxPositionalScore, discarded);
			}
		}

		const scored: ScoredWindow[] = candidates.map((candidate) => ({
			...candidate,
			score: sequenceSimilarity(
				preparedQ,
				preparedContent.slice(candidate.start, candidate.start + candidate.size),
				budget,
			),
		}));
		scored.sort(
			(a, b) => b.score - a.score || b.positionalScore - a.positionalScore || a.start - b.start || a.size - b.size,
		);
		const best = scored[0];
		if (!best || best.score < MIN_SCORE) return null;
		const bestEnd = best.start + best.size;
		const runner = scored.find((candidate) => {
			const candidateEnd = candidate.start + candidate.size;
			return candidateEnd <= best.start || candidate.start >= bestEnd;
		});

		const windowLines = cLines.slice(best.start, bestEnd);
		const windowOriginal = originalContent.slice(best.start, bestEnd);
		const ops = alignLines(q, windowLines, qOriginal, windowOriginal, best.start, budget);
		return {
			startLine: best.start + 1,
			endLine: bestEnd,
			score: best.score,
			ops,
			equalCount: ops.filter((op) => op.type === "equal").length,
			totalOldLines: L,
			truncated,
			competitor: runner
				? { startLine: runner.start + 1, endLine: runner.start + runner.size, score: runner.score }
				: undefined,
			competitionIncomplete: discardedMaxPositionalScore >= best.positionalScore - MIN_DIRECT_POSITIONAL_GAP,
		};
	} catch (error) {
		if (error instanceof Error && error.message === "similarity-work-budget-exhausted") return null;
		throw error;
	}
}

const MIN_DIRECT_POSITIONAL_GAP = 0.1;

/** Return the positional score of any candidate discarded by the bounded heap. */
function keepCandidate(candidates: CandidateWindow[], candidate: CandidateWindow): number | undefined {
	if (candidates.length < MAX_CANDIDATE_WINDOWS) {
		candidates.push(candidate);
		candidates.sort((a, b) => a.positionalScore - b.positionalScore || b.start - a.start || b.size - a.size);
		return undefined;
	}
	const worst = candidates[0];
	if (
		candidate.positionalScore < worst.positionalScore ||
		(candidate.positionalScore === worst.positionalScore && candidate.start >= worst.start)
	) return candidate.positionalScore;
	candidates[0] = candidate;
	candidates.sort((a, b) => a.positionalScore - b.positionalScore || b.start - a.start || b.size - a.size);
	return worst.positionalScore;
}

/** Weighted LCS: lines are matched at most once and in source order. */
function sequenceSimilarity(query: PreparedLine[], window: PreparedLine[], budget: WorkBudget): number {
	let previous = new Float64Array(window.length + 1);
	for (let i = 1; i <= query.length; i++) {
		const current = new Float64Array(window.length + 1);
		for (let j = 1; j <= window.length; j++) {
			const matched = previous[j - 1] + preparedSimilarity(query[i - 1], window[j - 1], budget);
			current[j] = Math.max(previous[j], current[j - 1], matched);
		}
		previous = current;
	}
	return previous[window.length] / Math.max(query.length, window.length);
}

/** Align fuzzy lines while attaching original strings to every operation. */
function alignLines(
	q: string[],
	w: string[],
	qOriginal: string[],
	wOriginal: string[],
	wOffset: number,
	budget: WorkBudget,
): AlignOp[] {
	const n = q.length;
	const m = w.length;
	const preparedQ = q.map(prepareLine);
	const preparedW = w.map(prepareLine);
	const similarities = Array.from({ length: n }, (_, i) =>
		Array.from({ length: m }, (_, j) => preparedSimilarity(preparedQ[i], preparedW[j], budget)),
	);
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = similarities[i][j] >= MATCH_THRESHOLD
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const raw: AlignOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (similarities[i][j] >= MATCH_THRESHOLD) {
			const exact = qOriginal[i] === wOriginal[j];
			raw.push({
				type: exact ? "equal" : "similar",
				fileLine: wOffset + j + 1,
				fileText: wOriginal[j],
				oldLine: i + 1,
				oldText: qOriginal[i],
				similarity: similarities[i][j],
			});
			i++;
			j++;
		} else if (dp[i + 1][j] > dp[i][j + 1]) {
			raw.push({ type: "old-only", oldLine: i + 1, oldText: qOriginal[i++] });
		} else {
			raw.push({ type: "file-only", fileLine: wOffset + j + 1, fileText: wOriginal[j++] });
		}
	}
	while (i < n) raw.push({ type: "old-only", oldLine: i + 1, oldText: qOriginal[i++] });
	while (j < m) raw.push({ type: "file-only", fileLine: wOffset + j + 1, fileText: wOriginal[j++] });

	const merged: AlignOp[] = [];
	for (let k = 0; k < raw.length; k++) {
		const op = raw[k];
		const next = raw[k + 1];
		if (op.type === "old-only" && next?.type === "file-only") {
			merged.push({ type: "changed", fileLine: next.fileLine, fileText: next.fileText, oldLine: op.oldLine, oldText: op.oldText });
			k++;
		} else if (op.type === "file-only" && next?.type === "old-only") {
			merged.push({ type: "changed", fileLine: op.fileLine, fileText: op.fileText, oldLine: next.oldLine, oldText: next.oldText });
			k++;
		} else {
			merged.push(op);
		}
	}
	return merged;
}

/** Cheap probes for common causes of a failed match. */
export function probeMatchCauses(content: string, oldText: string): string[] {
	const causes: string[] = [];
	const stripWS = (value: string) => value.replace(/\s+/g, "");
	if (stripWS(content).includes(stripWS(oldText))) {
		causes.push("whitespace mismatch: the text matches when ALL whitespace is removed — check tabs vs spaces and indentation width");
	} else if (content.toLowerCase().includes(oldText.toLowerCase())) {
		causes.push("letter-case mismatch: the text matches case-insensitively");
	}
	const fileHasTabs = content.includes("\t");
	const oldHasTabs = oldText.includes("\t");
	if (fileHasTabs && !oldHasTabs) causes.push("the file contains tab characters but your oldText uses spaces");
	else if (!fileHasTabs && oldHasTabs) causes.push("your oldText contains tab characters but the file uses spaces");
	return causes;
}

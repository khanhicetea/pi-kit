/**
 * Bounded fuzzy line similarity used to locate the region of a file that a
 * failed oldText almost matched.
 */

import { toFuzzyLines } from "./text.ts";

export interface AlignOp {
	type: "equal" | "changed" | "file-only" | "old-only";
	/** 1-based line number in the file (for equal/changed/file-only). */
	fileLine?: number;
	fileText?: string;
	/** 1-based line number in the model-provided oldText. */
	oldLine?: number;
	oldText?: string;
}

export interface ClosestRegion {
	startLine: number;
	endLine: number;
	/** 0..1 order-preserving, one-to-one line similarity. */
	score: number;
	ops: AlignOp[];
	equalCount: number;
	totalOldLines: number;
	/** oldText was truncated for comparison (very large oldText). */
	truncated: boolean;
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

/** Dice coefficient over character bigrams; 1.0 for identical strings. */
export function lineSimilarity(a: string, b: string): number {
	return preparedSimilarity(prepareLine(a), prepareLine(b));
}

function preparedSimilarity(a: PreparedLine, b: PreparedLine): number {
	if (a.text === b.text) return 1;
	if (a.gramCount === 0 || b.gramCount === 0) return 0;
	const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
	let overlap = 0;
	for (const [gram, count] of small) {
		const other = large.get(gram);
		if (other) overlap += Math.min(count, other);
	}
	return (2 * overlap) / (a.gramCount + b.gramCount);
}

const MAX_COMPARE_LINES = 300;
const MAX_SEARCH_FILE_LINES = 10_000;
const MAX_CANDIDATE_WINDOWS = 24;
const MIN_SCORE = 0.3;
const MATCH_THRESHOLD = 0.75;

interface CandidateWindow {
	start: number;
	size: number;
	positionalScore: number;
}

/**
 * Find the window of file lines most similar to oldText.
 *
 * The first pass ranks every window using cheap positional similarity. Only a
 * small bounded set of candidates receives the more expensive sequence score.
 * The sequence score is order-preserving and one-to-one, so repeated query
 * lines cannot all claim the same file line.
 */
export function findClosestRegion(content: string, oldText: string): ClosestRegion | null {
	const allQLines = toFuzzyLines(oldText);
	const cLines = toFuzzyLines(content);
	if (allQLines.length === 0 || cLines.length === 0 || cLines.length > MAX_SEARCH_FILE_LINES) return null;

	const truncated = allQLines.length > MAX_COMPARE_LINES;
	const q = truncated ? allQLines.slice(0, MAX_COMPARE_LINES) : allQLines;
	const L = q.length;
	const sizes = [...new Set([L - 1, L, L + 1].filter((size) => size >= 1 && size <= cLines.length))];
	const preparedQ = q.map(prepareLine);
	const preparedContent = cLines.map(prepareLine);
	const candidates: CandidateWindow[] = [];

	for (const size of sizes) {
		for (let start = 0; start + size <= cLines.length; start++) {
			const pairs = Math.min(L, size);
			let sum = 0;
			for (let i = 0; i < pairs; i++) {
				sum += preparedSimilarity(preparedQ[i], preparedContent[start + i]);
			}
			keepCandidate(candidates, { start, size, positionalScore: sum / Math.max(L, size) });
		}
	}

	let bestScore = -1;
	let best: CandidateWindow | undefined;
	for (const candidate of candidates) {
		const window = preparedContent.slice(candidate.start, candidate.start + candidate.size);
		const score = sequenceSimilarity(preparedQ, window);
		if (score > bestScore || (score === bestScore && candidate.positionalScore > (best?.positionalScore ?? -1))) {
			bestScore = score;
			best = candidate;
		}
	}
	if (!best || bestScore < MIN_SCORE) return null;

	const windowLines = cLines.slice(best.start, best.start + best.size);
	const ops = alignLines(q, windowLines, best.start);
	return {
		startLine: best.start + 1,
		endLine: best.start + best.size,
		score: bestScore,
		ops,
		equalCount: ops.filter((op) => op.type === "equal").length,
		totalOldLines: L,
		truncated,
	};
}

function keepCandidate(candidates: CandidateWindow[], candidate: CandidateWindow): void {
	if (candidates.length < MAX_CANDIDATE_WINDOWS) {
		candidates.push(candidate);
		candidates.sort((a, b) => a.positionalScore - b.positionalScore);
		return;
	}
	if (candidate.positionalScore <= candidates[0].positionalScore) return;
	candidates[0] = candidate;
	candidates.sort((a, b) => a.positionalScore - b.positionalScore);
}

/** Weighted LCS: lines are matched at most once and in source order. */
function sequenceSimilarity(query: PreparedLine[], window: PreparedLine[]): number {
	let previous = new Float64Array(window.length + 1);
	for (let i = 1; i <= query.length; i++) {
		const current = new Float64Array(window.length + 1);
		for (let j = 1; j <= window.length; j++) {
			const matched = previous[j - 1] + preparedSimilarity(query[i - 1], window[j - 1]);
			current[j] = Math.max(previous[j], current[j - 1], matched);
		}
		previous = current;
	}
	return previous[window.length] / Math.max(query.length, window.length);
}

/**
 * LCS-style alignment between oldText lines and the best window. Lines with
 * similarity >= MATCH_THRESHOLD count as equal; adjacent insert/delete pairs
 * are merged into changed operations for compact diagnostics.
 */
function alignLines(q: string[], w: string[], wOffset: number): AlignOp[] {
	const n = q.length;
	const m = w.length;
	const preparedQ = q.map(prepareLine);
	const preparedW = w.map(prepareLine);
	const similarities = Array.from({ length: n }, (_, i) =>
		Array.from({ length: m }, (_, j) => preparedSimilarity(preparedQ[i], preparedW[j])),
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
			raw.push({ type: "equal", fileLine: wOffset + j + 1, fileText: w[j], oldLine: i + 1, oldText: q[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] > dp[i][j + 1]) {
			raw.push({ type: "old-only", oldLine: i + 1, oldText: q[i++] });
		} else {
			raw.push({ type: "file-only", fileLine: wOffset + j + 1, fileText: w[j++] });
		}
	}
	while (i < n) raw.push({ type: "old-only", oldLine: i + 1, oldText: q[i++] });
	while (j < m) raw.push({ type: "file-only", fileLine: wOffset + j + 1, fileText: w[j++] });

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

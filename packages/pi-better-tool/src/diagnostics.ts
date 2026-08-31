/**
 * Failure diagnostics for the better edit tool.
 *
 * Turns structured matching failures into recovery context the model can act
 * on immediately, without re-reading the file:
 *
 * - ambiguous oldText → every occurrence's line number plus the *minimal*
 *   prefix/suffix context expansion that makes that occurrence unique,
 *   rendered as a ready-to-use oldText snippet
 * - not-found oldText  → the closest matching region (fuzzy line similarity),
 *   a per-line comparison, and the exact file bytes to retry with
 */

import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { EditFailure, EditOp, LineRange } from "./apply.ts";
import { normalizeEdits } from "./apply.ts";
import { findClosestRegion, lineSimilarity, probeMatchCauses } from "./similarity.ts";
import {
	countFuzzyOccurrences,
	getLineSpans,
	lineAt,
	normalizeForFuzzyMatch,
	type LineSpan,
} from "./text.ts";

/** Skip expensive diagnostics for huge files; the plain error still works. */
const MAX_CONTENT_FOR_DIAGNOSTICS = 2_000_000;
/** Max total context lines tried when growing an occurrence to uniqueness. */
const MAX_TOTAL_CONTEXT_LINES = 12;
/** Occurrences listed with line numbers. */
const MAX_LISTED_OCCURRENCES = 8;
/** Occurrences that get a ready-to-use disambiguation snippet. */
const MAX_SNIPPET_OCCURRENCES = 3;
/** Max lines/bytes shown inside a copyable snippet. */
const MAX_SNIPPET_LINES = 60;
const MAX_SNIPPET_BYTES = 12 * 1024;
/** Hard model-context bound for the complete tool error. */
const MAX_OUTPUT_LINES = 1_500;
const MAX_OUTPUT_BYTES = 48 * 1024;
/** Minimum score at which a unique closest region may be suggested directly. */
const MIN_DIRECT_RETRY_SCORE = 0.75;
/** Max non-equal alignment ops rendered. */
const MAX_DIFF_OPS_SHOWN = 12;

export interface Expansion {
	/** Whole lines of prefix context included. */
	prefixLines: number;
	/** Whole lines of suffix context included. */
	suffixLines: number;
	/** Exact file bytes to use as the new oldText. */
	text: string;
	startLine: number;
	endLine: number;
}

export interface FormatFailureOptions {
	path: string;
	/** LF-normalized, BOM-stripped file content. */
	normalizedContent: string;
	/** Raw edits as provided by the model. */
	edits: EditOp[];
	failure: EditFailure;
}

export function formatEditFailure(opts: FormatFailureOptions): string {
	const message = formatEditFailureUnbounded(opts);
	const bounded = truncateHead(message, { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES });
	if (!bounded.truncated) return message;
	return `${bounded.content}\n\n[Diagnostic output truncated to ${formatSize(bounded.outputBytes)} / ${bounded.outputLines} lines. Any incomplete snippet is not retryable; read the referenced range first.]`;
}

function formatEditFailureUnbounded(opts: FormatFailureOptions): string {
	const { path, normalizedContent, edits, failure } = opts;
	const total = edits.length;

	switch (failure.kind) {
		case "empty-old-text": {
			return total === 1
				? `oldText must not be empty in ${path}.`
				: `edits[${failure.editIndex}].oldText must not be empty in ${path}.`;
		}

		case "not-found": {
			const head =
				total === 1
					? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${failure.editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
			const normalized = normalizeEdits(edits)[failure.editIndex];
			const body =
				normalizedContent.length <= MAX_CONTENT_FOR_DIAGNOSTICS
					? formatNotFound(opts, normalized.oldText)
					: "File is too large for closest-match diagnostics; read the relevant region and retry.";
			return `${head}\n\n${body}\n\nNo changes were written — the file was not modified.`;
		}

		case "ambiguous": {
			const head =
				total === 1
					? `Found ${failure.occurrenceOffsets.length} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${failure.occurrenceOffsets.length} occurrences of edits[${failure.editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`;
			const body =
				normalizedContent.length <= MAX_CONTENT_FOR_DIAGNOSTICS
					? formatAmbiguous(opts, failure)
					: "File is too large for disambiguation diagnostics; read the relevant region and retry with more context.";
			return `${head}\n\n${body}\n\nNo changes were written — the file was not modified.`;
		}

		case "overlap": {
			const { firstEditIndex, secondEditIndex, firstRange, secondRange } = failure;
			return `edits[${firstEditIndex}] and edits[${secondEditIndex}] overlap in ${path} (edits[${firstEditIndex}] covers lines ${firstRange.start}-${firstRange.end}, edits[${secondEditIndex}] covers lines ${secondRange.start}-${secondRange.end}). Merge them into one edit or target disjoint regions.`;
		}

		case "no-change": {
			return total === 1
				? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
				: `No changes made to ${path}. The replacements produced identical content.`;
		}
	}
}

// ---------------------------------------------------------------------------
// Ambiguous: per-occurrence minimal prefix/suffix expansion
// ---------------------------------------------------------------------------

function formatAmbiguous(opts: FormatFailureOptions, failure: Extract<EditFailure, { kind: "ambiguous" }>): string {
	const { normalizedContent } = opts;
	const oldText = normalizeEdits(opts.edits)[failure.editIndex].oldText;
	const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
	const fuzzyOld = normalizeForFuzzyMatch(oldText);
	const fuzzySpans = getLineSpans(fuzzyContent);
	const spans = getLineSpans(normalizedContent);

	const lines: string[] = [];
	const listed = failure.occurrenceOffsets.slice(0, MAX_LISTED_OCCURRENCES);
	lines.push("Occurrences:");
	listed.forEach((offset, i) => {
		const range = rangeFromOffset(fuzzySpans, offset, fuzzyOld.length);
		lines.push(`  ${i + 1}. ${describeLines(range.start, range.end)}`);
	});
	if (failure.occurrenceOffsets.length > listed.length) {
		lines.push(`  … and ${failure.occurrenceOffsets.length - listed.length} more`);
	}
	lines.push("");

	lines.push(
		"Disambiguated oldText candidates are shown below when they fit safely. A fenced snippet can be reused exactly; an omitted snippet must be read from its referenced range first:",
	);

	let shown = 0;
	let missingExpansionNote = false;
	let omittedSnippet = false;
	for (let i = 0; i < listed.length && shown < MAX_SNIPPET_OCCURRENCES; i++) {
		const offset = listed[i];
		const range = rangeFromOffset(fuzzySpans, offset, fuzzyOld.length);
		const expansion = findMinimalUniqueExpansion(normalizedContent, fuzzyContent, spans, range);
		if (!expansion) {
			missingExpansionNote = true;
			continue;
		}
		const where = `minimum context: ${plural(expansion.prefixLines, "line")} before, ${plural(expansion.suffixLines, "line")} after`;
		lines.push("");
		if (!isSnippetRenderable(expansion.text)) {
			omittedSnippet = true;
			lines.push(
				`Occurrence ${i + 1} (${describeLines(range.start, range.end)}) — ${where}. Exact unique snippet omitted because it exceeds the safe output limit; read lines ${expansion.startLine}-${expansion.endLine}.`,
			);
			continue;
		}
		shown++;
		lines.push(`Occurrence ${i + 1} (${describeLines(range.start, range.end)}) — ${where}:`);
		lines.push(...renderSnippet(expansion.text));
	}

	if (missingExpansionNote) {
		lines.push("");
		lines.push(
			`Some occurrences could not be auto-disambiguated within ${MAX_TOTAL_CONTEXT_LINES} context lines (likely near-identical repeated blocks). Extend oldText manually with distinguishing lines from the occurrences listed above.`,
		);
	}
	if (shown === 0 && !missingExpansionNote && !omittedSnippet) {
		lines.push("", "Extend oldText with more surrounding lines until it matches exactly one location.");
	}
	lines.push("");
	lines.push(
		"Tip: only fenced snippets above are byte-for-byte retryable. Make newText from the chosen snippet with your intended change applied.",
	);
	return lines.join("\n");
}

function rangeFromOffset(spans: LineSpan[], offset: number, length: number): LineRange {
	return { start: lineAt(spans, offset) + 1, end: lineAt(spans, offset + Math.max(1, length) - 1) + 1 };
}

function describeLines(start: number, end: number): string {
	return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Find the smallest whole-line context expansion of the occurrence at `range`
 * whose text occurs exactly once in the file (checked in fuzzy space, exactly
 * like the matching engine's uniqueness rule).
 *
 * The search starts from the occurrence's own full lines (zero extra context),
 * which also covers duplicates that share a line: whenever any anchored
 * substring of those lines could be unique, the full lines are unique too.
 */
export function findMinimalUniqueExpansion(
	content: string,
	fuzzyContent: string,
	spans: LineSpan[],
	range: LineRange,
): Expansion | null {
	const totalLines = spans.length;
	const maxPrefix = range.start - 1;
	const maxSuffix = totalLines - range.end;

	for (let total = 0; total <= MAX_TOTAL_CONTEXT_LINES; total++) {
		for (let prefix = 0; prefix <= total; prefix++) {
			const suffix = total - prefix;
			if (prefix > maxPrefix || suffix > maxSuffix) continue;
			const startLine = range.start - prefix;
			const endLine = range.end + suffix;
			const candidate = sliceLines(content, spans, startLine, endLine);
			const verified = verifyUniqueSnippet(fuzzyContent, candidate);
			if (verified) {
				return {
					prefixLines: prefix,
					suffixLines: suffix,
					text: verified,
					startLine,
					endLine,
				};
			}
		}
	}
	return null;
}

function sliceLines(content: string, spans: LineSpan[], startLine: number, endLine: number): string {
	return content.slice(spans[startLine - 1].start, spans[endLine - 1].end);
}

/**
 * A snippet is handed to the model inside a fenced block; strip one trailing
 * newline so copying is unambiguous, but only if the stripped version is still
 * unique (a trailing newline can participate in uniqueness).
 */
function verifyUniqueSnippet(fuzzyContent: string, candidate: string): string | null {
	const stripped = candidate.endsWith("\n") ? candidate.slice(0, -1) : candidate;
	if (countFuzzyOccurrences(fuzzyContent, stripped) === 1) return stripped;
	if (stripped !== candidate && countFuzzyOccurrences(fuzzyContent, candidate) === 1) return candidate;
	return null;
}

// ---------------------------------------------------------------------------
// Not-found: closest region + per-line comparison + exact bytes
// ---------------------------------------------------------------------------

function formatNotFound(opts: FormatFailureOptions, oldText: string): string {
	const { normalizedContent } = opts;
	const closest = findClosestRegion(normalizedContent, oldText);
	const causes = probeMatchCauses(normalizedContent, oldText);

	const lines: string[] = [];
	if (closest) {
		lines.push(
			`Closest match in the file: ${describeLines(closest.startLine, closest.endLine)} (~${Math.round(closest.score * 100)}% line similarity${closest.truncated ? `, compared against the first ${closest.totalOldLines} lines of your oldText` : ""}).`,
		);
		const diffOps = closest.ops.filter((op) => op.type !== "equal");
		if (diffOps.length === 0) {
			// All compared lines passed the similarity threshold; surface the
			// least-similar pair so small content drift (punctuation, extra
			// characters) is not misreported as a pure whitespace issue.
			let worst: { fileLine?: number; fileText?: string; oldLine?: number; oldText?: string; sim: number } | null = null;
			for (const op of closest.ops) {
				if (op.type !== "equal" || op.fileText === undefined || op.oldText === undefined) continue;
				const sim = lineSimilarity(op.fileText, op.oldText);
				if (!worst || sim < worst.sim) worst = { ...op, sim };
			}
			if (worst && worst.sim < 0.999) {
				lines.push(
					`No structural differences, but file line ${worst.fileLine} and your oldText line ${worst.oldLine} are only ~${Math.round(worst.sim * 100)}% similar:`,
				);
				lines.push(`    file:     ${truncateLine(worst.fileText ?? "")}`);
				lines.push(`    oldText:  ${truncateLine(worst.oldText ?? "")}`);
			} else {
				lines.push(
					"Every compared line matches individually — the mismatch is probably in line boundaries or trailing whitespace.",
				);
			}
		} else {
			lines.push(`Differences vs your oldText (${closest.equalCount} of ${closest.totalOldLines} compared lines match):`);
			for (const op of diffOps.slice(0, MAX_DIFF_OPS_SHOWN)) {
				if (op.type === "changed") {
					lines.push(`  file line ${op.fileLine} differs from your oldText line ${op.oldLine}:`);
					lines.push(`    file:     ${truncateLine(op.fileText ?? "")}`);
					lines.push(`    oldText:  ${truncateLine(op.oldText ?? "")}`);
				} else if (op.type === "file-only") {
					lines.push(
						`  file line ${op.fileLine} is missing from your oldText: ${truncateLine(op.fileText ?? "")}`,
					);
				} else {
					lines.push(`  your oldText line ${op.oldLine} is not present in the file: ${truncateLine(op.oldText ?? "")}`);
				}
			}
			if (diffOps.length > MAX_DIFF_OPS_SHOWN) {
				lines.push(`  … ${diffOps.length - MAX_DIFF_OPS_SHOWN} more differing lines`);
			}
		}
		lines.push("");
		const candidate = textFromLines(normalizedContent, closest.startLine, closest.endLine);
		const uniqueCandidate = verifyUniqueSnippet(normalizeForFuzzyMatch(normalizedContent), candidate);
		const safelyRenderable = isSnippetRenderable(uniqueCandidate ?? candidate);
		const directRetry =
			!closest.truncated &&
			closest.score >= MIN_DIRECT_RETRY_SCORE &&
			uniqueCandidate !== null &&
			safelyRenderable;
		if (directRetry) {
			lines.push(
				`Exact file content at ${describeLines(closest.startLine, closest.endLine)} (unique under edit matching) — retry using this text as oldText (then apply your change to newText):`,
			);
			lines.push(...renderSnippet(uniqueCandidate));
		} else {
			const reasons = [
				closest.truncated ? "only part of oldText was compared" : undefined,
				closest.score < MIN_DIRECT_RETRY_SCORE ? "similarity confidence is too low" : undefined,
				uniqueCandidate === null ? "the candidate is not unique under edit matching" : undefined,
				!safelyRenderable ? "the exact candidate exceeds the safe output limit" : undefined,
			].filter((reason): reason is string => reason !== undefined);
			lines.push(
				`Candidate file content at ${describeLines(closest.startLine, closest.endLine)} is not safe for a direct retry (${reasons.join("; ")}). Read and verify this range before editing.`,
			);
			if (safelyRenderable) lines.push(...renderSnippet(uniqueCandidate ?? candidate));
		}

	} else {
		lines.push("No reliable similar region was found within the bounded diagnostic search.");
		lines.push("If you expected this text to exist, read the file around the expected location and retry.");
	}

	if (causes.length > 0) {
		lines.push("");
		lines.push("Possible cause:");
		for (const cause of causes) lines.push(`- ${cause}`);
	}
	return lines.join("\n");
}

function truncateLine(line: string): string {
	const collapsed = line.replace(/\t/g, "→tab→");
	return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

// ---------------------------------------------------------------------------
// Snippet rendering
// ---------------------------------------------------------------------------

function textFromLines(content: string, startLine: number, endLine: number): string {
	const spans = getLineSpans(content);
	return content.slice(spans[startLine - 1].start, spans[endLine - 1].end);
}

function isSnippetRenderable(text: string): boolean {
	return text.split("\n").length <= MAX_SNIPPET_LINES && Buffer.byteLength(text, "utf8") <= MAX_SNIPPET_BYTES;
}

/** Render only complete snippets. Callers must check isSnippetRenderable first. */
function renderSnippet(text: string): string[] {
	if (!isSnippetRenderable(text)) {
		return ["[Exact snippet omitted because it exceeds the safe output limit; read the referenced range first.]" ];
	}
	const fence = fenceFor(text);
	return [fence, text, fence];
}

/** Choose a fence longer than any backtick run inside the snippet. */
export function fenceFor(text: string): string {
	let max = 2;
	const runs = text.match(/`{3,}/g) ?? [];
	for (const run of runs) max = Math.max(max, run.length);
	return "`".repeat(Math.max(3, max + 1));
}

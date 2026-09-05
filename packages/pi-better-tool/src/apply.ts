/**
 * Edit matching and application engine.
 *
 * A port of pi's built-in `applyEditsToNormalizedContent`. Instead of throwing
 * opaque errors, `analyzeEdits` returns a structured failure describing *why*
 * an edit failed. It also rejects fuzzy-normalized-empty needles and can accept
 * a conservatively verified literal selection as intentional safety extensions.
 *
 * Otherwise matching semantics follow the built-in tool:
 * - exact match first, then fuzzy-normalized fallback (trailing whitespace,
 *   smart quotes, dashes, unicode spaces)
 * - uniqueness is always checked in fully fuzzy-normalized space
 * - all edits match against the same original content (not incrementally)
 * - overlap detection, empty-oldText and no-change detection
 */

import {
	countFuzzyOccurrences,
	findAllOccurrences,
	getLineSpans,
	getLogicalLineSpans,
	lineAt,
	normalizeForFuzzyMatch,
	normalizeToLF,
	splitLogicalLinesWithEndings,
	type LineSpan,
} from "./text.ts";

export interface EditOp {
	oldText: string;
	newText: string;
}

/** 1-based inclusive line range. */
export interface LineRange {
	start: number;
	end: number;
}

export type EditFailure =
	| { kind: "empty-old-text"; editIndex: number }
	| { kind: "not-found"; editIndex: number }
	| {
			kind: "ambiguous";
			editIndex: number;
			/** Total non-overlapping occurrences in fully fuzzy-normalized space. */
			occurrenceCount: number;
			/** A bounded prefix of occurrence offsets for diagnostics/selection. */
			occurrenceOffsets: number[];
	  }
	| {
			kind: "overlap";
			firstEditIndex: number;
			secondEditIndex: number;
			firstRange: LineRange;
			secondRange: LineRange;
	  }
	| { kind: "no-change" };

export interface Replacement {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface EditAnalysis {
	/** Sorted by matchIndex ascending. */
	replacements: Replacement[];
	usedFuzzyMatch: boolean;
}

export interface FuzzyFindResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

export type AnalyzeResult = { ok: true; analysis: EditAnalysis } | { ok: false; failure: EditFailure };

export interface AnalyzeOptions {
	/**
	 * Exact offsets chosen for otherwise-ambiguous edits. Offsets are accepted
	 * only when they point at the literal oldText in the matching base.
	 */
	ambiguousSelections?: ReadonlyMap<number, number>;
}

/** Avoid materializing unbounded offset arrays for highly repetitive files. */
const MAX_TRACKED_OCCURRENCE_OFFSETS = 256;

export function normalizeEdits(edits: EditOp[]): EditOp[] {
	return edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
}

/** Find oldText in content, trying exact match first, then fuzzy match. */
export function fuzzyFindText(content: string, oldText: string): FuzzyFindResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function rangeOf(spans: LineSpan[], matchIndex: number, matchLength: number): LineRange {
	return {
		start: lineAt(spans, matchIndex) + 1,
		end: lineAt(spans, matchIndex + Math.max(1, matchLength) - 1) + 1,
	};
}

export function analyzeEdits(normalizedContent: string, rawEdits: EditOp[], options: AnalyzeOptions = {}): AnalyzeResult {
	const edits = normalizeEdits(rawEdits);
	for (let i = 0; i < edits.length; i++) {
		// Fuzzy normalization can erase whitespace-only needles. Allowing an
		// empty normalized needle makes String#indexOf match at offset zero and
		// turns an intended replacement into an insertion.
		if (edits[i].oldText.length === 0 || normalizeForFuzzyMatch(edits[i].oldText).length === 0) {
			return { ok: false, failure: { kind: "empty-old-text", editIndex: i } };
		}
	}

	const initialMatches = edits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const base = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
	const fuzzyBase = normalizeForFuzzyMatch(base);
	const spans = getLineSpans(base);

	const replacements: Replacement[] = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const matchResult = fuzzyFindText(base, edit.oldText);
		if (!matchResult.found) {
			return { ok: false, failure: { kind: "not-found", editIndex: i } };
		}
		const occurrences = countFuzzyOccurrences(fuzzyBase, edit.oldText);
		let selectedMatch = matchResult;
		if (occurrences > 1) {
			const occurrenceOffsets = findAllOccurrences(
				fuzzyBase,
				normalizeForFuzzyMatch(edit.oldText),
				MAX_TRACKED_OCCURRENCE_OFFSETS,
			);
			const selectedOffset = options.ambiguousSelections?.get(i);
			if (
				selectedOffset === undefined ||
				base.slice(selectedOffset, selectedOffset + edit.oldText.length) !== edit.oldText
			) {
				return {
					ok: false,
					failure: { kind: "ambiguous", editIndex: i, occurrenceCount: occurrences, occurrenceOffsets },
				};
			}
			selectedMatch = {
				found: true,
				index: selectedOffset,
				matchLength: edit.oldText.length,
				usedFuzzyMatch: false,
				contentForReplacement: base,
			};
		}
		replacements.push({
			editIndex: i,
			matchIndex: selectedMatch.index,
			matchLength: selectedMatch.matchLength,
			newText: edit.newText,
		});
	}

	replacements.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < replacements.length; i++) {
		const previous = replacements[i - 1];
		const current = replacements[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			return {
				ok: false,
				failure: {
					kind: "overlap",
					firstEditIndex: previous.editIndex,
					secondEditIndex: current.editIndex,
					firstRange: rangeOf(spans, previous.matchIndex, previous.matchLength),
					secondRange: rangeOf(spans, current.matchIndex, current.matchLength),
				},
			};
		}
	}

	return { ok: true, analysis: { replacements, usedFuzzyMatch } };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/** 0-based, end-exclusive window of lines used by the fuzzy overlay. */
interface InternalLineWindow {
	startLine: number;
	endLine: number;
}

function getReplacementLineRange(lines: LineSpan[], replacement: Replacement): InternalLineWindow {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}
	return { startLine, endLine: endLine + 1 };
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original (fuzzy-match overlay).
 */
function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: Replacement[],
): string {
	const originalLines = splitLogicalLinesWithEndings(originalContent);
	const baseLines = getLogicalLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different logical line count.");
	}

	const groups: Array<InternalLineWindow & { replacements: Replacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");
	return result;
}

export function applyAnalysis(normalizedContent: string, analysis: EditAnalysis): { baseContent: string; newContent: string } {
	const baseContent = normalizedContent;
	const newContent = analysis.usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(
				normalizedContent,
				normalizeForFuzzyMatch(normalizedContent),
				analysis.replacements,
			)
		: applyReplacements(baseContent, analysis.replacements);
	return { baseContent, newContent };
}

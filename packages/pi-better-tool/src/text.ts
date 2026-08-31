/**
 * Text normalization utilities.
 *
 * These are ports of the helpers pi's built-in edit tool uses (edit-diff.ts),
 * kept byte-for-byte compatible in behavior so that suggestions produced by
 * this package's diagnostics are guaranteed to match what the same matching
 * engine accepts.
 */

export interface LineSpan {
	/** Character offset of the line start (inclusive). */
	start: number;
	/** Character offset of the line end (exclusive, includes the trailing \n when present). */
	end: number;
}

export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

export function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - NFKC normalization
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 *
 * Line-count preserving and idempotent.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes -> '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes -> "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens -> -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces -> regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

/** 0-based index of the line containing `offset` (clamped to the last line). */
export function lineAt(spans: LineSpan[], offset: number): number {
	let lo = 0;
	let hi = spans.length - 1;
	let result = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (spans[mid].start <= offset) {
			result = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return result;
}

/**
 * Count occurrences of `needle` in fully fuzzy-normalized space, using the
 * same normalization the matching engine uses for its uniqueness check.
 * `fuzzyContent` must already be `normalizeForFuzzyMatch`-ed.
 */
export function countFuzzyOccurrences(fuzzyContent: string, needle: string): number {
	if (!needle) return 0;
	return fuzzyContent.split(normalizeForFuzzyMatch(needle)).length - 1;
}

/** All start offsets of `needle` in `haystack` (literal string search). */
export function findAllOccurrences(haystack: string, needle: string): number[] {
	const offsets: number[] = [];
	if (!needle) return offsets;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		offsets.push(idx);
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return offsets;
}

/** Split into lines for similarity comparison (fuzzy-normalized, no trailing-empty artifact). */
export function toFuzzyLines(text: string): string[] {
	const lines = normalizeToLF(text).split("\n").map((line) => normalizeForFuzzyMatch(line));
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

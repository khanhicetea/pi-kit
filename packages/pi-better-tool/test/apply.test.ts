import { describe, expect, it } from "vitest";
import { analyzeEdits, applyAnalysis, type EditOp } from "../src/apply.ts";
import { normalizeForFuzzyMatch, toFuzzyLines } from "../src/text.ts";

const content = (parts: string[]) => parts.join("");

describe("normalizeForFuzzyMatch (parity with built-in edit tool)", () => {
	it("strips trailing whitespace per line", () => {
		expect(normalizeForFuzzyMatch("foo   \nbar\t\n")).toBe("foo\nbar\n");
	});

	it("normalizes smart quotes, dashes, and unicode spaces", () => {
		expect(normalizeForFuzzyMatch("don\u2019t \u201Cquoted\u201D")).toBe("don't \"quoted\"");
		expect(normalizeForFuzzyMatch("a\u2014b \u2212c")).toBe("a-b -c");
		expect(normalizeForFuzzyMatch("a\u00A0b\u2003c")).toBe("a b c");
	});

	it("preserves line count", () => {
		expect(toFuzzyLines("a\nb\nc").length).toBe(3);
		expect(toFuzzyLines("a\nb\nc\n").length).toBe(3);
	});

	it("is idempotent", () => {
		const once = normalizeForFuzzyMatch("x\u00A0\u2019 \t\ny\u202F");
		expect(normalizeForFuzzyMatch(once)).toBe(once);
	});
});

describe("analyzeEdits", () => {
	it("finds a unique exact match", () => {
		const file = "alpha\nbeta\ngamma\n";
		const result = analyzeEdits(file, [{ oldText: "beta", newText: "BETA" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.analysis.replacements).toHaveLength(1);
			expect(result.analysis.replacements[0].matchIndex).toBe(6);
			expect(result.analysis.usedFuzzyMatch).toBe(false);
		}
	});

	it("reports not-found", () => {
		const result = analyzeEdits("alpha\nbeta\n", [{ oldText: "delta", newText: "x" }]);
		expect(result).toEqual({ ok: false, failure: { kind: "not-found", editIndex: 0 } });
	});

	it("reports ambiguity with all occurrence offsets", () => {
		const file = "one\ntwo\none\nthree\none\n";
		const result = analyzeEdits(file, [{ oldText: "one", newText: "1" }]);
		expect(result.ok).toBe(false);
		if (!result.ok && result.failure.kind === "ambiguous") {
			expect(result.failure.editIndex).toBe(0);
			expect(result.failure.occurrenceCount).toBe(3);
			expect(result.failure.occurrenceOffsets).toHaveLength(3);
			expect(file.slice(result.failure.occurrenceOffsets[0], 3)).toBe("one");
		} else {
			expect.unreachable("expected ambiguous failure");
		}
	});

	it("accepts an explicitly selected literal offset for an ambiguous edit", () => {
		const file = "one\ntwo\none\n";
		const result = analyzeEdits(file, [{ oldText: "one", newText: "1" }], {
			ambiguousSelections: new Map([[0, 8]]),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(applyAnalysis(file, result.analysis).newContent).toBe("one\ntwo\n1\n");
		}
	});

	it("rejects an explicit ambiguous selection that does not point at literal oldText", () => {
		const result = analyzeEdits("one\ntwo\none\n", [{ oldText: "one", newText: "1" }], {
			ambiguousSelections: new Map([[0, 4]]),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.kind).toBe("ambiguous");
	});

	it("detects ambiguity in fuzzy space even when the exact text occurs once", () => {
		// "dup  " (trailing spaces) fuzzy-matches "dup"
		const file = "dup  \nother\ndup\n";
		const result = analyzeEdits(file, [{ oldText: "dup", newText: "x" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.kind).toBe("ambiguous");
		}
	});

	it("uses fuzzy matching as a fallback for trailing whitespace", () => {
		// exact "value\nnext" fails: line 2 has trailing spaces before the newline
		const file = "keep\nvalue   \nnext\nkeep\n";
		const result = analyzeEdits(file, [{ oldText: "value\nnext", newText: "v\nn" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.analysis.usedFuzzyMatch).toBe(true);
			const applied = applyAnalysis(file, result.analysis);
			expect(applied.newContent).toBe("keep\nv\nn\nkeep\n");
		}
	});

	it("rejects empty and fuzzy-normalized-empty oldText", () => {
		for (const oldText of ["", " ", "\t", "  \t"]) {
			const result = analyzeEdits("abc", [{ oldText, newText: "x" }]);
			expect(result).toEqual({ ok: false, failure: { kind: "empty-old-text", editIndex: 0 } });
		}
	});

	it("retains Pi's non-overlapping occurrence policy for self-overlapping needles", () => {
		const result = analyzeEdits("aaa", [{ oldText: "aa", newText: "X" }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(applyAnalysis("aaa", result.analysis).newContent).toBe("Xa");
	});

	it("supports NFKC fuzzy matching", () => {
		const result = analyzeEdits("name = Ａ\n", [{ oldText: "name = A", newText: "name = B" }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(applyAnalysis("name = Ａ\n", result.analysis).newContent).toBe("name = B\n");
	});

	it("rejects overlapping edits with line ranges", () => {
		const file = "aaaa\nbbbb\ncccc\n";
		const result = analyzeEdits(file, [
			{ oldText: "aaaa\nbbbb", newText: "x" },
			{ oldText: "bbbb\ncccc", newText: "y" },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok && result.failure.kind === "overlap") {
			expect(result.failure.firstEditIndex).toBe(0);
			expect(result.failure.secondEditIndex).toBe(1);
			expect(result.failure.firstRange).toEqual({ start: 1, end: 2 });
			expect(result.failure.secondRange).toEqual({ start: 2, end: 3 });
		} else if (result.ok) {
			expect.unreachable("expected overlap failure");
		}
	});

	it("matches all edits against the original content, not incrementally", () => {
		const file = "a\nb\n";
		const result = analyzeEdits(file, [
			{ oldText: "a", newText: "aa" },
			{ oldText: "b", newText: "bb" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const { newContent } = applyAnalysis(file, result.analysis);
			expect(newContent).toBe("aa\nbb\n");
		}
	});
});

describe("applyAnalysis", () => {
	it("applies multiple disjoint edits", () => {
		const file = "fn a() {}\nfn b() {}\n";
		const result = analyzeEdits(file, [
			{ oldText: "fn a() {}", newText: "function a() {}" },
			{ oldText: "fn b() {}", newText: "function b() {}" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const { baseContent, newContent } = applyAnalysis(file, result.analysis);
			expect(baseContent).toBe(file);
			expect(newContent).toBe("function a() {}\nfunction b() {}\n");
		}
	});

	it("detects no-change results", () => {
		const file = "same\n";
		const result = analyzeEdits(file, [{ oldText: "same", newText: "same" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const { baseContent, newContent } = applyAnalysis(file, result.analysis);
			expect(newContent).toBe(baseContent);
		}
	});

	it("preserves untouched line bytes when the fuzzy path is used", () => {
		// The matched region has trailing whitespace; the untouched tab line keeps its bytes.
		const file = "x   \nkeep me exactly\ny\t\n";
		const result = analyzeEdits(file, [{ oldText: "x\nkeep me exactly", newText: "renamed\nkeep me exactly" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.analysis.usedFuzzyMatch).toBe(true);
			const { newContent } = applyAnalysis(file, result.analysis);
			expect(newContent).toBe("renamed\nkeep me exactly\ny\t\n");
		}
	});

	it("preserves an untouched whitespace-only final unterminated line", () => {
		const file = "value   \nnext\n   ";
		const result = analyzeEdits(file, [{ oldText: "value\nnext", newText: "renamed\nn" }]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			const { newContent } = applyAnalysis(file, result.analysis);
			expect(newContent).toBe("renamed\nn\n   ");
		}
	});
});

describe("analyzeEdits CRLF normalization", () => {
	it("normalizes oldText line endings before matching", () => {
		const file = "alpha\r\nbeta\r\n";
		const normalized = file.replace(/\r\n/g, "\n");
		const result = analyzeEdits(normalized, [{ oldText: "alpha\r\nbeta", newText: "x" }] as EditOp[]);
		expect(result.ok).toBe(true);
	});
});

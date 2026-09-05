import { describe, expect, it } from "vitest";
import {
	fenceFor,
	findMinimalUniqueExpansion,
	formatAutoDisambiguationSuccess,
	formatEditFailure,
} from "../src/diagnostics.ts";
import type { EditOp } from "../src/apply.ts";
import { analyzeEdits } from "../src/apply.ts";
import { findClosestRegion, lineSimilarity, probeMatchCauses } from "../src/similarity.ts";
import { getLineSpans, normalizeForFuzzyMatch } from "../src/text.ts";

function expansionFor(content: string, oldText: string) {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const spans = getLineSpans(content);
	const idx = fuzzyContent.indexOf(normalizeForFuzzyMatch(oldText));
	if (idx === -1) return null;
	const fuzzySpans = getLineSpans(fuzzyContent);
	// compute range of this single occurrence
	let start = 1;
	for (let i = 0; i < fuzzySpans.length; i++) {
		if (idx >= fuzzySpans[i].start && idx < fuzzySpans[i].end) {
			start = i + 1;
			break;
		}
	}
	const endOff = idx + normalizeForFuzzyMatch(oldText).length - 1;
	let end = start;
	for (let i = 0; i < fuzzySpans.length; i++) {
		if (endOff >= fuzzySpans[i].start && endOff < fuzzySpans[i].end) {
			end = i + 1;
			break;
		}
	}
	return findMinimalUniqueExpansion(content, fuzzyContent, spans, { start, end });
}

describe("lineSimilarity", () => {
	it("scores identical strings 1 and unrelated strings low", () => {
		expect(lineSimilarity("const x = 1", "const x = 1")).toBe(1);
		expect(lineSimilarity("const x = 1", "def y(): pass")).toBeLessThan(0.15);
	});

	it("scores near-identical strings high", () => {
		expect(lineSimilarity("\tindentWithTab()", "    indentWithTab()")).toBeGreaterThan(0.7);
		expect(lineSimilarity("foo(bar)", "foo (bar)")).toBeGreaterThan(0.7);
	});
});

describe("findClosestRegion", () => {
	it("locates a region that differs only by indentation", () => {
		const file = "package main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n";
		const oldText = "func main() {\n    fmt.Println(\"hi\")\n}";
		const region = findClosestRegion(file, oldText);
		expect(region).not.toBeNull();
		expect(region?.startLine).toBe(3);
		expect(region?.endLine).toBe(5);
		expect(region?.score).toBeGreaterThan(0.8);
	});

	it("locates a region when a line is missing from oldText", () => {
		const file = "a\nb\nc\nd\ne\n";
		const oldText = "a\nb\nd\ne";
		const region = findClosestRegion(file, oldText);
		expect(region).not.toBeNull();
		expect(region?.startLine).toBe(1);
		expect(region?.ops.some((op) => op.type === "file-only" && op.fileLine === 3)).toBe(true);
	});

	it("returns null when nothing is similar", () => {
		expect(findClosestRegion("1\n2\n3\n", "zzzzzzzz\nyyyyyyyy\n")).toBeNull();
	});

	it("does not let repeated query lines reuse one file line", () => {
		const region = findClosestRegion("needle\nx\ny\n", "needle\nneedle\nneedle");
		expect(region).not.toBeNull();
		expect(region!.score).toBeLessThan(0.5);
		expect(region!.equalCount).toBe(1);
	});

	it("keeps a moderately large search within a bounded runtime", () => {
		const file = Array.from({ length: 1_000 }, (_, i) => `const value_${i % 10} = ${i % 7};`).join("\n");
		const query = Array.from({ length: 100 }, (_, i) => `const value_${i % 10} = ${i % 7}; // drift`).join("\n");
		const started = performance.now();
		expect(findClosestRegion(file, query)).not.toBeNull();
		// Generous enough for slow CI, but catches the previous O(N*L^2)
		// implementation, which took over a minute for this fixture.
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("fails closed under query and per-line work limits", () => {
		const started = performance.now();
		expect(findClosestRegion(`${"a".repeat(20_000)}X`, `${"a".repeat(20_000)}Y`)).toBeNull();
		expect(findClosestRegion("short\n", "q".repeat(140 * 1024))).toBeNull();
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});

describe("probeMatchCauses", () => {
	it("detects whitespace-only differences", () => {
		const causes = probeMatchCauses("foo   bar\n", "foo bar");
		expect(causes.some((c) => c.includes("whitespace"))).toBe(true);
	});

	it("detects case differences", () => {
		const causes = probeMatchCauses("Hello World\n", "hello world");
		expect(causes.some((c) => c.includes("case"))).toBe(true);
	});
});

describe("findMinimalUniqueExpansion", () => {
	it("expands by the minimum whole-line prefix/suffix that restores uniqueness", () => {
		const file = "start\ncommon\nA\ntarget\ncommon\nB\nend\n";
		// "common" occurs twice; occurrence 1 is on line 2
		const content = file;
		const fuzzyContent = normalizeForFuzzyMatch(content);
		const spans = getLineSpans(content);
		const exp = findMinimalUniqueExpansion(content, fuzzyContent, spans, { start: 2, end: 2 });
		expect(exp).not.toBeNull();
		// including line 3 (A) after, or line 1 (start) before disambiguates
		expect([exp?.prefixLines, exp?.suffixLines]).toEqual([0, 1]);
		expect(exp?.text).toBe("common\nA");
		// the snippet must actually be unique in fuzzy space
		expect(fuzzyContent.split(normalizeForFuzzyMatch(exp!.text)).length - 1).toBe(1);
	});

	it("produces a retryable snippet for same-line duplicates", () => {
		const file = "result = compute(x) + compute(y)\n";
		const exp = expansionFor(file, "compute(");
		// "compute(" occurs twice on line 1: the snippet is the full unique line
		expect(exp).not.toBeNull();
		const fuzzy = normalizeForFuzzyMatch(file);
		expect(fuzzy.split(normalizeForFuzzyMatch(exp!.text)).length - 1).toBe(1);
		expect(exp!.text).toContain("compute(");
		expect(exp!.startLine).toBe(1);
		expect(exp!.endLine).toBe(1);
	});

	it("returns null when the region cannot be disambiguated within the context budget", () => {
		const block = Array.from({ length: 15 }, (_, i) => `same ${i}`).join("\n");
		const file = `${block}\n${block}\n`;
		const exp = expansionFor(file, "same 1");
		expect(exp).toBeNull();
	});

	it("handles the first/last line edge cases without going out of bounds", () => {
		const file = "dup\nx\ndup\n";
		const fuzzyContent = normalizeForFuzzyMatch(file);
		const spans = getLineSpans(file);
		const first = findMinimalUniqueExpansion(file, fuzzyContent, spans, { start: 1, end: 1 });
		expect(first?.text).toBe("dup\nx");
		const second = findMinimalUniqueExpansion(file, fuzzyContent, spans, { start: 3, end: 3 });
		expect(second?.text).toBe("x\ndup");
	});
});

describe("fenceFor", () => {
	it("uses a longer fence when the snippet contains backtick runs", () => {
		expect(fenceFor("plain text")).toBe("```");
		expect(fenceFor("code with ``` inside")).toBe("````");
		expect(fenceFor("``````")).toBe("```````");
	});
});

describe("formatEditFailure", () => {
	const file = "func a() {\n\tcall()\n}\n\nfunc b() {\n\tcall()\n}\n";
	const edits: EditOp[] = [{ oldText: "\tcall()\n}", newText: "x" }];

	it("renders ambiguity with occurrence lines and snippets", () => {
		const result = analyzeEdits(file, edits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({
				path: "sample.go",
				normalizedContent: file,
				edits,
				failure: result.failure,
			});
			expect(message).toContain("Found 2 occurrences");
			expect(message).toContain("lines 2-3");
			expect(message).toContain("lines 6-7");
			expect(message).toContain("Occurrence 1");
			expect(message).toContain("minimum context:");
			expect(message).toContain("No changes were written");
		}
	});

	it("renders not-found with closest region and exact bytes", () => {
		const badEdits: EditOp[] = [{ oldText: "func a() {\n    call()\n}", newText: "x" }];
		const result = analyzeEdits(file, badEdits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({
				path: "sample.go",
				normalizedContent: file,
				edits: badEdits,
				failure: result.failure,
			});
			expect(message).toContain("Could not find the exact text");
			expect(message).toContain("Closest match in the file: lines 1-3");
			expect(message).toContain("Candidate file content at lines 1-3");
			expect(message).toContain("distinct candidate at lines 5-7");
			expect(message).toContain("func a() {");
		}
	});

	it("does not call a non-unique closest candidate directly retryable", () => {
		const badEdits: EditOp[] = [{ oldText: "fop", newText: "x" }];
		const content = "foo\nfoo\n";
		const result = analyzeEdits(content, badEdits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({ path: "sample.txt", normalizedContent: content, edits: badEdits, failure: result.failure });
			expect(message).toContain("not safe for a direct retry");
			expect(message).toContain("not unique");
		}
	});

	it("omits oversized ambiguous snippets instead of truncating copyable text", () => {
		const block = Array.from({ length: 61 }, (_, i) => `shared ${i}`).join("\n");
		const content = `${block}\nfirst marker\n${block}\nsecond marker\n`;
		const edits: EditOp[] = [{ oldText: block, newText: "replacement" }];
		const result = analyzeEdits(content, edits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({ path: "large-block.txt", normalizedContent: content, edits, failure: result.failure });
			expect(message).toContain("Exact unique snippet omitted");
			expect(message).not.toContain("middle lines snipped");
		}
	});

	it("hard-bounds the complete diagnostic even when metadata contains a huge line", () => {
		const message = formatEditFailure({
			path: "p".repeat(100_000),
			normalizedContent: "x",
			edits: [{ oldText: "", newText: "x" }],
			failure: { kind: "empty-old-text", editIndex: 0 },
		});
		expect(Buffer.byteLength(message, "utf8")).toBeLessThan(50 * 1024);
		expect(message).toContain("Diagnostic output was bounded");
	});

	it("bounds huge single-line snippets below pi's output limit", () => {
		const content = `${"a".repeat(20_000)}X\n`;
		const badEdits: EditOp[] = [{ oldText: `${"a".repeat(20_000)}Y`, newText: "x" }];
		const result = analyzeEdits(content, badEdits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({ path: "huge.txt", normalizedContent: content, edits: badEdits, failure: result.failure });
			expect(Buffer.byteLength(message, "utf8")).toBeLessThan(50 * 1024);
			expect(message).toContain("No reliable similar region was found within the bounded diagnostic search");
		}
	});

	it("requires verification when a distinct candidate has an equal score", () => {
		const content = "const target = chooseA;\nseparator\nconst target = chooseB;\n";
		const badEdits: EditOp[] = [{ oldText: "const target = chooseC;", newText: "x" }];
		const result = analyzeEdits(content, badEdits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({ path: "tie.ts", normalizedContent: content, edits: badEdits, failure: result.failure });
			expect(message).toContain("distinct candidate");
			expect(message).toContain("not safe for a direct retry");
			expect(message).not.toContain("Exact file content at");
		}
	});

	it("renders comparisons from original text rather than fuzzy-normalized text", () => {
		const content = "const label = “smart”;  \n";
		const badEdits: EditOp[] = [{ oldText: "const label = \"smert\";", newText: "x" }];
		const result = analyzeEdits(content, badEdits);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const message = formatEditFailure({ path: "unicode.ts", normalizedContent: content, edits: badEdits, failure: result.failure });
			expect(message).toContain("“smart”");
			expect(message).toContain("··");
			expect(message).toContain("\"smert\"");
		}
	});

	it("bounds complete success output without cutting Markdown fences", () => {
		const ticks = "`".repeat(2_480);
		const content = Array.from({ length: 5 }, (_, index) => `${ticks}TARGET-${index}`).join("\n");
		const resolutions = Array.from({ length: 4 }, (_, editIndex) => ({
			editIndex,
			oldText: "TARGET",
			chosenRange: { start: 1, end: 1 },
			readRange: { start: 1, end: 1 },
		}));
		const message = formatAutoDisambiguationSuccess("ok", content, resolutions);
		expect(Buffer.byteLength(message, "utf8")).toBeLessThan(50 * 1024);
		const fenceLines = message.split("\n").filter((line) => /^`{3,}$/.test(line));
		expect(fenceLines.length % 2).toBe(0);
		expect(message).toContain("Diagnostic output was bounded");
	});

	it("renders overlap with line ranges", () => {
		const overlapEdits: EditOp[] = [
			{ oldText: "func a() {\n\tcall()", newText: "x" },
			{ oldText: "\tcall()\n}", newText: "y" },
		];
		const result = analyzeEdits(file, overlapEdits);
		expect(result.ok).toBe(false);
		if (!result.ok && result.failure.kind === "overlap") {
			const message = formatEditFailure({
				path: "sample.go",
				normalizedContent: file,
				edits: overlapEdits,
				failure: result.failure,
			});
			expect(message).toContain("overlap");
			expect(message).toMatch(/lines \d+-\d+/);
		}
	});
});

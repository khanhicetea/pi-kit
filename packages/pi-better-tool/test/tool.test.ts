import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeBetterEdit, prepareEditArguments, type BetterEditInput } from "../src/tool.ts";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-better-tool-"));
});

afterEach(async () => {
	await import("node:fs/promises").then((fs) => fs.rm(cwd, { recursive: true, force: true }));
});

async function setup(name: string, content: string): Promise<{ name: string; path: string }> {
	const path = join(cwd, name);
	await writeFile(path, content, "utf-8");
	return { name, path };
}

async function read(path: string): Promise<string> {
	return readFile(path, "utf-8");
}

function run(path: string, edits: Array<{ oldText: string; newText: string }>) {
	return executeBetterEdit({ path, edits }, undefined, { cwd });
}

/** Extract the first fenced snippet from an error message. */
function firstSnippet(message: string): string {
	const match = message.match(/(`{3,})\n([\s\S]*?)\n\1/);
	if (!match) throw new Error(`no snippet found in message:\n${message}`);
	return match[2];
}

describe("executeBetterEdit happy path", () => {
	it("applies an exact unique edit and returns built-in-compatible details", async () => {
		const { name, path } = await setup("ok.txt", "alpha\nbeta\ngamma\n");
		const result = await run(name, [{ oldText: "beta", newText: "BETA" }]);
		expect(result.content[0]?.text).toBe(`Successfully replaced 1 block(s) in ${name}.`);
		expect(await read(path)).toBe("alpha\nBETA\ngamma\n");
		expect(typeof result.details.diff).toBe("string");
		expect(result.details.diff).toContain("BETA");
		expect(result.details.patch).toContain(`--- ${name}`);
		expect(typeof result.details.firstChangedLine).toBe("number");
	});

	it("applies multiple disjoint edits in one call", async () => {
		const { name, path } = await setup("multi.txt", "one\ntwo\nthree\n");
		await run(name, [
			{ oldText: "one", newText: "1" },
			{ oldText: "three", newText: "3" },
		]);
		expect(await read(path)).toBe("1\ntwo\n3\n");
	});

	it("preserves CRLF line endings", async () => {
		const { name, path } = await setup("crlf.txt", "alpha\r\nbeta\r\n");
		await run(name, [{ oldText: "beta", newText: "BETA" }]);
		expect(await read(path)).toBe("alpha\r\nBETA\r\n");
	});

	it("preserves a UTF-8 BOM", async () => {
		const { name, path } = await setup("bom.txt", "﻿alpha\n");
		await run(name, [{ oldText: "alpha", newText: "beta" }]);
		expect(await read(path)).toBe("﻿beta\n");
	});

	it("falls back to fuzzy matching for trailing whitespace differences", async () => {
		const { name, path } = await setup("fuzzy.txt", "value   \nnext\n");
		await run(name, [{ oldText: "value\nnext", newText: "renamed\nn" }]);
		expect(await read(path)).toBe("renamed\nn\n");
	});

	it("normalizes model-style @ prefixes and Unicode spaces in paths", async () => {
		const { path } = await setup("space name.txt", "before\n");
		await run("@space\u00a0name.txt", [{ oldText: "before", newText: "after" }]);
		expect(await read(path)).toBe("after\n");
	});

	it("accepts file URLs like pi's built-in path resolver", async () => {
		const { path } = await setup("url.txt", "before\n");
		await run(pathToFileURL(path).href, [{ oldText: "before", newText: "after" }]);
		expect(await read(path)).toBe("after\n");
	});
});

describe("built-in happy-path parity", () => {
	it("produces the same file bytes for exact, multi, and fuzzy replacements", async () => {
		const cases = [
			{ body: "alpha\nbeta\ngamma\n", edits: [{ oldText: "beta", newText: "BETA" }] },
			{ body: "one\ntwo\nthree\n", edits: [{ oldText: "one", newText: "1" }, { oldText: "three", newText: "3" }] },
			{ body: "value   \nnext\n", edits: [{ oldText: "value\nnext", newText: "renamed\nn" }] },
		];
		for (const [index, fixture] of cases.entries()) {
			const better = await setup(`better-${index}.txt`, fixture.body);
			const builtin = await setup(`builtin-${index}.txt`, fixture.body);
			await run(better.name, fixture.edits);
			const builtinTool = createEditToolDefinition(cwd);
			await builtinTool.execute("parity", { path: builtin.name, edits: fixture.edits }, undefined, undefined, {} as never);
			expect(await read(better.path)).toBe(await read(builtin.path));
		}
	});
});

describe("executeBetterEdit failures", () => {
	it("fails on a missing file like the built-in tool", async () => {
		await expect(run("nope.txt", [{ oldText: "a", newText: "b" }])).rejects.toThrow(
			/Could not edit file: nope\.txt\. Error code: ENOENT\./,
		);
	});

	it("rejects empty oldText", async () => {
		const { name, path } = await setup("empty.txt", "content\n");
		await expect(run(name, [{ oldText: "", newText: "x" }])).rejects.toThrow(/oldText must not be empty/);
		expect(await read(path)).toBe("content\n");
	});

	it("rejects a no-change edit", async () => {
		const { name } = await setup("same.txt", "same\n");
		await expect(run(name, [{ oldText: "same", newText: "same" }])).rejects.toThrow(/No changes made/);
	});

	it("is atomic: no partial writes when a later edit fails", async () => {
		const { name, path } = await setup("atomic.txt", "aaa\nbbb\n");
		await expect(
			run(name, [
				{ oldText: "aaa", newText: "xxx" },
				{ oldText: "zzz", newText: "yyy" },
			]),
		).rejects.toThrow(/Could not find edits\[1\]/);
		expect(await read(path)).toBe("aaa\nbbb\n");
	});
});

describe("ambiguity recovery round-trip", () => {
	const fileBody = "func first() {\n\tlog()\n}\n\nfunc second() {\n\tlog()\n}\n";

	it("lists occurrences with snippets; retrying with the snippet succeeds", async () => {
		const { name, path } = await setup("dup.go", fileBody);
		const err = await run(name, [{ oldText: "\tlog()\n}", newText: "\tchanged()\n}" }]).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;

		expect(message).toContain("Found 2 occurrences");
		expect(message).toContain("lines 2-3");
		expect(message).toContain("lines 6-7");
		expect(message).toContain("Occurrence 1");
		expect(message).toContain("minimum context:");
		// file untouched
		expect(await read(path)).toBe(fileBody);

		// The model's next move: retry with the suggested snippet (no re-read).
		const snippet = firstSnippet(message);
		const result = await run(name, [{ oldText: snippet, newText: snippet.replace("log()", "changed()") }]);
		expect(result.content[0]?.text).toContain("Successfully replaced");
		expect(await read(path)).toContain("changed()");
	});

	it("handles same-line duplicates with a unique whole-line snippet", async () => {
		const { name, path } = await setup("sameline.txt", "total = price(x) + price(y)\n");
		const err = await run(name, [{ oldText: "price(", newText: "cost(" }]).catch((e: Error) => e);
		const message = (err as Error).message;
		expect(message).toContain("Found 2 occurrences");

		const snippet = firstSnippet(message);
		const result = await run(name, [{ oldText: snippet, newText: snippet.replace("price(", "cost(") }]);
		expect(result.content[0]?.text).toContain("Successfully replaced");
		expect(await read(path)).toMatch(/^total = cost\(x\) \+ price\(y\)|^total = price\(x\) \+ cost\(y\)/);
	});
});

describe("not-found recovery round-trip", () => {
	it("shows the closest region and exact bytes; retrying with them succeeds", async () => {
		const body = "package main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n";
		const { name, path } = await setup("tabs.go", body);
		// model guesses spaces instead of the file's tab
		const err = await run(name, [
			{ oldText: 'func main() {\n    fmt.Println("hi")\n}', newText: "func main() {\n\tfmt.Println(\"bye\")\n}" },
		]).catch((e: Error) => e);
		const message = (err as Error).message;

		expect(message).toContain("Could not find the exact text");
		expect(message).toContain("Closest match in the file: lines 3-5");
		expect(message).toContain("tabs vs spaces");
		expect(message).toContain("Exact file content at lines 3-5");
		expect(await read(path)).toBe(body);

		// Retry using the exact bytes from the message.
		const snippet = firstSnippet(message);
		const result = await run(name, [
			{ oldText: snippet, newText: snippet.replace('"hi"', '"bye"') },
		]);
		expect(result.content[0]?.text).toContain("Successfully replaced");
		expect(await read(path)).toContain('"bye"');
	});

	it("reports a missing line vs the file", async () => {
		const body = "a\nb\nc\nd\ne\n";
		const { name } = await setup("missing.txt", body);
		const err = await run(name, [{ oldText: "a\nb\nd\ne", newText: "x" }]).catch((e: Error) => e);
		const message = (err as Error).message;
		expect(message).toContain("missing from your oldText");
	});
});

describe("prepareEditArguments compatibility shim", () => {
	it("parses edits sent as a JSON string", () => {
		const out = prepareEditArguments({ path: "f", edits: '[{"oldText":"a","newText":"b"}]' }) as BetterEditInput;
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("wraps a single edit object", () => {
		const out = prepareEditArguments({ path: "f", edits: { oldText: "a", newText: "b" } }) as BetterEditInput;
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("folds legacy top-level oldText/newText into edits", () => {
		const out = prepareEditArguments({ path: "f", oldText: "a", newText: "b" }) as BetterEditInput;
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
		expect("oldText" in out).toBe(false);
	});

	it("keeps invalid JSON untouched for schema validation", () => {
		const out = prepareEditArguments({ path: "f", edits: "not json" });
		expect(out).toEqual({ path: "f", edits: "not json" });
	});
});

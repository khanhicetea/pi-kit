import { access, link, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	executeBetterEdit,
	prepareEditArguments,
	type BetterEditInput,
	type BetterEditOperations,
} from "../src/tool.ts";

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

function run(
	path: string,
	edits: Array<{ oldText: string; newText: string }>,
	sessionManager?: { buildContextEntries(): any[] },
) {
	return executeBetterEdit({ path, edits }, undefined, { cwd, sessionManager: sessionManager as never });
}

function localOperations(overrides: Partial<BetterEditOperations> = {}): BetterEditOperations {
	return {
		access,
		readFile: (path) => readFile(path),
		realpath,
		stat,
		writeFile: (path, content) => writeFile(path, content, "utf8"),
		...overrides,
	};
}

function sessionWithRead(
	path: string,
	output: string,
	options: { offset?: number; limit?: number; isError?: boolean } = {},
) {
	const toolCallId = "read-call";
	return {
		buildContextEntries: () => [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path, offset: options.offset, limit: options.limit } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: output }],
					isError: options.isError ?? false,
				},
			},
		],
	};
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
			{ body: "name = Ａ\n", edits: [{ oldText: "name = A", newText: "name = B" }] },
			{ body: "no terminal newline", edits: [{ oldText: "newline", newText: "NEWLINE" }] },
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
			/Could not access file for editing: nope\.txt\. Error code: ENOENT\. No write was started\./,
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

describe("commit boundary and filesystem failures", () => {
	it("does not start work when already aborted", async () => {
		const { name, path } = await setup("abort-before-read.txt", "before\n");
		const controller = new AbortController();
		controller.abort();
		await expect(executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			controller.signal,
			{ cwd },
		)).rejects.toThrow(/before the edit was committed; no write was started/);
		expect(await read(path)).toBe("before\n");
	});

	it("does not write when success formatting fails", async () => {
		const { name, path } = await setup("format-failure.txt", "before\n");
		await expect(executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			{ cwd },
			{ operations: localOperations(), formatSuccess: () => { throw new Error("formatter failed"); } },
		)).rejects.toThrow("formatter failed");
		expect(await read(path)).toBe("before\n");
	});

	it("reports success when cancellation arrives during a resolved write", async () => {
		const { name, path } = await setup("abort-during-write.txt", "before\n");
		const controller = new AbortController();
		const base = localOperations();
		const result = await executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			controller.signal,
			{ cwd },
			{ operations: localOperations({
				writeFile: async (target, content) => {
					await base.writeFile(target, content);
					controller.abort();
				},
			}) },
		);
		expect(result.content[0]?.text).toContain("Successfully replaced");
		expect(await read(path)).toBe("after\n");
	});

	it("stops before writing when cancellation arrives during pre-commit revalidation", async () => {
		const { name, path } = await setup("abort-before-write.txt", "before\n");
		const controller = new AbortController();
		const base = localOperations();
		let reads = 0;
		await expect(executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			controller.signal,
			{ cwd },
			{ operations: localOperations({
				readFile: async (target) => {
					const content = await base.readFile(target);
					reads++;
					if (reads === 2) controller.abort();
					return content;
				},
			}) },
		)).rejects.toThrow(/no write was started/);
		expect(await read(path)).toBe("before\n");
	});

	it("reports an indeterminate commit when write rejects after changing bytes", async () => {
		const { name, path } = await setup("write-rejection.txt", "before\n");
		const base = localOperations();
		await expect(executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			{ cwd },
			{ operations: localOperations({
				writeFile: async (target, content) => {
					await base.writeFile(target, content);
					throw Object.assign(new Error("late failure"), { code: "EIO" });
				},
			}) },
		)).rejects.toThrow(/may be unchanged, partially written, or fully written/);
		expect(await read(path)).toBe("after\n");
	});

	it("detects an external modification before starting its write", async () => {
		const { name, path } = await setup("external.txt", "before\n");
		const base = localOperations();
		let reads = 0;
		await expect(executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "after" }] },
			undefined,
			{ cwd },
			{ operations: localOperations({
				readFile: async (target) => {
					reads++;
					if (reads === 2) await base.writeFile(target, "external\n");
					return base.readFile(target);
				},
			}) },
		)).rejects.toThrow(/target changed after it was read; no write was started/);
		expect(await read(path)).toBe("external\n");
	});

	it("releases the queue after a failed write so a later edit can run", async () => {
		const { name, path } = await setup("queue.txt", "before\n");
		const first = executeBetterEdit(
			{ path: name, edits: [{ oldText: "before", newText: "broken" }] },
			undefined,
			{ cwd },
			{ operations: localOperations({ writeFile: async () => { throw new Error("injected"); } }) },
		);
		const second = run(name, [{ oldText: "before", newText: "after" }]);
		const [firstResult, secondResult] = await Promise.allSettled([first, second]);
		expect(firstResult.status).toBe("rejected");
		expect(secondResult.status).toBe("fulfilled");
		expect(await read(path)).toBe("after\n");
	});

	it.skipIf(process.platform === "win32")("preserves symlink identity by writing through it", async () => {
		const { path } = await setup("target.txt", "before\n");
		const alias = join(cwd, "alias.txt");
		await symlink(path, alias);
		await run("alias.txt", [{ oldText: "before", newText: "after" }]);
		expect(await realpath(alias)).toBe(await realpath(path));
		expect(await read(path)).toBe("after\n");
	});

	it("preserves hard-link semantics by writing the existing inode", async () => {
		const { path } = await setup("hard-target.txt", "before\n");
		const alias = join(cwd, "hard-alias.txt");
		await link(path, alias);
		await run("hard-alias.txt", [{ oldText: "before", newText: "after" }]);
		expect(await read(path)).toBe("after\n");
		expect((await stat(path)).ino).toBe((await stat(alias)).ino);
	});
});

describe("encoding safety", () => {
	it("edits valid non-ASCII UTF-8", async () => {
		const { name, path } = await setup("unicode.txt", "café 東京\n");
		await run(name, [{ oldText: "café", newText: "CAFÉ" }]);
		expect(await read(path)).toBe("CAFÉ 東京\n");
	});

	it("rejects invalid UTF-8 without changing any bytes", async () => {
		const { name, path } = await setup("invalid.bin", "placeholder");
		const original = Buffer.from([0x61, 0x62, 0x63, 0x0a, 0xff, 0xfe, 0x0a]);
		await writeFile(path, original);
		await expect(run(name, [{ oldText: "abc", newText: "ABC" }])).rejects.toThrow(/not valid UTF-8/);
		expect(await readFile(path)).toEqual(original);
	});

	it("rejects NUL-containing input without changing any bytes", async () => {
		const { name, path } = await setup("nul.bin", "placeholder");
		const original = Buffer.from("abc\0def", "utf8");
		await writeFile(path, original);
		await expect(run(name, [{ oldText: "abc", newText: "ABC" }])).rejects.toThrow(/contains NUL bytes/);
		expect(await readFile(path)).toEqual(original);
	});
});

describe("read-based ambiguity resolution", () => {
	const body = "func first() {\n\tlog()\n}\n\nfunc second() {\n\tlog()\n}";

	it("edits the only occurrence fully contained in the latest verified read", async () => {
		const { name, path } = await setup("read-target.go", body);
		const session = sessionWithRead(name, "func second() {\n\tlog()\n}", { offset: 5, limit: 3 });
		const result = await run(name, [{ oldText: "\tlog()\n}", newText: "\tchanged()\n}" }], session);

		expect(await read(path)).toBe("func first() {\n\tlog()\n}\n\nfunc second() {\n\tchanged()\n}");
		expect(result.content[0]?.text).toContain("Auto-disambiguated edits[0] to lines 6-7");
		expect(result.content[0]?.text).toContain("latest verified read of lines 5-7");
		expect(result.content[0]?.text).toContain("Remaining exact occurrences");
		expect(result.content[0]?.text).toContain("effective context:");
		expect(result.content[0]?.text).toContain("Use one fenced snippet byte-for-byte as oldText");
	});

	it("shows fewer than five remaining occurrences and reports additional ones as omitted", async () => {
		const many = Array.from({ length: 6 }, (_, i) => `marker ${i + 1}\ndup`).join("\n");
		const { name } = await setup("many.txt", many);
		const session = sessionWithRead(name, "marker 3\ndup\n\n[6 more lines in file. Use offset=7 to continue.]", { offset: 5, limit: 2 });
		const result = await run(name, [{ oldText: "dup", newText: "changed" }], session);
		const message = result.content[0]?.text ?? "";
		expect(message).toContain("4 shown, 1 more omitted");
		expect(message.match(/effective context:/g)).toHaveLength(4);
	});

	it("keeps refusing when the latest read contains multiple occurrences", async () => {
		const { name, path } = await setup("read-all.go", body);
		const session = sessionWithRead(name, body);
		await expect(run(name, [{ oldText: "\tlog()\n}", newText: "x" }], session)).rejects.toThrow(
			/Found 2 occurrences/,
		);
		expect(await read(path)).toBe(body);
	});

	it("keeps refusing when the stored read output no longer matches the file", async () => {
		const { name, path } = await setup("stale-read.go", body);
		const session = sessionWithRead(name, "func old() {\n\tlog()\n}", { offset: 5, limit: 3 });
		await expect(run(name, [{ oldText: "\tlog()\n}", newText: "x" }], session)).rejects.toThrow(
			/Found 2 occurrences/,
		);
		expect(await read(path)).toBe(body);
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

	it("does not mutate input and is idempotent", () => {
		const input = { path: "f", edits: { oldText: "a", newText: "b" } };
		const first = prepareEditArguments(input) as BetterEditInput;
		const second = prepareEditArguments(first);
		expect(input.edits).toEqual({ oldText: "a", newText: "b" });
		expect(second).toEqual(first);
	});
});

import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSymbolRead, executeReadSymbol, validateReadSymbolInput, type ReadSymbolInput, type ReadSymbolResult } from "../src/read-symbol.ts";
import { executeBetterEdit } from "../src/tool.ts";
import { findLatestReadEvidence } from "../src/read-evidence.ts";
import { indexSymbols } from "../src/symbols.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "pi-read-symbol-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const text = (result: ReadSymbolResult) => result.content[0].text;
const source = "export function first() {\n  log();\n}\n\nexport function second() {\n  log();\n}\n";
async function setup(path = "sample.ts", content = source) { await writeFile(join(cwd, path), content); return path; }
function run(input: ReadSymbolInput) { return executeReadSymbol(input, undefined, { cwd }); }
function session(input: ReadSymbolInput, result: ReadSymbolResult, toolName = "read_symbol") {
	return { buildContextEntries: () => [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: toolName, arguments: input }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "read-1", toolName, isError: false, content: result.content } },
	] } as unknown as ExtensionContext["sessionManager"];
}

describe("syntax-backed symbols", () => {
	it.each([
		["sample.ts", "export async function work(x: string) {\n  return `brace } ${x}`;\n}\n", "work", 1, 3],
		["sample.tsx", "export const Widget = () => {\n  return <div>{'}'}</div>;\n};\n", "Widget", 1, 3],
		["sample.jsx", "export const Widget = () => <div/>;\n", "Widget", 1, 1],
		["sample.mjs", "export function work() {\n  return /[{}]/.test('}');\n}\n", "work", 1, 3],
		["sample.py", "@cache\nasync def work(x):\n    value = '''} def fake():\ntext'''\n    return x\n", "work", 1, 5],
		["sample.go", "package main\nfunc work() {\n  println(`}`)\n}\n", "work", 2, 4],
		["sample.rs", "#[inline]\npub fn work() {\n  println!(\"}\");\n}\n", "work", 1, 4],
		["sample.sh", "function work() {\n  printf '}\\n'\n}\n", "work", 1, 3],
		["sample.c", "int work(void) {\n  return 0;\n}\n", "work", 1, 3],
		["sample.cpp", "int work() {\n  return 0;\n}\n", "work", 1, 3],
		["sample.cs", "class Server {\n  void work() {}\n}\n", "work", 2, 2],
		["sample.java", "class Server {\n  void work() {}\n}\n", "work", 2, 2],
		["sample.kt", "fun work() {\n  return\n}\n", "work", 1, 3],
		["sample.php", "<?php\nfunction work() {\n  return;\n}\n", "work", 2, 4],
		["sample.rb", "def work\n  1\nend\n", "work", 1, 3],
		["sample.swift", "func work() {\n  return\n}\n", "work", 1, 3],
	] as const)("reads complete declaration in %s", async (path, content, symbol, startLine, endLine) => {
		const result = await buildSymbolRead({ path, symbol }, content);
		expect(result.details.symbol).toMatchObject({ name: symbol, startLine, endLine });
		expect(result.details.complete).toBe(true);
		expect(text(result)).toContain(content.split("\n").slice(startLine - 1, endLine).join("\n"));
	});

	it("chooses an inner method and can expand to its class", async () => {
		const content = "class Server {\n  run() {\n    return 1;\n  }\n}\n";
		const method = await buildSymbolRead({ path: "a.ts", line: 3 }, content);
		expect(method.details.symbol?.qualifiedName).toBe("Server.run");
		expect(text(method)).toContain("Enclosing: \"Server\"");
		const parent = await buildSymbolRead({ path: "a.ts", line: 3, parent: 1 }, content);
		expect(parent.details.symbol?.name).toBe("Server");
		await expect(buildSymbolRead({ path: "a.ts", line: 3, parent: 2 }, content)).rejects.toThrow("No enclosing symbol");
	});

	it("supports qualified method names across languages", async () => {
		for (const [path, content, name] of [
			["a.py", "class Server:\n    def run(self):\n        pass\n", "Server.run"],
			["a.go", "package main\nfunc (s *Server) Run() {\n}\n", "Server.Run"],
			["a.rs", "impl Server {\n    pub fn run(&self) {}\n}\n", "Server.run"],
			["a.cpp", "namespace app {\nclass Server { public: void run() {} };\n}\n", "app.Server.run"],
			["a.cs", "namespace App { class Server { void Run() {} } }\n", "App.Server.Run"],
			["a.java", "class Server { void run() {} }\n", "Server.run"],
			["a.kt", "class Server { fun run() {} }\n", "Server.run"],
			["a.php", "<?php class Server { function run() {} }\n", "Server.run"],
			["a.rb", "class Server\n  def run\n  end\nend\n", "Server.run"],
			["a.swift", "class Server { func run() {} }\n", "Server.run"],
		]) expect((await buildSymbolRead({ path, symbol: name }, content)).details.symbol?.qualifiedName).toBe(name);
	});

	it("keeps decorators and signatures when a line is inside a Python function", async () => {
		const content = "@decorate(\n    value=True,\n)\ndef work(\n    x,\n):\n    return x\n";
		const result = await buildSymbolRead({ path: "a.py", line: 2 }, content);
		expect(result.details.symbol).toMatchObject({ startLine: 1, endLine: 7 });
	});

	it("returns duplicate-name candidates, not the first match", async () => {
		const content = "class A { run() {} }\nclass B { run() {} }\n";
		await expect(buildSymbolRead({ path: "a.ts", symbol: "run" }, content)).rejects.toThrow(/Ambiguous symbol selection: 2 candidates[\s\S]*A.run[\s\S]*B.run/);
		expect((await buildSymbolRead({ path: "a.ts", symbol: "run", line: 2 }, content)).details.symbol?.qualifiedName).toBe("B.run");
	});

	it("uses UTF-16 columns to distinguish same-line symbols after Unicode", async () => {
		const content = 'const emoji = "😀"; function a() {} function b() {}';
		await expect(buildSymbolRead({ path: "a.js", line: 1 }, content)).rejects.toThrow("Ambiguous symbol selection");
		const result = await buildSymbolRead({ path: "a.js", line: 1, column: content.indexOf("function b") + 1 }, content);
		expect(result.details.symbol?.name).toBe("b");
	});

	it("indexes nested functions and ignores declaration-like comments/strings", async () => {
		const content = '// function fake() {}\nfunction outer() {\n const x = "function wrong() {}";\n return () => { return 2; };\n}\n';
		const index = await indexSymbols("a.ts", content);
		expect(index.symbols.map((symbol) => symbol.name)).toEqual(["outer", "<anonymous@4:9>"]);
	});

	it.each(["function work() {", "function work( { ???", "class A { run() { return 1; }"])("refuses incomplete syntax: %s", async (content) => {
		await expect(buildSymbolRead({ path: "a.ts", line: 1 }, content)).rejects.toThrow(/Syntax error or incomplete syntax/);
	});

	it("bounds qualified-name growth in deeply nested declarations", async () => {
		const content = `${"function nested() {".repeat(160)}return 1;${"}".repeat(160)}`;
		await expect(buildSymbolRead({ path: "a.ts", line: 1 }, content)).rejects.toThrow("qualified symbol name budget");
	});

	it("lists a paginated outline without pretending it read symbol bodies", async () => {
		const first = await buildSymbolRead({ path: "a.ts", limit: 1 }, source);
		expect(first.details.mode).toBe("outline");
		expect(first.details.visible).toBeUndefined();
		expect(first.details.nextCall).toEqual({ path: "a.ts", limit: 1, offset: 2 });
		const next = await buildSymbolRead(first.details.nextCall!, source);
		expect(text(next)).toContain("second");
		expect(next.details.complete).toBe(true);
	});
});

describe("read_symbol output and recovery", () => {
	it("reads by line from disk with exact range and snapshot", async () => {
		const path = await setup();
		const result = await run({ path, line: 6 });
		expect(result.details.visible).toEqual({ startLine: 5, endLine: 7, startOffset: source.indexOf("export function second"), endOffset: source.length - 1 });
		expect(text(result)).toContain("Complete selection");
		expect(text(result)).not.toContain("export function first");
	});

	it("handles @ paths, file URLs, CRLF, and BOM", async () => {
		const path = await setup("space name.ts", `\uFEFF${source.replaceAll("\n", "\r\n")}`);
		for (const name of [`@${path}`, pathToFileURL(join(cwd, path)).href]) {
			const result = await run({ path: name, symbol: "second" });
			expect(text(result)).toContain("export function second() {\n  log();\n}");
		}
	});

	it("includes requested context and gives exact page continuation", async () => {
		const first = await buildSymbolRead({ path: "a.ts", symbol: "second", context: 1, limit: 2 }, source);
		expect(first.details.visible).toMatchObject({ startLine: 4, endLine: 5 });
		expect(first.details.complete).toBe(false);
		expect(first.details.nextCall).toEqual({ path: "a.ts", symbol: "second", context: 1, limit: 2, offset: 3 });
		const second = await buildSymbolRead(first.details.nextCall!, source);
		expect(second.details.visible?.startLine).toBe(6);
		expect(text(second)).toContain("Partial selection");
	});

	it("bounds multibyte pages and keeps all fences complete", async () => {
		const content = `function large() {\n${Array.from({ length: 1700 }, () => `  log("${"é".repeat(40)}");`).join("\n")}\n}\n`;
		let input: ReadSymbolInput | undefined = { path: "a.ts", line: 1, limit: 1800 };
		let previousEnd = 0;
		let calls = 0;
		while (input) {
			const result = await buildSymbolRead(input, content);
			expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(48 * 1024);
			expect(text(result).split("\n").length).toBeLessThanOrEqual(1950);
			expect(text(result).split("\n").filter((line) => /^`{3,}$/.test(line))).toHaveLength(2);
			expect(result.details.visible?.startLine).toBe(previousEnd + 1);
			previousEnd = result.details.visible!.endLine;
			input = result.details.nextCall;
			if (++calls > 20) throw new Error("Pagination did not progress");
		}
		expect(previousEnd).toBe(1702);
	});

	it("never cuts a huge line into a retryable snippet", async () => {
		await expect(buildSymbolRead({ path: "a.ts", line: 1 }, `function big() { return '${"x".repeat(60_000)}'; }`)).rejects.toThrow(/cannot fit as a complete line[\s\S]*Next: read/);
	});

	it("gives nearby symbols for a wrong name and line context outside a symbol", async () => {
		await expect(buildSymbolRead({ path: "a.ts", symbol: "secod" }, source)).rejects.toThrow(/No matching symbol[\s\S]*second[\s\S]*read_symbol/);
		await expect(buildSymbolRead({ path: "a.ts", line: 4 }, source)).rejects.toThrow(/No matching symbol[\s\S]*read_symbol/);
	});

	it("reports EOF with actual nearby content and usable arguments", async () => {
		await expect(buildSymbolRead({ path: "a.ts", line: 999 }, source)).rejects.toThrow(/beyond EOF[\s\S]*export function second[\s\S]*Next: read/);
		await expect(buildSymbolRead({ path: "a.ts", symbol: "first", offset: 99 }, source)).rejects.toThrow(/selected region has 3 lines[\s\S]*"offset":1/);
	});

	it("falls back explicitly for unsupported files and files without declarations", async () => {
		await expect(buildSymbolRead({ path: "a.md", line: 1 }, "# Title\ntext")).rejects.toThrow(/Unsupported source type[\s\S]*# Title[\s\S]*Next: read/);
		await expect(buildSymbolRead({ path: "a.js", line: 1 }, "console.log(1)")).rejects.toThrow(/No symbol declarations found[\s\S]*console.log/);
	});

	it("returns bounded neighboring filenames for a missing path", async () => {
		await setup("handler.ts");
		await expect(run({ path: "handlers.ts", line: 1 })).rejects.toThrow(/Nearby file candidates[\s\S]*handler.ts[\s\S]*Verify the path/);
	});

	it("rejects directories, binary files, invalid UTF-8, and oversized source", async () => {
		await expect(run({ path: cwd })).rejects.toThrow("not a regular source file");
		for (const [name, bytes, message] of [
			["nul.ts", Buffer.from("x\0"), "NUL bytes"],
			["bad.ts", Buffer.from([0xff]), "not valid UTF-8"],
			["big.ts", Buffer.alloc(2 * 1024 * 1024 + 1, 65), "2 MiB"],
		] as const) { await writeFile(join(cwd, name), bytes); await expect(run({ path: name })).rejects.toThrow(message); }
	});

	it.each([{ line: 0 }, { line: 1.5 }, { column: 1 }, { limit: 0 }, { limit: 1801 }, { parent: -1 }, { context: 21 }, { offset: Number.POSITIVE_INFINITY }, { symbol: " " }])("rejects invalid arguments %j", (args) => {
		expect(() => validateReadSymbolInput({ path: "a.ts", ...args })).toThrow();
	});

	it("requires an explicit selector for symbol mode and keeps legacy stored calls readable", async () => {
		expect(() => validateReadSymbolInput({ path: "a.ts", mode: "symbol" })).toThrow(/requires a symbol name or containing line/);
		expect(() => validateReadSymbolInput({ path: "a.ts", mode: "outline", line: 1 })).toThrow(/does not accept/);
		expect((await buildSymbolRead({ path: "a.ts" }, source)).details.mode).toBe("outline");
	});

	it("honors cancellation before reading", async () => {
		const controller = new AbortController(); controller.abort();
		await expect(executeReadSymbol({ path: "missing.ts" }, controller.signal, { cwd })).rejects.toThrow(/abort/i);
	});
});

describe("read_symbol as edit evidence", () => {
	it("resolves only the repeated text in the displayed symbol", async () => {
		const path = await setup(); const input = { path, line: 6 };
		const result = await run(input);
		await executeBetterEdit({ path, edits: [{ oldText: "  log();", newText: "  changed();" }] }, undefined, { cwd, sessionManager: session(input, result) });
		expect(await readFile(join(cwd, path), "utf8")).toBe(source.replace("export function second() {\n  log();", "export function second() {\n  changed();"));
	});

	it("rejects forged output, changed arguments, outlines, and stale snapshots", async () => {
		const path = await setup(); const input = { path, symbol: "second" };
		const result = await run(input);
		const check = async (body: string, manager: ExtensionContext["sessionManager"]) => findLatestReadEvidence(manager, await realpath(join(cwd, path)), body, (p) => realpath(join(cwd, p)));
		await expect(check(source, session(input, result))).resolves.toMatchObject({ startLine: 5, endLine: 7 });
		await expect(check(source, session(input, { ...result, content: [{ type: "text", text: text(result) + "tampered" }] }))).resolves.toBeNull();
		await expect(check(source, session({ ...input, symbol: "first" }, result))).resolves.toBeNull();
		await expect(check(source, session({ path }, await run({ path })))).resolves.toBeNull();
		await expect(check(source.replace("first", "other"), session(input, result))).resolves.toBeNull();
	});

	it("uses retained-tail symbol reads and never falls back past a newer failed read", async () => {
		const path = await setup(); const input = { path, symbol: "second" };
		const entries = session(input, await run(input)).buildContextEntries();
		const retained = { buildContextEntries: () => [{ type: "compaction", retainedTail: entries.map((entry) => (entry as unknown as { message: unknown }).message) }] } as unknown as ExtensionContext["sessionManager"];
		const check = async (manager: ExtensionContext["sessionManager"]) => findLatestReadEvidence(manager, await realpath(join(cwd, path)), source, (p) => realpath(join(cwd, p)));
		await expect(check(retained)).resolves.toMatchObject({ startLine: 5, endLine: 7 });
		for (const name of ["read", "read_symbol"]) {
			const manager = { buildContextEntries: () => [...entries,
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "newer", name, arguments: { path, line: 999 } }] } },
				{ type: "message", message: { role: "toolResult", toolCallId: "newer", toolName: name, isError: true, content: [{ type: "text", text: "failed" }] } },
			] } as unknown as ExtensionContext["sessionManager"];
			await expect(check(manager)).resolves.toBeNull();
		}
	});

	it("does not count undisplayed lines on a partial page as evidence", async () => {
		const path = await setup(); const input = { path, symbol: "second", limit: 1 };
		const result = await run(input);
		await expect(executeBetterEdit({ path, edits: [{ oldText: "  log();", newText: "  changed();" }] }, undefined, { cwd, sessionManager: session(input, result) })).rejects.toThrow("Found 2 occurrences");
	});

	it.skipIf(process.platform === "win32")("verifies symbol reads through a symlink alias", async () => {
		const path = await setup(); await symlink(join(cwd, path), join(cwd, "alias.ts"));
		const input = { path: "alias.ts", symbol: "second" }; const result = await run(input);
		const evidence = await findLatestReadEvidence(session(input, result), await realpath(join(cwd, path)), source, (p) => realpath(join(cwd, p)));
		expect(evidence?.startLine).toBe(5);
	});
});

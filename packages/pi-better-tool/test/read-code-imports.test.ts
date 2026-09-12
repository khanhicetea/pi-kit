import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodeImportsRead, executeReadCodeImports, type ReadCodeImportsResult } from "../src/read-code-imports.ts";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "pi-read-imports-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const text = (result: ReadCodeImportsResult) => result.content[0].text;

describe("read_code_imports detection", () => {
	it.each([
		["a.ts", "import type { A } from './a';\nimport {\n  b,\n} from './b';\n\nconst value = 1;\n", 1, 4],
		["a.py", "from os import (\n    path,\n)\nimport sys\n\ndef run(): pass\n", 1, 4],
		["a.go", "package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n\nfunc main() {}\n", 3, 6],
		["a.rs", "use std::{\n    fs,\n    io,\n};\nfn main() {}\n", 1, 4],
		["a.cpp", "#include <vector>\n// local dependency\n#include \"app.h\"\n\nint main() {}\n", 1, 3],
		["a.cs", "global using System;\nusing static System.Math;\nclass App {}\n", 1, 2],
		["a.java", "package app;\nimport java.util.List;\nimport static java.util.Map.entry;\nclass App {}\n", 2, 3],
		["a.kt", "package app\nimport kotlin.io.path.Path\nclass App\n", 2, 2],
		["a.php", "<?php\nuse App\\Service;\nrequire_once __DIR__ . '/boot.php';\nrun();\n", 2, 3],
		["Gemfile", "source 'https://rubygems.org'\nrequire 'bundler/setup'\nrequire_relative 'tools'\nrun\n", 2, 3],
		["a.swift", "import Foundation\n@testable import AppCore\nstruct App {}\n", 1, 2],
		["a.sh", "#!/bin/sh\nsource ./env.sh\n. ./helpers.sh\nrun\n", 2, 3],
	] as const)("returns the complete first import zone for %s", (path, source, startLine, endLine) => {
		const result = buildCodeImportsRead({ path }, source);
		expect(result.details).toMatchObject({ found: true, visible: { startLine, endLine } });
		expect(text(result)).toContain(`Import zone: file lines ${startLine}-${endLine}`);
	});

	it("preserves raw comments and blank lines between adjacent imports but stops at code", () => {
		const source = "import a from 'a';\n\n// group two\nimport b from 'b';\nconst x = 1;\nimport c from 'c';\n";
		const result = buildCodeImportsRead({ path: "a.ts" }, source);
		expect(text(result)).toContain("import a from 'a';\n\n// group two\nimport b from 'b';");
		expect(text(result)).not.toContain("import c from 'c';");
		expect(result.details.visible).toEqual({ startLine: 1, endLine: 4 });
	});

	it("reports no imports without inventing a source range", () => {
		const result = buildCodeImportsRead({ path: "a.py" }, "def run():\n    pass\n");
		expect(result.details.found).toBe(false);
		expect(result.details.visible).toBeUndefined();
		expect(text(result)).toContain("No dependency import statements found");
	});

	it("rejects unsupported paths and oversized complete zones", () => {
		expect(() => buildCodeImportsRead({ path: "notes.txt" }, "import x")).toThrow("Unsupported source type");
		const source = Array.from({ length: 4000 }, (_, index) => `import value${index} from '${"x".repeat(20)}';`).join("\n");
		expect(() => buildCodeImportsRead({ path: "a.ts" }, source)).toThrow("48 KiB / 1,950-line");
	});
});

describe("read_code_imports execution", () => {
	it("reads a local file and returns a stable snapshot", async () => {
		await writeFile(join(cwd, "a.ts"), "import { x } from './x';\nrun(x);\n");
		const result = await executeReadCodeImports({ path: "a.ts" }, undefined, { cwd });
		expect(result.details.snapshot).toMatch(/^[a-f0-9]{64}$/);
		expect(text(result)).toContain("import { x } from './x';");
	});
});

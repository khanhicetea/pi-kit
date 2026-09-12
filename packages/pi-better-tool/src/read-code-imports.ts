import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { boundCompleteOutput, fenceFor } from "./diagnostics.ts";
import { resolveToolPath } from "./paths.ts";
import { readSource, sourceReadError } from "./source-file.ts";

export const readCodeImportsSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096, description: "Local source file path (relative, absolute, @path, ~/path, or file URL)." }),
});
export type ReadCodeImportsInput = Static<typeof readCodeImportsSchema>;

type ImportLanguage = "javascript" | "python" | "go" | "rust" | "c" | "csharp" | "java" | "kotlin" | "php" | "ruby" | "swift" | "shell";
interface LineRange { start: number; end: number }
export interface ReadCodeImportsResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		language: ImportLanguage;
		snapshot: string;
		found: boolean;
		visible?: { startLine: number; endLine: number };
	};
}

const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_LINES = 1950;
const EXTENSIONS: Record<string, ImportLanguage> = {
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".ts": "javascript", ".tsx": "javascript", ".mts": "javascript", ".cts": "javascript",
	".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
	".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".cxx": "c", ".hpp": "c", ".m": "c", ".mm": "c",
	".cs": "csharp", ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".php": "php",
	".rb": "ruby", ".swift": "swift", ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
};

function importLanguage(path: string): ImportLanguage | undefined {
	const name = basename(path).toLowerCase();
	if (name === "gemfile" || name === "rakefile") return "ruby";
	return EXTENSIONS[extname(name)];
}

function isImportStart(line: string, language: ImportLanguage): boolean {
	switch (language) {
		case "javascript": return /^(?:import(?:\s|["'])|export\s+(?:type\s+)?(?:\*|\{)[\s\S]*\bfrom\b)/.test(line);
		case "python": return /^(?:from\s+[\w.]+\s+import\b|import\s+[\w.])/.test(line);
		case "go": return /^import(?:\s|\()/.test(line);
		case "rust": return /^(?:(?:pub(?:\([^)]*\))?\s+)?use\b|extern\s+crate\b)/.test(line);
		case "c": return /^\s*#\s*(?:include|import)\b/.test(line);
		case "csharp": return /^(?:(?:global\s+)?using\b|extern\s+alias\b)/.test(line);
		case "java": case "kotlin": return /^import\b/.test(line);
		case "php": return /^(?:use\b|(?:require|include)(?:_once)?\b)/.test(line);
		case "ruby": return /^(?:require|require_relative|load)\b/.test(line);
		case "swift": return /^(?:@\w+(?:\([^)]*\))?\s+)?import\b/.test(line);
		case "shell": return /^(?:source\b|\.\s+\S)/.test(line);
	}
}

function statementEnd(lines: string[], start: number, language: ImportLanguage): number {
	if (language === "go" && /^import\s*\(/.test(lines[start])) {
		for (let index = start; index < lines.length; index++) if (/^\s*\)/.test(lines[index])) return index;
		return start;
	}
	if (language === "python") {
		let depth = 0;
		for (let index = start; index < lines.length; index++) {
			const code = lines[index].replace(/#.*$/, "");
			depth += (code.match(/[([{]/g) ?? []).length - (code.match(/[)\]}]/g) ?? []).length;
			if (depth <= 0 && !/\\\s*$/.test(code)) return index;
		}
		return start;
	}
	if (language === "javascript") {
		for (let index = start; index < lines.length; index++) {
			const code = lines[index].replace(/\/\/.*$/, "").trimEnd();
			if (/;\s*$/.test(code) || /(?:from\s+)?["'][^"']+["']\s*(?:(?:with|assert)\s*\{.*\})?\s*$/.test(code)) return index;
		}
		return start;
	}
	if (language === "rust" || language === "csharp" || language === "java" || language === "kotlin" || language === "php") {
		for (let index = start; index < lines.length; index++) if (/;\s*(?:\/\/.*)?$/.test(lines[index])) return index;
		return start;
	}
	if (language === "c") {
		let index = start;
		while (index + 1 < lines.length && /\\\s*$/.test(lines[index])) index++;
		return index;
	}
	return start;
}

function isTrivia(line: string): boolean {
	return /^\s*(?:$|\/\/|\/\*|\*|#(?!\s*(?:include|import)\b)|<!--|-->|\{\/\*)/.test(line);
}

function findImportZone(lines: string[], language: ImportLanguage): LineRange | undefined {
	const statements: LineRange[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!isImportStart(lines[index], language)) continue;
		const end = statementEnd(lines, index, language);
		statements.push({ start: index, end });
		index = end;
	}
	if (!statements.length) return undefined;
	const zone = { ...statements[0] };
	for (const statement of statements.slice(1)) {
		if (!lines.slice(zone.end + 1, statement.start).every(isTrivia)) break;
		zone.end = statement.end;
	}
	return zone;
}

export function validateReadCodeImportsInput(input: ReadCodeImportsInput): void {
	if (!input || typeof input.path !== "string" || !input.path.length || input.path.length > 4096) throw new Error("read_code_imports requires a non-empty path of at most 4096 characters.");
}

export function buildCodeImportsRead(input: ReadCodeImportsInput, content: string): ReadCodeImportsResult {
	validateReadCodeImportsInput(input);
	const language = importLanguage(resolveToolPath(input.path, "/"));
	if (!language) throw new Error("Unsupported source type. read_code_imports supports JavaScript/TypeScript, Python, Go, Rust, C/C++, C#, Java, Kotlin, PHP, Ruby, Swift, and shell source files. Use read for this file.");
	const lines = content.split("\n");
	const zone = findImportZone(lines, language);
	const snapshot = createHash("sha256").update(content).digest("hex");
	const header = `Source ${JSON.stringify(input.path)} (${lines.length} lines). Snapshot sha256:${snapshot}`;
	if (!zone) return { content: [{ type: "text", text: `${header}\nNo dependency import statements found.` }], details: { language, snapshot, found: false } };
	const snippet = lines.slice(zone.start, zone.end + 1).join("\n");
	const fence = fenceFor(snippet);
	const text = `${header}\nImport zone: file lines ${zone.start + 1}-${zone.end + 1}. Raw source lines; regex-detected, not resolved.\n\n${fence}\n${snippet}\n${fence}`;
	if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES || text.split("\n").length > MAX_OUTPUT_LINES) throw new Error(`The complete import zone exceeds the 48 KiB / 1,950-line output limit (lines ${zone.start + 1}-${zone.end + 1}). Use read with an explicit offset/limit.`);
	return { content: [{ type: "text", text }], details: { language, snapshot, found: true, visible: { startLine: zone.start + 1, endLine: zone.end + 1 } } };
}

export async function executeReadCodeImports(input: ReadCodeImportsInput, signal: AbortSignal | undefined, ctx: Pick<ExtensionContext, "cwd">): Promise<ReadCodeImportsResult> {
	validateReadCodeImportsInput(input);
	const path = resolveToolPath(input.path, ctx.cwd);
	let content: string;
	try { content = await readSource(path, signal, "read_code_imports"); }
	catch (error) { signal?.throwIfAborted(); throw new Error(boundCompleteOutput(await sourceReadError(path, error, "read_code_imports"))); }
	try { return buildCodeImportsRead(input, content); }
	catch (error) { throw new Error(boundCompleteOutput(error instanceof Error ? error.message : String(error))); }
}

export function registerReadCodeImportsTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_code_imports", label: "read_code_imports",
		description: "Read the dependency import zone from a common-language source file as exact raw lines. Uses bounded regex-based detection for imports/includes/use/require statements, preserves comments and blank lines between adjacent imports, and reports the file range and snapshot. It does not resolve dependencies or replace read for arbitrary ranges.",
		promptSnippet: "Read a source file's raw dependency import zone",
		promptGuidelines: [
			"When preparing an edit that adds code which uses a dependency, use read_code_imports if you are not sure whether the required import already exists.",
			"When the target code also needs inspection, batch read_code_imports with that independent code read; inspect both results before making the dependent edit.",
			"Treat read_code_imports output as regex-detected source text; inspect more context when conditional or generated imports can affect the edit.",
			"Use the raw lines from read_code_imports to decide whether an import edit is needed, then include all required import and code changes in one edit call when possible.",
		],
		parameters: readCodeImportsSchema,
		async execute(_id, input, signal, _onUpdate, ctx) { return executeReadCodeImports(input, signal, ctx); },
	});
}

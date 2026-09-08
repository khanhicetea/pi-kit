import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { boundCompleteOutput, fenceFor } from "./diagnostics.ts";
import { resolveToolPath } from "./paths.ts";
import { readSource, sourceReadError } from "./source-file.ts";
import { indexSymbols, languageForPath, SUPPORTED_LANGUAGES, type SourceSymbol } from "./symbols.ts";
import { getLineSpans } from "./text.ts";

export const readSymbolSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096, description: "Local source file path (relative, absolute, @path, ~/path, or file URL)." }),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "Read the innermost symbol containing this 1-based line. Combine with symbol to disambiguate duplicate names." })),
	column: Type.Optional(Type.Integer({ minimum: 1, description: "Optional 1-based UTF-16 column with line, to distinguish symbols on the same line." })),
	symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact symbol name or qualified name, for example Server.run. Omit both symbol and line to list a symbol outline." })),
	parent: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Move outward this many enclosing symbols after selection (default 0)." })),
	context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Extra whole lines before and after the selected symbol (default 0)." })),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based position within the selected symbol/context or outline, not a file line. Use the exact continuation call from a partial result." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Maximum source lines (default 1000) or outline entries (default 50). Output also has a 48 KiB hard limit." })),
});
export type ReadSymbolInput = Static<typeof readSymbolSchema>;

export interface VisibleSource {
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
}
export interface ReadSymbolResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		mode: "symbol" | "outline";
		snapshot: string;
		symbol?: SourceSymbol;
		visible?: VisibleSource;
		complete: boolean;
		nextCall?: ReadSymbolInput;
	};
}
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_OUTPUT_LINES = 1950;
const label = (text: string) => JSON.stringify(text.length > 300 ? `${text.slice(0, 297)}…` : text);
const callText = (input: ReadSymbolInput) => `read_symbol ${JSON.stringify(input)}`;

export function validateReadSymbolInput(input: ReadSymbolInput): void {
	if (!input || typeof input.path !== "string" || !input.path.length || input.path.length > 4096) throw new Error("read_symbol requires a non-empty path of at most 4096 characters.");
	if (input.symbol !== undefined && (typeof input.symbol !== "string" || !input.symbol.trim() || input.symbol.length > 256)) throw new Error("read_symbol symbol must be a non-empty name of at most 256 characters.");
	for (const [key, min, max] of [["line", 1, Number.MAX_SAFE_INTEGER], ["column", 1, Number.MAX_SAFE_INTEGER], ["parent", 0, 20], ["context", 0, 20], ["offset", 1, Number.MAX_SAFE_INTEGER], ["limit", 1, 1800]] as const) {
		const value = input[key];
		if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max)) throw new Error(`read_symbol ${key} must be an integer from ${min} to ${max}.`);
	}
	if (input.column !== undefined && input.line === undefined) throw new Error("read_symbol column requires line.");
	if ((input.parent || input.context) && input.line === undefined && input.symbol === undefined) throw new Error("read_symbol parent/context requires a line or symbol selector; omit them to get an outline.");
}

function candidateLine(path: string, symbol: SourceSymbol): string {
	return `- ${label(symbol.qualifiedName)} (${symbol.kind}), lines ${symbol.startLine}-${symbol.endLine}. ${callText({ path, line: symbol.startLine, column: symbol.startColumn, symbol: symbol.qualifiedName.length <= 256 ? symbol.qualifiedName : undefined })}`;
}

/** Non-copyable preview for failed selection; never presented as a complete symbol. */
function fallbackContext(input: ReadSymbolInput, content: string, reason: string, atLine = input.line ?? 1): Error {
	const lines = content.split("\n");
	const center = Math.min(Math.max(atLine, 1), lines.length);
	const start = Math.max(1, center - 5);
	const end = Math.min(lines.length, center + 10);
	const preview = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line.length > 240 ? `${line.slice(0, 240)}… [line clipped]` : line}`).join("\n");
	return new Error(`${reason}\nFile has ${lines.length} lines. Preview only, not a complete symbol or retryable edit snippet:\n${preview}\nNext: read ${JSON.stringify({ path: input.path, offset: start, limit: end - start + 1 })}`);
}

function inside(symbol: SourceSymbol, line: number, column?: number): boolean {
	if (line < symbol.startLine || line > symbol.endLine) return false;
	if (column !== undefined && ((line === symbol.startLine && column < symbol.startColumn) || (line === symbol.endLine && column >= symbol.endColumn))) return false;
	return true;
}

function selectSymbol(input: ReadSymbolInput, symbols: SourceSymbol[]): SourceSymbol {
	let matches = symbols.filter((symbol) =>
		(input.symbol === undefined || symbol.name === input.symbol || symbol.qualifiedName === input.symbol) &&
		(input.line === undefined || inside(symbol, input.line, input.column)),
	);
	if (input.symbol === undefined) {
		// Keep innermost declarations, but never choose arbitrarily between siblings.
		const matched = new Set(matches);
		const ancestors = new Set<SourceSymbol>();
		// Parents precede children in the index. Propagate once in reverse,
		// rather than walking every ancestor chain in deeply nested source.
		for (let index = symbols.length - 1; index >= 0; index--) {
			const symbol = symbols[index];
			if (symbol.parent !== undefined && (matched.has(symbol) || ancestors.has(symbol))) ancestors.add(symbols[symbol.parent]);
		}
		matches = matches.filter((symbol) => !ancestors.has(symbol));
	}
	if (matches.length !== 1) {
		const candidates = matches.length ? matches : [...symbols].sort((a, b) => {
			if (input.line !== undefined) return Math.abs(a.startLine - input.line) - Math.abs(b.startLine - input.line);
			const query = input.symbol?.toLowerCase() ?? "";
			return Number(b.qualifiedName.toLowerCase().includes(query)) - Number(a.qualifiedName.toLowerCase().includes(query));
		});
		throw new Error([
			matches.length ? `Ambiguous symbol selection: ${matches.length} candidates. No symbol was selected.` : "No matching symbol. Names are exact and case-sensitive; no nearby symbol was selected automatically.",
			...candidates.slice(0, 8).map((symbol) => candidateLine(input.path, symbol)),
			...(candidates.length > 8 ? [`${candidates.length - 8} more candidates omitted.`] : []),
			`Next: choose a candidate call above, or list the outline with ${callText({ path: input.path })}.`,
		].join("\n"));
	}
	let selected = matches[0];
	for (let depth = 0; depth < (input.parent ?? 0); depth++) {
		if (selected.parent === undefined) throw new Error(`No enclosing symbol at parent=${input.parent}. Outermost available: ${candidateLine(input.path, selected)}\nRetry with a smaller parent value.`);
		selected = symbols[selected.parent];
	}
	return selected;
}

function fits(text: string): boolean {
	return Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES && text.split("\n").length <= MAX_OUTPUT_LINES;
}

/** Pure snapshot-to-result path, also used to verify stored read evidence. */
export async function buildSymbolRead(input: ReadSymbolInput, content: string, signal?: AbortSignal): Promise<ReadSymbolResult> {
	validateReadSymbolInput(input);
	const lines = content.split("\n");
	if (input.line !== undefined && input.line > lines.length) throw fallbackContext(input, content, `line=${input.line} is beyond EOF. Valid lines: 1-${lines.length}.`);
	if (input.column !== undefined && input.column > lines[input.line! - 1].length + 1) throw fallbackContext(input, content, `column=${input.column} is outside line ${input.line}.`);
	const parserPath = resolveToolPath(input.path, "/");
	if (!languageForPath(parserPath)) throw fallbackContext(input, content, `Unsupported source type. read_symbol supports ${SUPPORTED_LANGUAGES}. Use read for this file.`);
	let index: Awaited<ReturnType<typeof indexSymbols>>;
	try { index = await indexSymbols(parserPath, content, signal); }
	catch (error) {
		signal?.throwIfAborted();
		throw fallbackContext(input, content, `Symbol parser unavailable or analysis limit reached: ${error instanceof Error ? error.message.slice(0, 500) : "unknown parser error"}. Use read instead.`);
	}
	signal?.throwIfAborted();
	if (index.errorLine !== undefined) throw fallbackContext(input, content, `Syntax error or incomplete syntax near line ${index.errorLine}; complete symbol boundaries are not reliable.`, input.line ?? index.errorLine);
	const snapshot = createHash("sha256").update(content).digest("hex");
	const header = `Source ${label(input.path)} (${lines.length} lines). Snapshot sha256:${snapshot}`;
	const offset = input.offset ?? 1;
	if (input.line === undefined && input.symbol === undefined) {
		const total = index.symbols.length;
		if (offset > Math.max(1, total)) throw new Error(`Outline offset=${offset} is beyond ${total} entries. Next: ${callText({ ...input, offset: Math.max(1, total - 49) })}`);
		const entries: string[] = [];
		let cursor = offset - 1;
		for (; cursor < Math.min(total, offset - 1 + (input.limit ?? 50)); cursor++) {
			const entry = candidateLine(input.path, index.symbols[cursor]);
			if (!fits(`${header}\n${entries.join("\n")}\n${entry}\n${" ".repeat(6000)}`)) break;
			entries.push(entry);
		}
		const nextCall = cursor < total ? { ...input, offset: cursor + 1 } : undefined;
		const text = `${header}\nSymbol outline: ${total} declarations, ${entries.length} shown.${total === 0 ? " No symbols found; use read for source text." : ""}\n${entries.join("\n")}${nextCall ? `\nMore entries. Next: ${callText(nextCall)}` : ""}`;
		return { content: [{ type: "text", text }], details: { mode: "outline", snapshot, complete: !nextCall, nextCall } };
	}
	if (!index.symbols.length) throw fallbackContext(input, content, "No symbol declarations found in this file.");
	const selected = selectSymbol(input, index.symbols);
	const start = Math.max(1, selected.startLine - (input.context ?? 0));
	const end = Math.min(lines.length, selected.endLine + (input.context ?? 0));
	const count = end - start + 1;
	if (offset > count) throw new Error(`Symbol ${label(selected.qualifiedName)} spans lines ${selected.startLine}-${selected.endLine}; selected region has ${count} lines. offset=${offset} is outside it. Next: ${callText({ ...input, offset: 1 })}`);
	const firstLine = start + offset - 1;
	let lastLine = Math.min(end, firstLine + (input.limit ?? 1000) - 1);
	const parents: string[] = [];
	let parent = selected.parent;
	while (parent !== undefined && parents.length < 20) { parents.unshift(label(index.symbols[parent].qualifiedName)); parent = index.symbols[parent].parent; }
	const prefix = `${header}\nSymbol ${label(selected.qualifiedName)} (${selected.kind}), lines ${selected.startLine}-${selected.endLine}.${parents.length ? `\nEnclosing: ${parents.join(" > ")}` : ""}`;
	let text = "";
	let snippet = "";
	let nextCall: ReadSymbolInput | undefined;
	// Whole-line pages only. Account for fences, metadata, and continuation JSON.
	while (lastLine >= firstLine) {
		snippet = lines.slice(firstLine - 1, lastLine).join("\n");
		const fence = fenceFor(snippet);
		nextCall = lastLine < end ? { ...input, offset: lastLine - start + 2 } : undefined;
		text = `${prefix}\nShowing file lines ${firstLine}-${lastLine} of selected lines ${start}-${end}. ${firstLine === start && lastLine === end ? "Complete selection." : "Partial selection; do not treat this page as the whole symbol."}\n\n${fence}\n${snippet}\n${fence}${nextCall ? `\n\nNext: ${callText(nextCall)}` : ""}`;
		if (fits(text)) break;
		// Remove a proportional chunk first; small pages shrink one line at a time.
		lastLine -= Math.max(1, Math.floor((lastLine - firstLine + 1) / 4));
	}
	if (lastLine < firstLine) throw fallbackContext(input, content, `File line ${firstLine} cannot fit as a complete line in the 48 KiB output budget. No partial edit snippet was returned.`, firstLine);
	const spans = getLineSpans(content);
	const startOffset = spans[firstLine - 1]?.start ?? content.length;
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "symbol", snapshot, symbol: selected,
			visible: { startLine: firstLine, endLine: lastLine, startOffset, endOffset: startOffset + snippet.length },
			complete: firstLine === start && lastLine === end, nextCall,
		},
	};
}

export async function executeReadSymbol(input: ReadSymbolInput, signal: AbortSignal | undefined, ctx: Pick<ExtensionContext, "cwd">): Promise<ReadSymbolResult> {
	validateReadSymbolInput(input);
	const path = resolveToolPath(input.path, ctx.cwd);
	let content: string;
	try { content = await readSource(path, signal); }
	catch (error) { signal?.throwIfAborted(); throw new Error(boundCompleteOutput(await sourceReadError(path, error))); }
	try { return await buildSymbolRead(input, content, signal); }
	catch (error) {
		signal?.throwIfAborted();
		throw new Error(boundCompleteOutput(error instanceof Error ? error.message : String(error)));
	}
}

export function registerReadSymbolTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_symbol", label: "read_symbol",
		description: `Read a complete function, method, class, or type from a local source file by containing line or exact symbol name. Supports ${SUPPORTED_LANGUAGES}. With path only, lists a symbol outline. Includes enclosing names, exact source ranges, and actionable failure context. Output is bounded to 48 KiB/1950 lines; partial results include an exact continuation call. Does not replace read for ordinary text or images.`,
		promptSnippet: "Read whole source symbols by line/name, or list a file's symbol outline",
		promptGuidelines: [
			"Use read_symbol with path and line after grep/edit identifies a code location, instead of guessing successive read offsets to find the function boundary.",
			"Use read_symbol with symbol for an exact name or qualified name; use path alone for an outline. Use parent to include an enclosing function or class.",
			"For read_symbol partial output, use the supplied continuation arguments. offset is relative to the selection, not a file line. Only displayed source is evidence for edit.",
		],
		parameters: readSymbolSchema,
		async execute(_id, input, signal, _onUpdate, ctx) { return executeReadSymbol(input, signal, ctx); },
	});
}

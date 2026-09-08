import { basename, extname } from "node:path";
import type { SgNode } from "@ast-grep/napi";

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_SYMBOLS = 10_000;

const LANGUAGES: Record<string, string> = {
	".js": "JavaScript", ".jsx": "Tsx", ".mjs": "JavaScript", ".cjs": "JavaScript",
	".ts": "TypeScript", ".tsx": "Tsx", ".mts": "TypeScript", ".cts": "TypeScript",
	".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
	".bash": "bash", ".bats": "bash", ".command": "bash", ".ksh": "bash", ".sh": "bash", ".zsh": "bash",
	".c": "c", ".h": "c", ".cc": "cpp", ".cp": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp", ".cu": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".ino": "cpp",
	".cs": "csharp", ".java": "java", ".kt": "kotlin", ".ktm": "kotlin", ".kts": "kotlin",
	".php": "php", ".phtml": "php", ".rb": "ruby", ".rbw": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".swift": "swift",
};
const FILENAMES: Record<string, string> = { Gemfile: "ruby", Rakefile: "ruby" };
export const SUPPORTED_LANGUAGES = "Bash, C, C++, C#, Java, JavaScript/JSX, TypeScript/TSX, Kotlin, PHP, Python, Ruby, Rust, Swift, and Go";
export function languageForPath(path: string): string | undefined {
	return LANGUAGES[extname(path).toLowerCase()] ?? FILENAMES[basename(path)];
}

export interface SourceSymbol {
	name: string;
	qualifiedName: string;
	kind: string;
	startLine: number;
	endLine: number;
	/** 1-based UTF-16 columns, end-exclusive. */
	startColumn: number;
	endColumn: number;
	parent?: number;
}

export interface SymbolIndex {
	symbols: SourceSymbol[];
	/** Never claim complete symbol boundaries for a malformed tree. */
	errorLine?: number;
}

type Parser = typeof import("@ast-grep/napi");
type DynamicLanguageModule = { default: import("@ast-grep/napi").DynamicLangRegistrations[string] };

// Native dynamic language registration is process-wide. Keep only parser setup
// across /reload, never project content or session evidence. ast-grep initializes
// its registry only once, so upgrading from a smaller grammar set requires a Pi
// restart before the newly shipped grammars can be registered.
const parserKey = Symbol.for("pi-better-tool.parser.0.45.3.v2");
const parserState = globalThis as typeof globalThis & { [parserKey]?: Promise<Parser> };
const DYNAMIC_LANGUAGE_MODULES: ReadonlyArray<readonly [string, () => Promise<DynamicLanguageModule>]> = [
	["bash", () => import("@ast-grep/lang-bash")],
	["c", () => import("@ast-grep/lang-c")],
	["cpp", () => import("@ast-grep/lang-cpp")],
	["csharp", () => import("@ast-grep/lang-csharp")],
	["java", () => import("@ast-grep/lang-java")],
	["kotlin", () => import("@ast-grep/lang-kotlin")],
	["php", () => import("@ast-grep/lang-php")],
	["python", () => import("@ast-grep/lang-python")],
	["ruby", () => import("@ast-grep/lang-ruby")],
	["rust", () => import("@ast-grep/lang-rust")],
	["swift", () => import("@ast-grep/lang-swift")],
	["go", () => import("@ast-grep/lang-go")],
];
async function loadParser(): Promise<Parser> {
	return parserState[parserKey] ??= (async () => {
		const api = await import("@ast-grep/napi");
		const languages: import("@ast-grep/napi").DynamicLangRegistrations = {};
		const modules = await Promise.allSettled(DYNAMIC_LANGUAGE_MODULES.map(([, load]) => load()));
		for (const [index, [name]] of DYNAMIC_LANGUAGE_MODULES.entries()) {
			const module = modules[index];
			if (module.status !== "fulfilled") continue;
			try {
				// Resolve lazy prebuild getters here. One unavailable grammar must
				// not prevent the built-in JS/TS parsers from working.
				languages[name] = { ...module.value.default };
			} catch { /* Report unavailable language at parse time. */ }
		}
		try {
			if (Object.keys(languages).length) api.registerDynamicLanguage(languages);
		} catch { /* An incompatible native grammar must not disable built-in JS/TS. */ }
		return api;
	})();
}

const JS_DECLARATIONS = [
	"function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function",
	"method_definition", "class_declaration", "abstract_class_declaration", "class",
	"interface_declaration", "type_alias_declaration", "enum_declaration", "internal_module",
	"function_signature", "method_signature", "abstract_method_signature",
];
const DECLARATIONS_BY_LANGUAGE: Record<string, ReadonlySet<string>> = {
	JavaScript: new Set(JS_DECLARATIONS), TypeScript: new Set(JS_DECLARATIONS), Tsx: new Set(JS_DECLARATIONS),
	python: new Set(["function_definition", "class_definition"]),
	go: new Set(["function_declaration", "method_declaration", "type_spec", "func_literal"]),
	rust: new Set(["function_item", "function_signature_item", "struct_item", "enum_item", "trait_item", "impl_item", "mod_item", "type_item", "closure_expression"]),
	bash: new Set(["function_definition"]),
	c: new Set(["function_definition", "struct_specifier", "union_specifier", "enum_specifier", "type_definition"]),
	cpp: new Set(["function_definition", "class_specifier", "struct_specifier", "union_specifier", "enum_specifier", "namespace_definition", "alias_declaration"]),
	csharp: new Set(["namespace_declaration", "file_scoped_namespace_declaration", "class_declaration", "struct_declaration", "interface_declaration", "enum_declaration", "record_declaration", "delegate_declaration", "method_declaration", "constructor_declaration", "destructor_declaration", "local_function_statement"]),
	java: new Set(["class_declaration", "interface_declaration", "enum_declaration", "annotation_type_declaration", "record_declaration", "method_declaration", "constructor_declaration", "compact_constructor_declaration"]),
	kotlin: new Set(["class_declaration", "object_declaration", "function_declaration", "secondary_constructor"]),
	php: new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "function_definition", "method_declaration"]),
	ruby: new Set(["class", "module", "method", "singleton_method"]),
	swift: new Set(["class_declaration", "protocol_declaration", "struct_declaration", "enum_declaration", "extension_declaration", "actor_declaration", "function_declaration", "initializer_declaration", "deinitializer_declaration"]),
};
const ANONYMOUS_FUNCTIONS = new Set(["arrow_function", "function_expression", "generator_function", "func_literal", "closure_expression"]);
const BINDINGS = new Set(["variable_declarator", "pair", "public_field_definition", "field_definition", "assignment", "let_declaration"]);
const LIFECYCLE_NAMES: Record<string, string> = {
	constructor_declaration: "constructor", compact_constructor_declaration: "constructor", secondary_constructor: "constructor",
	destructor_declaration: "destructor", initializer_declaration: "init", deinitializer_declaration: "deinit",
};
const NAME_KINDS_BY_LANGUAGE: Record<string, readonly string[]> = {
	c: ["identifier", "field_identifier", "type_identifier"],
	cpp: ["identifier", "field_identifier", "type_identifier", "namespace_identifier", "operator_name"],
	kotlin: ["simple_identifier", "type_identifier"],
	swift: ["simple_identifier", "type_identifier"],
};

function firstNamedText(node: SgNode, kinds: readonly string[]): string | undefined {
	if (kinds.includes(String(node.kind()))) return node.text();
	for (const kind of kinds) {
		const found = node.find({ rule: { kind } });
		if (found) return found.text();
	}
	return undefined;
}

function nameForNode(node: SgNode, language: string): string | undefined {
	const directName = node.field("name")?.text();
	if (directName) return directName;
	const lifecycleName = LIFECYCLE_NAMES[String(node.kind())];
	if (lifecycleName) return lifecycleName;
	// Kotlin classes/objects use type_identifier while functions use
	// simple_identifier. Searching for the latter first would accidentally take
	// a nested method name as the enclosing class name.
	const kinds = language === "kotlin"
		? (node.kind() === "function_declaration" ? ["simple_identifier"] : ["type_identifier"])
		: NAME_KINDS_BY_LANGUAGE[language];
	if (!kinds) return undefined;
	const declarator = node.field("declarator");
	return (declarator && firstNamedText(declarator, kinds)) ?? firstNamedText(node, kinds);
}

function isDeclaration(node: SgNode, language: string): boolean {
	if (!DECLARATIONS_BY_LANGUAGE[language]?.has(String(node.kind()))) return false;
	// A typedef that wraps a named C struct/union/enum is one declaration. Keep
	// the outer typedef's full range instead of emitting a duplicate child name.
	return !(language === "c" && ["struct_specifier", "union_specifier", "enum_specifier"].includes(String(node.kind())) && node.parent()?.kind() === "type_definition");
}

function describeNode(node: SgNode, language: string): { name: string; start: SgNode; end: SgNode } {
	let start = node;
	let end = node;
	let name = nameForNode(node, language);
	const parent = node.parent();
	if (ANONYMOUS_FUNCTIONS.has(String(node.kind())) && parent && BINDINGS.has(String(parent.kind()))) {
		name = parent.field("name")?.text() ?? parent.field("key")?.text() ?? parent.field("left")?.text() ?? parent.field("pattern")?.text() ?? name;
		start = end = parent;
		const declaration = parent.parent();
		if (declaration && ["lexical_declaration", "variable_declaration"].includes(String(declaration.kind())) &&
			declaration.children().filter((child) => child.kind() === "variable_declarator").length === 1) {
			start = end = declaration;
		}
	}
	if (node.kind() === "impl_item") name = node.field("type")?.text();
	if (node.kind() === "method_declaration") {
		const receiver = node.field("receiver")?.find({ rule: { kind: "type_identifier" } })?.text();
		if (receiver && name) name = `${receiver}.${name}`;
	}
	const wrapper = start.parent();
	if (wrapper && ["export_statement", "decorated_definition"].includes(String(wrapper.kind()))) start = end = wrapper;
	// Rust attributes are siblings, not part of the declaration node.
	let previous = start.prev();
	while (previous?.kind() === "attribute_item") {
		start = previous;
		previous = previous.prev();
	}
	return { name: name ?? `<anonymous@${node.range().start.line + 1}:${node.range().start.column + 1}>`, start, end };
}

/** Parse syntax, not regex/braces. No repository code, config, or shell runs. */
export async function indexSymbols(path: string, content: string, signal?: AbortSignal): Promise<SymbolIndex> {
	signal?.throwIfAborted();
	if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) throw new Error("Source exceeds the 2 MiB symbol analysis limit.");
	const language = languageForPath(path);
	if (!language) throw new Error(`Unsupported source type. Symbol parsing supports ${SUPPORTED_LANGUAGES}.`);
	const api = await loadParser();
	signal?.throwIfAborted();
	const root = (await api.parseAsync(language, content)).root();
	signal?.throwIfAborted();
	const symbols: SourceSymbol[] = [];
	const stack: Array<{ node: SgNode; parent?: number }> = [{ node: root }];
	let visited = 0;
	let errorLine: number | undefined;
	while (stack.length) {
		if (++visited > MAX_NODES || symbols.length > MAX_SYMBOLS) throw new Error("Source exceeds the symbol traversal budget; use a bounded read instead.");
		const { node, parent } = stack.pop()!;
		const range = node.range();
		if (node.kind() === "ERROR" || (node.isLeaf() && node.id() !== root.id() && range.start.index === range.end.index)) {
			errorLine ??= range.start.line + 1;
		}
		let enclosing = parent;
		if (isDeclaration(node, language)) {
			const described = describeNode(node, language);
			const start = described.start.range().start;
			const end = described.end.range().end;
			const owner = parent === undefined ? undefined : symbols[parent];
			const qualifiedName = owner ? `${owner.qualifiedName}.${described.name}` : described.name;
			if (qualifiedName.length > 1024) throw new Error("Source exceeds the 1024-character qualified symbol name budget; use a bounded read instead.");
			enclosing = symbols.length;
			symbols.push({
				name: described.name,
				qualifiedName,
				kind: String(node.kind()), startLine: start.line + 1,
				endLine: end.line + (end.column === 0 ? 0 : 1),
				startColumn: start.column + 1, endColumn: end.column + 1, parent,
			});
		}
		const children = node.children();
		for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], parent: enclosing });
		// Give cancellation a chance during large traversals.
		if (visited % 2048 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal?.throwIfAborted();
		}
	}
	return { symbols, errorLine };
}

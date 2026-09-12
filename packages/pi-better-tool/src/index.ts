/**
 * pi-better-tool — better built-in tools for the pi coding agent.
 *
 * Ships a safe edit override and focused source readers:
 * - `edit` — exact replacement with actionable recovery context.
 * - `read_symbol` — whole symbols by containing line or exact name.
 * - `read_code_imports` — raw dependency import zones for common languages.
 * Built-in `read` remains available for text, images, and explicit line ranges.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBetterEditTool } from "./tool.ts";
import { registerReadSymbolTool } from "./read-symbol.ts";
import { registerReadCodeImportsTool } from "./read-code-imports.ts";

export { buildCodeImportsRead, executeReadCodeImports, registerReadCodeImportsTool, readCodeImportsSchema, validateReadCodeImportsInput } from "./read-code-imports.ts";
export type { ReadCodeImportsInput, ReadCodeImportsResult } from "./read-code-imports.ts";
export { executeReadSymbol, registerReadSymbolTool, readSymbolSchema } from "./read-symbol.ts";
export type { ReadSymbolInput, ReadSymbolResult } from "./read-symbol.ts";

export { registerBetterEditTool, executeBetterEdit, prepareEditArguments, betterEditSchema } from "./tool.ts";
export type {
	BetterEditExecutionOptions,
	BetterEditInput,
	BetterEditOperations,
	BetterEditSuccess,
} from "./tool.ts";
export {
	formatAutoDisambiguationSuccess,
	formatEditFailure,
	findMinimalUniqueExpansion,
	fenceFor,
} from "./diagnostics.ts";
export type { AutoDisambiguation } from "./diagnostics.ts";
export { analyzeEdits, applyAnalysis } from "./apply.ts";
export type { AnalyzeOptions, EditFailure, EditOp, EditAnalysis } from "./apply.ts";

export default function (pi: ExtensionAPI) {
	registerBetterEditTool(pi);
	registerReadSymbolTool(pi);
	registerReadCodeImportsTool(pi);
}

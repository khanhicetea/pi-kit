/**
 * pi-better-tool — better built-in tools for the pi coding agent.
 *
 * Currently ships one override:
 * - `edit` — built-in-compatible exact replacement with richer recovery
 *   context and conservative read-based resolution when a recent verified
 *   read contains exactly one of several literal occurrences.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBetterEditTool } from "./tool.ts";

export { registerBetterEditTool, executeBetterEdit, prepareEditArguments, betterEditSchema } from "./tool.ts";
export type { BetterEditInput } from "./tool.ts";
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
}

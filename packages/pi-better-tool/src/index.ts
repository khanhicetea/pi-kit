/**
 * pi-better-tool — better built-in tools for the pi coding agent.
 *
 * Currently ships one override:
 * - `edit` — identical matching semantics to the built-in edit tool, but
 *   failures return recovery context (closest matching region, per-occurrence
 *   minimal disambiguation snippets) so the agent can retry immediately
 *   without re-reading the file.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBetterEditTool } from "./tool.ts";

export { registerBetterEditTool, executeBetterEdit, prepareEditArguments, betterEditSchema } from "./tool.ts";
export type { BetterEditInput } from "./tool.ts";
export { formatEditFailure, findMinimalUniqueExpansion, fenceFor } from "./diagnostics.ts";
export { analyzeEdits, applyAnalysis } from "./apply.ts";
export type { EditFailure, EditOp, EditAnalysis } from "./apply.ts";

export default function (pi: ExtensionAPI) {
	registerBetterEditTool(pi);
}

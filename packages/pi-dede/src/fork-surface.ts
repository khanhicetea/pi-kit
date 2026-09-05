import { fileURLToPath } from "node:url";
import { DEDE_TOOL_METADATA } from "./tool-definition.ts";
import { createHash } from "node:crypto";
import { createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";

export interface ToolSurface {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  sourceInfo?: { source?: string; path?: string };
}

/** Stable object-key encoding; tool order and array order remain significant. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function surfaceFingerprint(tools: readonly ToolSurface[]): string {
  return createHash("sha256").update(JSON.stringify(tools.map((tool) => canonical({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [],
  })))).digest("hex");
}

/** Only reproducible built-ins can be proven locally; extension/SDK tools need a future handshake. */
export function localForkSurface(cwd: string, names: readonly string[], metadata: readonly ToolSurface[] | undefined): { fingerprint?: string; reason?: string } {
  if (!metadata) return { reason: "the host does not expose tool metadata/provenance" };
  const builtins = [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
  const selected: ToolSurface[] = [];
  for (const name of names) {
    const actual = metadata.find((tool) => tool.name === name);
    const expected = name === "dede_delegate" ? DEDE_TOOL_METADATA : builtins.find((tool) => tool.name === name);
    const ownDede = name === "dede_delegate" && actual?.sourceInfo?.path === fileURLToPath(new URL("./index.ts", import.meta.url));
    if (!actual || !expected || (actual.sourceInfo?.source !== "builtin" && !ownDede)) {
      return { reason: `tool ${name} is not a locally verifiable built-in (dynamic/extension/SDK tool provenance)` };
    }
    if (surfaceFingerprint([actual]) !== surfaceFingerprint([expected])) return { reason: `tool ${name} metadata/schema differs from the child built-in` };
    selected.push(actual);
  }
  return { fingerprint: surfaceFingerprint(selected) };
}

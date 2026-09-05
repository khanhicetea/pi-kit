import { fileURLToPath } from "node:url";
import { createReadTool, createGrepTool, createFindTool, createLsTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { DEDE_TOOL_METADATA } from "../src/tool-definition.ts";

export function toolSurfaceFixture(cwd: string) {
  return [
    ...[createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd), createWriteTool(cwd)].map((tool) => ({
      ...tool, sourceInfo: { source: "builtin", path: `<builtin:${tool.name}>` },
    })),
    { ...DEDE_TOOL_METADATA, sourceInfo: { source: "extension", path: fileURLToPath(new URL("../src/index.ts", import.meta.url)) } },
  ];
}

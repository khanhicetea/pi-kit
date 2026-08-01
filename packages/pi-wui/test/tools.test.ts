import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWui from "../src/index.js";

test("extension exposes one unified view-creation tool", () => {
  const tools = new Map<
    string,
    {
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: { properties?: Record<string, unknown> };
    }
  >();
  const pi = {
    registerFlag() {},
    on() {},
    registerCommand() {},
    registerTool(tool: {
      name: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: { properties?: Record<string, unknown> };
    }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  piWui(pi);

  const toolNames = [...tools.keys()];
  assert.deepEqual(toolNames, [
    "wui_load",
    "wui_get_component_docs",
    "wui",
    "wui_upload_assets",
    "wui_read_state",
    "wui_update_state",
  ]);
  assert.equal(toolNames.includes("wui_present"), false);
  assert.equal(toolNames.includes("wui_present_html"), false);
  assert.equal(toolNames.includes("wui_request_input"), false);
  assert.match(tools.get("wui_load")?.description ?? "", /survey\/intake\/discovery questionnaire/);
  assert.match(tools.get("wui_load")?.promptSnippet ?? "", /three or more user questions/);
  assert.match(tools.get("wui_load")?.promptGuidelines?.join(" ") ?? "", /use wui with feedback instead of listing/);
  assert.match(tools.get("wui_get_component_docs")?.description ?? "", /less-common components/);
  assert.ok(tools.get("wui_get_component_docs")?.parameters?.properties?.components);
  assert.match(tools.get("wui")?.description ?? "", /feedback form instead of chat/);
  assert.match(tools.get("wui")?.description ?? "", /asset:\/\//);
  assert.ok(tools.get("wui")?.parameters?.properties?.assets);
  assert.ok(tools.get("wui")?.parameters?.properties?.html);
  assert.match(tools.get("wui_upload_assets")?.description ?? "", /assetId as the complete/);
  assert.match(tools.get("wui_upload_assets")?.description ?? "", /\.png/);
  assert.ok(tools.get("wui_upload_assets")?.parameters?.properties?.paths);
});

test("extension lazily activates WUI tools without removing other tools", async () => {
  let activeTools = [
    "read",
    "bash",
    "wui",
    "wui_get_component_docs",
    "wui_upload_assets",
    "wui_read_state",
    "wui_update_state",
  ];
  let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let loader: (() => Promise<{ details: { added: readonly string[] } }>) | undefined;

  const pi = {
    registerFlag() {},
    getFlag() {
      return false;
    },
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStart = handler as (event: unknown, ctx: unknown) => Promise<void>;
      }
    },
    registerCommand() {},
    registerTool(tool: { name: string }) {
      if (tool.name === "wui_load") {
        loader = (tool as unknown as { execute: () => Promise<{ details: { added: readonly string[] } }> }).execute;
      }
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  piWui(pi);
  assert.ok(sessionStart);
  await sessionStart({}, {});
  assert.deepEqual(activeTools, ["read", "bash", "wui_load"]);

  assert.ok(loader);
  const result = await loader();
  assert.deepEqual(result.details.added, [
    "wui",
    "wui_get_component_docs",
    "wui_upload_assets",
    "wui_read_state",
    "wui_update_state",
  ]);
  assert.deepEqual(activeTools, [
    "read",
    "bash",
    "wui_load",
    "wui",
    "wui_get_component_docs",
    "wui_upload_assets",
    "wui_read_state",
    "wui_update_state",
  ]);
});

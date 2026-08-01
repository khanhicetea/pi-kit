#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Assert } from "typebox/value";
import packageJson from "../package.json" with { type: "json" };
import { type CreateViewResult, type WuiEndpoint, WuiServer } from "./server";
import { getComponentDocumentation, listCatalogComponents } from "./shared/component-docs";
import type { PortalView, WuiInputResult, WuiSubmission } from "./shared/protocol";
import {
  ComponentDocsParameters,
  type ComponentDocsParams,
  EmptyParameters,
  ReadEventsParameters,
  type ReadEventsParams,
  ReadStateParameters,
  type ReadStateParams,
  UpdateStateParameters,
  type UpdateStateParams,
  UploadAssetsParameters,
  type UploadAssetsParams,
  WaitForFeedbackParameters,
  type WaitForFeedbackParams,
  WUI_COMPONENT_DOCS_DESCRIPTION,
  WUI_READ_STATE_DESCRIPTION,
  WUI_TOOL_DESCRIPTION,
  WUI_UPDATE_STATE_DESCRIPTION,
  WUI_UPLOAD_ASSETS_DESCRIPTION,
  WuiParameters,
  type WuiParams,
} from "./tool-contracts";
import { feedbackResult, stateResult, WuiServiceAdapter } from "./wui-service";

const VERSION = packageJson.version;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../dist/web", import.meta.url));
const DESIGN_SKILL_PATH = fileURLToPath(new URL("../skills/wui-design/SKILL.md", import.meta.url));
const CATALOG_REFERENCE_PATH = fileURLToPath(new URL("../skills/wui-design/references/catalog.md", import.meta.url));
const MAX_AGENT_RESULT_CHARS = 32_000;
const MAX_QUEUED_EVENTS = 100;

interface PendingFeedback {
  controller: AbortController;
  promise: Promise<WuiInputResult>;
}

export interface McpWuiServiceOptions {
  staticDir?: string;
  cwd?: string;
  sessionId?: string;
  sessionName?: string;
  agentName?: string;
  cloudflareTunnel?: boolean;
  onWarning?: (message: string) => void;
}

export class McpWuiService {
  private readonly options: Required<Pick<McpWuiServiceOptions, "staticDir" | "cwd" | "sessionId">> &
    Omit<McpWuiServiceOptions, "staticDir" | "cwd" | "sessionId">;
  private readonly pendingFeedback = new Map<string, PendingFeedback>();
  private readonly passiveSubmissions: Array<{ view: string; submission: WuiSubmission }> = [];
  private readonly adapter: WuiServiceAdapter;
  private server: WuiServer | undefined;
  private starting: Promise<WuiServer> | undefined;

  constructor(options: McpWuiServiceOptions = {}) {
    this.options = {
      staticDir: options.staticDir ?? DEFAULT_STATIC_DIR,
      cwd: options.cwd ?? process.env.WUI_CWD ?? process.cwd(),
      sessionId: options.sessionId ?? randomUUID(),
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
      ...(options.agentName ? { agentName: options.agentName } : {}),
      ...(options.cloudflareTunnel !== undefined ? { cloudflareTunnel: options.cloudflareTunnel } : {}),
      ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    };
    this.adapter = new WuiServiceAdapter(
      () => this.ensureServer(),
      () => this.requireServer(),
    );
  }

  get endpoint(): WuiEndpoint | undefined {
    return this.server?.endpoint;
  }

  get isRunning(): boolean {
    return this.server?.isRunning === true;
  }

  get hasAuthenticatedBrowser(): boolean {
    return this.server?.hasAuthenticatedBrowser === true;
  }

  setAgentName(agentName: string): void {
    if (!this.server) this.options.agentName = agentName;
  }

  async createView(params: WuiParams): Promise<CreateViewResult> {
    const feedbackController = params.feedback ? new AbortController() : undefined;
    const created = await this.adapter.createView(params, feedbackController?.signal);
    if (created.feedback) {
      this.pendingFeedback.get(created.id)?.controller.abort();
      this.pendingFeedback.set(created.id, {
        controller: feedbackController!,
        promise: created.feedback,
      });
    }
    return created;
  }

  async uploadAssets(params: UploadAssetsParams) {
    return this.adapter.uploadAssets(params);
  }

  readState(params: ReadStateParams) {
    return this.adapter.readState(params);
  }

  updateState(params: UpdateStateParams) {
    return this.adapter.updateState(params);
  }

  async waitForFeedback(params: WaitForFeedbackParams, signal: AbortSignal): Promise<WuiInputResult> {
    const viewId = params.viewId ?? this.onlyPendingViewId();
    const pending = this.pendingFeedback.get(viewId);
    if (!pending) throw new Error(`There is no pending feedback request for view ${viewId}.`);

    const abort = () => pending.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await pending.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.pendingFeedback.get(viewId) === pending) this.pendingFeedback.delete(viewId);
    }
  }

  readEvents(params: ReadEventsParams) {
    const events = structuredClone(this.passiveSubmissions);
    if (params.clear !== false) this.passiveSubmissions.length = 0;
    return events;
  }

  status() {
    return {
      running: this.isRunning,
      browserConnected: this.hasAuthenticatedBrowser,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      pendingFeedbackViewIds: [...this.pendingFeedback.keys()],
      queuedEventCount: this.passiveSubmissions.length,
    };
  }

  async stop(reason = "MCP coding-agent session ended"): Promise<void> {
    for (const pending of this.pendingFeedback.values()) pending.controller.abort();
    this.pendingFeedback.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await server.stop(reason);
  }

  private async ensureServer(): Promise<WuiServer> {
    if (this.server?.isRunning) return this.server;
    if (this.starting) return this.starting;

    const instance = new WuiServer({
      staticDir: this.options.staticDir,
      sessionId: this.options.sessionId,
      agentName: this.options.agentName ?? "Coding agent",
      ...(this.options.sessionName ? { sessionName: this.options.sessionName } : {}),
      cwd: this.options.cwd,
      cloudflareTunnel:
        this.options.cloudflareTunnel ??
        ((process.env.WUI_CF_TUNNEL ?? process.env.PI_WUI_CF_TUNNEL) !== undefined &&
          (process.env.WUI_CF_TUNNEL ?? process.env.PI_WUI_CF_TUNNEL) !== "0"),
      onWarning: this.options.onWarning ?? ((message) => console.error(`[pi-wui] ${message}`)),
      onSubmission: (submission, view) => this.queueSubmission(submission, view),
    });
    this.server = instance;
    this.starting = instance
      .start()
      .then(() => instance)
      .catch((error) => {
        if (this.server === instance) this.server = undefined;
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  private requireServer(): WuiServer {
    if (!this.server?.isRunning) throw new Error("There is no active Web UI view. Present a view first.");
    return this.server;
  }

  private onlyPendingViewId(): string {
    const ids = [...this.pendingFeedback.keys()];
    if (ids.length === 0) throw new Error("There is no pending Web UI feedback request.");
    if (ids.length > 1)
      throw new Error(`More than one feedback request is pending. Specify viewId: ${ids.join(", ")}.`);
    return ids[0]!;
  }

  private queueSubmission(submission: WuiSubmission, view: PortalView): void {
    if (submission.requestId && this.pendingFeedback.has(view.id)) return;
    this.passiveSubmissions.push({ view: view.title, submission });
    if (this.passiveSubmissions.length > MAX_QUEUED_EVENTS) this.passiveSubmissions.shift();
  }
}

function tool(name: string, description: string, inputSchema: object): Tool {
  return { name, description, inputSchema: inputSchema as Tool["inputSchema"] };
}

export function createWuiMcpServer(options: McpWuiServiceOptions = {}) {
  const service = new McpWuiService(options);
  const mcp = new Server(
    { name: "pi-wui", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Call wui_get_design_guide before composing a view. The guide covers common components; call wui_get_component_docs only for selected less-common components. Use wui to present browser views. When wui returns status=waiting, give the URL to the user and then call wui_wait_for_feedback.",
    },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      tool(
        "wui_get_design_guide",
        "Read the bundled WUI design workflow and common-component catalog. Call this before composing a view.",
        EmptyParameters,
      ),
      tool("wui_get_component_docs", WUI_COMPONENT_DOCS_DESCRIPTION, ComponentDocsParameters),
      tool(
        "wui",
        `${WUI_TOOL_DESCRIPTION} MCP returns the portal URL immediately; when status is waiting, call wui_wait_for_feedback next.`,
        WuiParameters,
      ),
      tool(
        "wui_wait_for_feedback",
        "Wait for submit, cancel, timeout, or agent cancellation on a view previously presented with feedback.",
        WaitForFeedbackParameters,
      ),
      tool("wui_upload_assets", WUI_UPLOAD_ASSETS_DESCRIPTION, UploadAssetsParameters),
      tool("wui_read_state", WUI_READ_STATE_DESCRIPTION, ReadStateParameters),
      tool("wui_update_state", WUI_UPDATE_STATE_DESCRIPTION, UpdateStateParameters),
      tool(
        "wui_read_events",
        "Read passive button submissions received since the previous event read. Interactive forms should use wui feedback instead.",
        ReadEventsParameters,
      ),
      tool(
        "wui_status",
        "Show whether Web UI is running and return its primary and fallback capability URLs.",
        EmptyParameters,
      ),
      tool("wui_stop", "Stop Web UI and discard pending feedback for this coding-agent session.", EmptyParameters),
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};
    try {
      switch (request.params.name) {
        case "wui_get_design_guide": {
          Assert(EmptyParameters, args);
          return result({
            guide: readFileSync(DESIGN_SKILL_PATH, "utf8"),
            catalog: readFileSync(CATALOG_REFERENCE_PATH, "utf8"),
          });
        }
        case "wui_get_component_docs": {
          Assert(ComponentDocsParameters, args);
          const params = args as ComponentDocsParams;
          return result({
            components: getComponentDocumentation(params.components),
            index: listCatalogComponents(),
          });
        }
        case "wui": {
          Assert(WuiParameters, args);
          const created = await service.createView(args);
          const endpoint = service.endpoint!;
          return result({
            status: created.feedback ? "waiting" : "presented",
            viewId: created.id,
            revision: created.revision,
            title: created.title,
            assets: created.assets,
            url: endpoint.url,
            fallbackUrl: endpoint.fallbackUrl,
            ...(created.feedback ? { next: "Open the URL for the user, then call wui_wait_for_feedback." } : {}),
          });
        }
        case "wui_wait_for_feedback": {
          Assert(WaitForFeedbackParameters, args);
          const feedback = await service.waitForFeedback(args, extra.signal);
          return result(feedbackResult(feedback));
        }
        case "wui_upload_assets": {
          Assert(UploadAssetsParameters, args);
          return result({ assets: await service.uploadAssets(args) });
        }
        case "wui_read_state": {
          Assert(ReadStateParameters, args);
          const state = service.readState(args);
          return result(stateResult(state, args.path));
        }
        case "wui_update_state": {
          Assert(UpdateStateParameters, args);
          const state = service.updateState(args);
          return result({
            status: "updated",
            viewId: state.id,
            revision: state.revision,
            title: state.title,
            operationCount: args.operations.length,
          });
        }
        case "wui_read_events": {
          Assert(ReadEventsParameters, args);
          return result({ events: service.readEvents(args) });
        }
        case "wui_status": {
          Assert(EmptyParameters, args);
          return result(service.status());
        }
        case "wui_stop": {
          Assert(EmptyParameters, args);
          await service.stop("Stopped by wui_stop");
          return result({ status: "stopped" });
        }
        default:
          return errorResult(`Unknown Web UI tool: ${request.params.name}`);
      }
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  });

  return { mcp, service };
}

function result(value: Record<string, unknown>): CallToolResult {
  const text = truncate(JSON.stringify(value, null, 2));
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function truncate(value: string): string {
  if (value.length <= MAX_AGENT_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_AGENT_RESULT_CHARS)}\n[Result truncated for agent context]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferAgentName(clientName: string | undefined): string {
  const override = process.env.WUI_AGENT_NAME?.trim();
  if (override) return override;
  const normalized = clientName?.toLowerCase() ?? "";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("claude")) return "Claude Code";
  return clientName?.trim() || "Coding agent";
}

async function main(): Promise<void> {
  const { mcp, service } = createWuiMcpServer({
    sessionName: process.env.WUI_SESSION_NAME ?? basename(process.cwd()),
  });
  mcp.oninitialized = () => {
    service.setAgentName(inferAgentName(mcp.getClientVersion()?.name));
  };
  mcp.onclose = () => {
    void service.stop();
  };
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const shutdown = async () => {
    await service.stop();
    await mcp.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[pi-wui] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

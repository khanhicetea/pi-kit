import { fileURLToPath } from "node:url";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { canOpenBrowser, isCmuxShell } from "./host-capabilities";
import { type UploadedAsset, type WuiEndpoint, WuiServer } from "./server";
import { getComponentDocumentation, listCatalogComponents } from "./shared/component-docs";
import type { WuiSubmission } from "./shared/protocol";
import {
  ComponentDocsParameters,
  ReadStateParameters,
  UpdateStateParameters,
  UploadAssetsParameters,
  WUI_COMPONENT_DOCS_DESCRIPTION,
  WUI_READ_STATE_DESCRIPTION,
  WUI_TOOL_DESCRIPTION,
  WUI_UPDATE_STATE_DESCRIPTION,
  WUI_UPLOAD_ASSETS_DESCRIPTION,
  WuiParameters,
} from "./tool-contracts";
import { stateResult, WuiServiceAdapter } from "./wui-service";

const STATIC_DIR = fileURLToPath(new URL("../dist/web", import.meta.url));
const STATUS_ID = "pi-wui";
const MAX_AGENT_SUBMISSION_CHARS = 32_000;
const WUI_LOADER_TOOL = "wui_load";
const WUI_LAZY_TOOLS = [
  "wui",
  "wui_get_component_docs",
  "wui_upload_assets",
  "wui_read_state",
  "wui_update_state",
] as const;

interface UploadAssetsToolDetails {
  assets: UploadedAsset[];
}

interface ToolDetails {
  viewId?: string;
  revision?: number;
  title?: string;
  assets?: Record<string, string>;
  status: "presented" | "waiting" | "submitted" | "cancelled" | "timed-out" | "session-ended" | "aborted";
  submission?: WuiSubmission;
}

export default function piWui(pi: ExtensionAPI) {
  const cloudflareTunnel = process.env.PI_WUI_CF_TUNNEL !== undefined && process.env.PI_WUI_CF_TUNNEL !== "0";
  let server: WuiServer | undefined;
  let starting: Promise<WuiServer> | undefined;
  let activeContext: ExtensionContext | undefined;
  let hasOfferedToOpenFirstView = false;
  const service = new WuiServiceAdapter(
    async () => {
      if (!activeContext) throw new Error("Pi Web UI is not attached to an active session.");
      return ensureServer(activeContext);
    },
    () => {
      if (!server?.isRunning) throw new Error("There is no active Web UI view. Present a view first.");
      return server;
    },
  );

  pi.registerFlag("wui", {
    description: "Start Pi Web UI eagerly for this session",
    type: "boolean",
    default: false,
  });

  async function handlePassiveSubmission(submission: WuiSubmission, title: string): Promise<void> {
    const ctx = activeContext;
    if (!ctx) return;
    const serialized = JSON.stringify(
      {
        source: "pi-wui",
        view: title,
        action: submission.params,
        formState: submission.state,
      },
      null,
      2,
    );
    const message = `Web UI submission from the user:\n${truncateForAgent(serialized)}`;
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  async function ensureServer(ctx: ExtensionContext): Promise<WuiServer> {
    activeContext = ctx;
    if (server?.isRunning) return server;
    if (starting) return starting;

    const sessionName = pi.getSessionName();
    const instance = new WuiServer({
      staticDir: STATIC_DIR,
      sessionId: ctx.sessionManager.getSessionId(),
      agentName: "Pi",
      ...(sessionName ? { sessionName } : {}),
      cwd: ctx.cwd,
      cloudflareTunnel,
      onWarning: (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(`[pi-wui] ${message}`);
      },
      onSubmission: (submission, view) => handlePassiveSubmission(submission, view.title),
    });
    server = instance;
    starting = instance
      .start()
      .then(() => instance)
      .catch((error) => {
        if (server === instance) server = undefined;
        throw error;
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  }

  async function stopServer(reason: string): Promise<void> {
    const current = server;
    server = undefined;
    if (current) await current.stop(reason);
  }

  function updateStatus(ctx: ExtensionContext, endpoint: WuiEndpoint | undefined): void {
    if (!ctx.hasUI) return;
    if (!endpoint) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const label = `${ctx.ui.theme.fg("accent", "◉ WUI")} ${ctx.ui.theme.fg("dim", `${endpoint.word}:${endpoint.port}`)}`;
    ctx.ui.setStatus(
      STATUS_ID,
      ctx.mode === "tui" ? terminalLink(endpoint.url, label) : `WUI ${endpoint.word}:${endpoint.port}`,
    );
  }

  async function startForContext(ctx: ExtensionContext, notify: boolean): Promise<WuiServer> {
    const current = await ensureServer(ctx);
    updateStatus(ctx, current.endpoint);
    if (notify && current.endpoint && ctx.hasUI) {
      ctx.ui.notify(`Pi Web UI: ${current.endpoint.url}`, "info");
    }
    return current;
  }

  async function offerToOpenFirstViewInTui(ctx: ExtensionContext, current: WuiServer): Promise<void> {
    if (ctx.mode !== "tui" || hasOfferedToOpenFirstView) return;
    hasOfferedToOpenFirstView = true;

    const endpoint = current.endpoint;
    if (!endpoint || current.hasAuthenticatedBrowser) return;

    const canOpen = canOpenBrowser();
    const openDestination = isCmuxShell() ? "a cmux browser split" : "your default browser";
    const confirmed = await ctx.ui.confirm(
      canOpen ? "Open Pi Web UI?" : "Copy Pi Web UI URL?",
      canOpen
        ? `The first Web UI view is ready.\n\n${endpoint.url}\n\nOpen it in ${openDestination}?`
        : `The first Web UI view is ready, but this host has no graphical browser.\n\n${endpoint.url}\n\nCopy the URL to your clipboard?`,
    );
    if (!confirmed || current.hasAuthenticatedBrowser) return;

    if (!canOpen) {
      try {
        await copyToClipboard(endpoint.url);
        ctx.ui.notify("Copied Pi Web UI URL", "info");
      } catch {
        ctx.ui.notify(`Could not copy URL. Use ${endpoint.url}`, "warning");
      }
      return;
    }

    const result = await openUrl(pi, endpoint.url);
    if (result.code !== 0) {
      ctx.ui.notify(`Could not open browser. Use ${endpoint.url}`, "warning");
      return;
    }
    ctx.ui.notify("Opened Pi Web UI", "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    hasOfferedToOpenFirstView = false;

    // Keep the full WUI schemas out of ordinary model requests. The small
    // loader activates them additively, enabling native deferred loading on
    // providers that support it while preserving every other active tool.
    const initialTools = pi
      .getActiveTools()
      .filter((name) => !WUI_LAZY_TOOLS.includes(name as (typeof WUI_LAZY_TOOLS)[number]));
    pi.setActiveTools([...new Set([...initialTools, WUI_LOADER_TOOL])]);

    // Keep ordinary sessions free of sockets and startup work. The presentation
    // tools and /wui command start the server on demand; --wui remains an
    // explicit eager-start escape hatch.
    if (!pi.getFlag("wui")) return;
    try {
      await startForContext(ctx, true);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Pi Web UI failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    activeContext = ctx;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    updateStatus(ctx, undefined);
    activeContext = undefined;
    await stopServer(`Pi session ended (${event.reason})`);
  });

  pi.registerCommand("wui", {
    description: "Show, open, restart, or stop Pi Web UI",
    getArgumentCompletions: (prefix) =>
      ["open", "restart", "stop", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "stop") {
        await stopServer("Stopped with /wui stop");
        updateStatus(ctx, undefined);
        ctx.ui.notify("Pi Web UI stopped", "info");
        return;
      }
      if (action === "restart") {
        await stopServer("Restarted with /wui restart");
      }
      if (!["status", "open", "restart"].includes(action)) {
        ctx.ui.notify("Usage: /wui [status|open|restart|stop]", "warning");
        return;
      }

      try {
        const current = await startForContext(ctx, false);
        const endpoint = current.endpoint!;
        if (action === "open") {
          if (!canOpenBrowser()) {
            try {
              await copyToClipboard(endpoint.url);
              ctx.ui.notify("This host has no graphical browser. Copied Pi Web UI URL instead.", "info");
            } catch {
              ctx.ui.notify(`This host has no graphical browser. Use ${endpoint.url}`, "warning");
            }
            return;
          }
          const result = await openUrl(pi, endpoint.url);
          if (result.code !== 0) {
            ctx.ui.notify(`Could not open browser. Use ${endpoint.url}`, "warning");
            return;
          }
          ctx.ui.notify("Opened Pi Web UI", "info");
          return;
        }
        ctx.ui.notify(`Pi Web UI: ${endpoint.url}\nFallback: ${endpoint.fallbackUrl}`, "info");
      } catch (error) {
        ctx.ui.notify(`Pi Web UI failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: WUI_LOADER_TOOL,
    label: "Load Web UI Tools",
    description:
      "Enable Pi Web UI tools, including targeted component discovery and wui_upload_assets for local images and fonts. Call this before asking three or more questions at once, conducting a survey/intake/discovery questionnaire, or fulfilling an explicit browser-form request; then use wui with feedback instead of listing questions in chat. Also use for dashboards, reports, and web/mobile prototypes. Load the wui-design skill before composing a view.",
    promptSnippet:
      "Call wui_load for surveys, intake/discovery, explicit form requests, three or more user questions, or browser-suited dashboards, reports, and prototypes",
    promptGuidelines: [
      "Call wui_load before asking the user three or more questions, running a survey/intake/discovery questionnaire, or fulfilling an explicit form request; then use wui with feedback instead of listing the questions in chat.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const active = pi.getActiveTools();
      const added = WUI_LAZY_TOOLS.filter((name) => !active.includes(name));
      pi.setActiveTools([...new Set([...active, ...added])]);
      return {
        content: [
          {
            type: "text",
            text:
              added.length > 0
                ? `Loaded tools: ${added.join(", ")}. Read the wui-design skill before calling wui; use wui_get_component_docs only when that guide does not document a less-common component you need. For surveys, intake, or three or more questions, use wui with feedback instead of asking in chat.`
                : "Pi Web UI tools are already loaded. Read the wui-design skill before calling wui; use wui_get_component_docs only when that guide does not document a less-common component you need. For surveys, intake, or three or more questions, use wui with feedback instead of asking in chat.",
          },
        ],
        details: { added },
      };
    },
  });

  pi.registerTool({
    name: "wui_get_component_docs",
    label: "Web UI Component Docs",
    description: WUI_COMPONENT_DOCS_DESCRIPTION,
    parameters: ComponentDocsParameters,
    async execute(_toolCallId, params) {
      const components = getComponentDocumentation(params.components);
      const index = listCatalogComponents();
      return {
        content: [{ type: "text", text: truncateForAgent(JSON.stringify({ components }, null, 2)) }],
        details: { components, index },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wui_get_component_docs "))}${theme.fg("muted", args.components.join(", "))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as { components?: unknown[] } | undefined;
      const count = details?.components?.length ?? 0;
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("muted", `Loaded docs for ${count} component${count === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "wui",
    label: "Web UI",
    description: WUI_TOOL_DESCRIPTION,
    parameters: WuiParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const current = await startForContext(ctx, false);
      const created = await service.createView(params, signal);

      updateStatus(ctx, current.endpoint);
      if (params.feedback) {
        onUpdate?.({
          content: [{ type: "text", text: `The view “${created.title}” is ready in Pi Web UI. Waiting for feedback…` }],
          details: {
            viewId: created.id,
            revision: created.revision,
            title: created.title,
            assets: created.assets,
            status: "waiting",
          } satisfies ToolDetails,
        });
        if (ctx.hasUI) ctx.ui.notify(`Web UI feedback requested: ${created.title}`, "info");
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Web UI ready: ${created.title}`, "info");
      }
      await offerToOpenFirstViewInTui(ctx, current);

      if (!created.feedback) {
        const htmlSummary = params.html?.length
          ? ` with ${params.html.length} sandboxed HTML preview${params.html.length === 1 ? "" : "s"}`
          : "";
        return {
          content: [
            { type: "text", text: `Presented “${created.title}”${htmlSummary} in Pi Web UI (view ${created.id}).` },
          ],
          details: {
            viewId: created.id,
            revision: created.revision,
            title: created.title,
            assets: created.assets,
            status: "presented",
          } satisfies ToolDetails,
        };
      }

      const result = await created.feedback;
      if (result.status === "submitted") {
        const serialized = JSON.stringify({ params: result.params, state: result.state }, null, 2);
        return {
          content: [{ type: "text", text: `User submitted Web UI feedback:\n${truncateForAgent(serialized)}` }],
          details: {
            viewId: result.viewId,
            revision: created.revision,
            title: created.title,
            assets: created.assets,
            status: "submitted",
            submission: result,
          } satisfies ToolDetails,
        };
      }

      const status = result.status === "session-ended" ? "session-ended" : result.status;
      return {
        content: [{ type: "text", text: `Web UI feedback ${result.status}.` }],
        details: {
          viewId: result.viewId,
          revision: created.revision,
          title: created.title,
          assets: created.assets,
          status,
        } satisfies ToolDetails,
      };
    },
    renderCall(args, theme) {
      const kind = args.feedback ? "feedback" : args.spec && args.html ? "mixed" : args.html ? "HTML" : "catalog";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wui "))}${theme.fg("muted", `${args.title} · ${kind}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as ToolDetails | undefined;
      if (isPartial || details?.status === "waiting") {
        return new Text(
          `${theme.fg("warning", "◉")} ${theme.fg("muted", `View ready — waiting for feedback${details?.title ? `: ${details.title}` : ""}`)}`,
          0,
          0,
        );
      }
      if (details?.status === "presented") {
        return new Text(
          `${theme.fg("success", "✓")} ${theme.fg("muted", `Presented ${details.title ?? "view"}`)}`,
          0,
          0,
        );
      }
      if (details?.status === "submitted") {
        return new Text(`${theme.fg("success", "✓")} ${theme.fg("muted", "User submitted feedback")}`, 0, 0);
      }
      return new Text(theme.fg("warning", `Feedback ${details?.status ?? "ended"}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "wui_upload_assets",
    label: "Web UI Upload Assets",
    description: WUI_UPLOAD_ASSETS_DESCRIPTION,
    parameters: UploadAssetsParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = await startForContext(ctx, false);
      const assets = await service.uploadAssets(params);
      updateStatus(ctx, current.endpoint);
      return {
        content: [
          {
            type: "text",
            text: `Uploaded ${assets.length} Web UI asset${assets.length === 1 ? "" : "s"}. Use each assetId as the exact src in a later wui spec:\n${JSON.stringify(assets, null, 2)}`,
          },
        ],
        details: { assets } satisfies UploadAssetsToolDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wui_upload_assets "))}${theme.fg("muted", `${args.paths.length} file${args.paths.length === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as UploadAssetsToolDetails | undefined;
      const count = details?.assets.length ?? 0;
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("muted", `Uploaded ${count} asset${count === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "wui_read_state",
    label: "Web UI Read State",
    description: WUI_READ_STATE_DESCRIPTION,
    parameters: ReadStateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = service.readState(params);
      const serialized = JSON.stringify(stateResult(result, params.path), null, 2);
      return {
        content: [{ type: "text", text: truncateForAgent(serialized) }],
        details: {
          viewId: result.id,
          revision: result.revision,
          title: result.title,
          status: "read",
          ...(params.path !== undefined ? { path: params.path } : {}),
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wui_read_state "))}${theme.fg("muted", args.path ?? args.viewId ?? "active view")}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as { viewId?: string; revision?: number } | undefined;
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("muted", `Read state${details?.viewId ? ` from ${details.viewId}` : ""}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "wui_update_state",
    label: "Web UI Update State",
    description: WUI_UPDATE_STATE_DESCRIPTION,
    parameters: UpdateStateParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = service.updateState(params);
      return {
        content: [
          {
            type: "text",
            text: `Updated ${params.operations.length} state path${params.operations.length === 1 ? "" : "s"} in “${result.title}” (view ${result.id}, revision ${result.revision}).`,
          },
        ],
        details: {
          viewId: result.id,
          revision: result.revision,
          title: result.title,
          status: "updated",
          operationCount: params.operations.length,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("wui_update_state "))}${theme.fg("muted", `${args.operations.length} operation${args.operations.length === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as { title?: string; status?: string } | undefined;
      return new Text(
        details?.status === "updated"
          ? `${theme.fg("success", "✓")} ${theme.fg("muted", `Updated ${details.title ?? "view state"}`)}`
          : theme.fg("error", "Pi Web UI state update failed"),
        0,
        0,
      );
    },
  });
}

function terminalLink(url: string, label: string): string {
  const safeUrl = url.replace(/[\u0000-\u001f\u007f]/g, "");
  return `\u001b]8;;${safeUrl}\u0007${label}\u001b]8;;\u0007`;
}

async function openUrl(pi: ExtensionAPI, url: string) {
  if (isCmuxShell()) return pi.exec("cmux", ["browser", "open-split", url]);
  if (process.platform === "darwin") return pi.exec("open", [url]);
  if (process.platform === "win32") return pi.exec("cmd", ["/c", "start", "", url]);
  return pi.exec("xdg-open", [url]);
}

function truncateForAgent(value: string): string {
  if (value.length <= MAX_AGENT_SUBMISSION_CHARS) return value;
  return `${value.slice(0, MAX_AGENT_SUBMISSION_CHARS)}\n[Submission truncated for agent context]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

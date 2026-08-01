import { randomBytes, randomInt } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { basename, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { Spec, StateModel } from "@json-render/core";
import { getByPath, removeByPath, setByPath, validateSpec } from "@json-render/core";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type AssetFileInput,
  AssetHtmlStager,
  type HtmlFileAttachmentInput,
  type HtmlFilePreviewInput,
  MAX_ASSET_VIEW_BYTES,
  MAX_ASSETS_PER_VIEW,
  type StagedAsset,
  type StagedHtml,
  type UploadedAsset,
} from "./server-assets";
import { HttpSecurityRouter } from "./server-http";
import { SessionProtocol } from "./server-protocol";
import { TunnelLifecycle } from "./server-tunnel";
import { ViewFeedbackStore } from "./server-view-store";
import { normalizeWuiSpec, wuiCatalog } from "./shared/catalog";
import {
  type ClientMessage,
  isRecord,
  type PortalSession,
  type PortalSnapshot,
  type PortalView,
  type PortalViewSummary,
  PROTOCOL_VERSION,
  type ServerMessage,
  type WuiInputResult,
  type WuiSubmission,
} from "./shared/protocol";

export type {
  AssetFileInput,
  HtmlFileAttachmentInput,
  HtmlFilePreviewInput,
  HtmlPreviewViewport,
  UploadedAsset,
} from "./server-assets";
export { WUI_SAFE_WEB_ASSET_EXTENSIONS } from "./server-assets";

const PORT_MIN = 10_000;
const PORT_MAX = 20_000;
const MAX_PORT_ATTEMPTS = 128;
const MAX_SPEC_BYTES = 512 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_ELEMENTS = 500;
const MAX_VIEWS = 20;
const MAX_RECENT_EVENTS = 500;
const WUI_CUSTOM_COMPONENTS = new Set([
  "Markdown",
  "Code",
  "HtmlPreview",
  "Metric",
  "KeyValue",
  "BarChart",
  "LineChart",
  "AreaChart",
  "DonutChart",
  "Sparkline",
]);
const HEARTBEAT_INTERVAL_MS = 30_000;

// This document is intentionally separate from the authenticated portal. It
// receives raw HTML only through postMessage after the parent has authenticated,
// then places it in a second sandbox so generated code cannot reach this bridge.
const SIX_LETTER_WORDS = [
  "almond",
  "anchor",
  "autumn",
  "bamboo",
  "breeze",
  "bright",
  "bronze",
  "candle",
  "canyon",
  "cedars",
  "cherry",
  "circle",
  "clouds",
  "cobalt",
  "comets",
  "corals",
  "cosmos",
  "citrus",
  "dahlia",
  "dynamo",
  "embers",
  "falcon",
  "forest",
  "galaxy",
  "garden",
  "gentle",
  "ginger",
  "glider",
  "golden",
  "harbor",
  "hazels",
  "island",
  "jasper",
  "jungle",
  "lagoon",
  "lilacs",
  "maples",
  "marble",
  "meadow",
  "meteor",
  "nebula",
  "orange",
  "orchid",
  "pebble",
  "pepper",
  "petals",
  "planet",
  "quartz",
  "ripple",
  "rocket",
  "scarab",
  "shadow",
  "silver",
  "spruce",
  "summit",
  "sunset",
  "thrive",
  "timber",
  "valley",
  "velvet",
  "violet",
  "willow",
  "winter",
  "zephyr",
];

export interface WuiServerOptions {
  staticDir: string;
  sessionId: string;
  agentName?: string;
  sessionName?: string;
  cwd: string;
  cloudflareTunnel?: boolean;
  onWarning?: (message: string) => void;
  onSubmission?: (submission: WuiSubmission, view: PortalView) => void | Promise<void>;
}

export interface WuiEndpoint {
  port: number;
  word: string;
  hostname: string;
  url: string;
  localUrl: string;
  fallbackUrl: string;
  tunnelUrl?: string;
  tunnelHostname?: string;
}

export interface PresentViewInput {
  title: string;
  spec: unknown;
  viewId?: string;
  mode?: "replace" | "append";
}

export interface RequestInputOptions extends PresentViewInput {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PresentViewResult {
  id: string;
  revision: number;
  title: string;
}

export interface CreateViewInput {
  title: string;
  spec?: unknown;
  html?: HtmlFileAttachmentInput[];
  assets?: AssetFileInput[];
  columns?: number;
  viewId?: string;
  mode?: "replace" | "append";
  feedback?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  };
}

export interface CreateViewResult extends PresentViewResult {
  /** Logical asset IDs mapped to same-origin URLs after staging. */
  assets: Record<string, string>;
  feedback?: Promise<WuiInputResult>;
}

export interface PresentHtmlFileInput extends HtmlFilePreviewInput {
  title: string;
  viewId?: string;
  mode?: "replace" | "append";
}

export interface PresentHtmlFilesInput {
  title: string;
  previews: HtmlFilePreviewInput[];
  columns?: number;
  viewId?: string;
  mode?: "replace" | "append";
}

export interface StateUpdateOperation {
  op: "set" | "remove";
  path: string;
  value?: unknown;
}

export interface ViewStateResult {
  id: string;
  revision: number;
  title: string;
  state: StateModel;
  value?: unknown;
}

export class WuiServer {
  readonly token = randomBytes(24).toString("base64url");
  readonly word = SIX_LETTER_WORDS[randomInt(SIX_LETTER_WORDS.length)]!;

  private readonly staticDir: string;
  private readonly options: WuiServerOptions;
  private readonly store = new ViewFeedbackStore();
  private readonly protocol: SessionProtocol;
  private readonly stager: AssetHtmlStager;
  private readonly tunnel: TunnelLifecycle;
  private readonly httpRouter: HttpSecurityRouter;
  private readonly recentEvents = new Set<string>();
  private readonly recentEventQueue: string[] = [];
  private httpServer: HttpServer | undefined;
  private websocketServer: WebSocketServer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private endpointValue: WuiEndpoint | undefined;
  private startedAt = Date.now();
  private stopping = false;

  constructor(options: WuiServerOptions) {
    this.options = options;
    this.staticDir = resolve(options.staticDir);
    this.stager = new AssetHtmlStager(options.cwd, (message) => this.warn(message));
    this.protocol = new SessionProtocol({
      token: this.token,
      maxStateBytes: MAX_STATE_BYTES,
      snapshot: () => this.createSnapshot(),
      getView: (viewId) => this.store.views.get(viewId),
      onState: (view, state) => {
        view.state = state;
      },
      onAction: (socket, message, view) => this.handleAction(socket, message, view),
      serializedSize: (value) => this.serializedSize(value),
    });
    this.httpRouter = new HttpSecurityRouter(this.staticDir, this.stager, () => this.endpointValue);
    this.tunnel = new TunnelLifecycle(
      (message) => this.warn(message),
      () => {
        const endpoint = this.endpointValue;
        if (!endpoint?.tunnelUrl) return;
        endpoint.url = endpoint.localUrl;
        delete endpoint.tunnelUrl;
        delete endpoint.tunnelHostname;
        this.warn(`Cloudflare quick tunnel stopped. Web UI remains available locally at ${endpoint.localUrl}`);
      },
    );
  }

  get endpoint(): WuiEndpoint | undefined {
    return this.endpointValue;
  }

  get isRunning(): boolean {
    return this.httpServer?.listening === true;
  }

  get hasAuthenticatedBrowser(): boolean {
    return this.protocol.hasAuthenticatedBrowser;
  }

  async start(): Promise<WuiEndpoint> {
    if (this.endpointValue && this.isRunning) return this.endpointValue;
    try {
      if (!(await stat(resolve(this.staticDir, "index.html"))).isFile()) throw new Error();
    } catch {
      throw new Error(`Web UI assets not found at ${this.staticDir}. Run npm run build.`);
    }

    this.stopping = false;
    this.startedAt = Date.now();
    const server = createServer((request, response) => {
      void this.httpRouter.handle(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.httpServer = server;

    const port = await this.listenOnRandomPort(server);
    const hostname = `${this.word}-7f000001.nip.io`;
    const base = `http://${hostname}:${port}/`;
    const fallback = `http://127.0.0.1:${port}/`;
    const fragment = `#token=${encodeURIComponent(this.token)}`;
    const localUrl = `${base}${fragment}`;
    this.endpointValue = {
      port,
      word: this.word,
      hostname,
      url: localUrl,
      localUrl,
      fallbackUrl: `${fallback}${fragment}`,
    };

    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_STATE_BYTES });
    websocketServer.on("connection", (socket) => this.protocol.handleConnection(socket));
    this.websocketServer = websocketServer;

    this.heartbeat = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
    server.unref();

    if (this.options.cloudflareTunnel) {
      const tunnelBaseUrl = await this.tunnel.start(port);
      if (tunnelBaseUrl && !this.stopping && this.tunnel.running) {
        const tunnelUrl = `${tunnelBaseUrl.replace(/\/$/, "")}/${fragment}`;
        this.endpointValue.url = tunnelUrl;
        this.endpointValue.tunnelUrl = tunnelUrl;
        this.endpointValue.tunnelHostname = new URL(tunnelBaseUrl).hostname.toLowerCase();
      }
    }
    return this.endpointValue;
  }

  /**
   * Create one view that may combine catalog components, staged HTML previews,
   * and a blocking feedback request.
   */
  async createView(input: CreateViewInput): Promise<CreateViewResult> {
    if (input.feedback?.signal?.aborted) throw new Error("Web UI request was aborted.");
    if (input.spec === undefined && (!input.html || input.html.length === 0)) {
      throw new Error("Provide spec, html, or both.");
    }
    if (input.feedback && input.spec === undefined) {
      throw new Error("Feedback requires a catalog spec containing bound inputs and submit/cancel actions.");
    }
    if (input.html && input.html.length > 12) {
      throw new Error("One view can contain at most 12 HTML previews.");
    }
    if (input.assets && input.assets.length > MAX_ASSETS_PER_VIEW) {
      throw new Error(`One view can contain at most ${MAX_ASSETS_PER_VIEW} assets.`);
    }
    if (input.assets?.length && input.spec === undefined) {
      throw new Error("Logical assets require a catalog spec. Use webRoot for assets referenced by an HTML preview.");
    }
    if (input.spec !== undefined && input.columns !== undefined) {
      throw new Error("columns is only used for an HTML-only view; compose mixed layouts in spec.");
    }

    const stagedHtml: StagedHtml[] = [];
    const stagedAssets: StagedAsset[] = [];
    try {
      this.stager.validateAssetInputs(input.assets ?? []);
      let stagedAssetBytes = 0;
      for (const asset of input.assets ?? []) {
        const staged = await this.stager.stageAssetDocument(asset);
        stagedAssets.push(staged);
        stagedAssetBytes += staged.document.size;
        if (stagedAssetBytes > MAX_ASSET_VIEW_BYTES) {
          throw new Error(`Assets for one view exceed ${MAX_ASSET_VIEW_BYTES / 1024 / 1024}MB.`);
        }
      }
      for (const preview of input.html ?? []) stagedHtml.push(await this.stager.stageHtmlDocument(preview));

      const assetUrls = Object.fromEntries(
        stagedAssets.map((item) => [item.asset.id, this.stager.assetUrl(item.document)]),
      );
      const declaredAssetDocuments = new Map(stagedAssets.map((item) => [item.asset.id, item.document]));
      const resolvedAssets =
        input.spec === undefined ? undefined : this.stager.resolveAssetReferences(input.spec, declaredAssetDocuments);
      const rawSpec =
        resolvedAssets === undefined
          ? this.stager.createHtmlOnlySpec(input.title, input.html ?? [], stagedHtml, input.columns)
          : this.stager.attachHtmlDocuments(resolvedAssets.spec, input.html ?? [], stagedHtml);
      const spec = this.validateAndCloneSpec(rawSpec);
      const requestId = input.feedback ? randomBytes(12).toString("base64url") : undefined;
      const view = this.storeView({
        title: input.title,
        spec,
        ...(input.viewId ? { viewId: input.viewId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        interactive: Boolean(input.feedback),
        ...(requestId ? { requestId } : {}),
      });
      const referencedAssetIds = new Set(stagedAssets.map((item) => item.document.id));
      for (const id of resolvedAssets?.documentIds ?? []) referencedAssetIds.add(id);
      this.stager.viewAssetIds.set(view.id, referencedAssetIds);
      for (const id of resolvedAssets?.documentIds ?? []) this.stager.pendingAssetIds.delete(id);
      await this.pruneHtmlDocuments();
      await this.stager.pruneAssetDocuments();

      const feedback = requestId ? this.store.createPending(view, requestId, input.feedback!) : undefined;

      await Promise.all(stagedHtml.map((item) => this.stager.cleanupHtmlSource(item)));
      await Promise.all(stagedAssets.map((item) => this.stager.cleanupAssetSource(item)));
      this.broadcastSnapshot();
      return {
        id: view.id,
        revision: view.revision,
        title: view.title,
        assets: assetUrls,
        ...(feedback ? { feedback } : {}),
      };
    } catch (error) {
      await Promise.all(stagedHtml.map((item) => this.stager.deleteHtmlDocument(item.document.id)));
      await Promise.all(stagedAssets.map((item) => this.stager.deleteAssetDocument(item.document.id)));
      throw error;
    }
  }

  /**
   * Snapshot local passive web assets and return opaque references that can be
   * used by a later createView call. The batch is atomic and sources are kept.
   */
  async uploadAssets(paths: string[]): Promise<UploadedAsset[]> {
    if (paths.length === 0) throw new Error("Provide at least one asset path.");
    if (paths.length > MAX_ASSETS_PER_VIEW) {
      throw new Error(`One upload can contain at most ${MAX_ASSETS_PER_VIEW} assets.`);
    }

    const staged: StagedAsset[] = [];
    try {
      let stagedBytes = 0;
      for (const [index, path] of paths.entries()) {
        const label = basename(path.replace(/^@/, "")) || `upload-${index + 1}`;
        const item = await this.stager.stageAssetDocument({ id: label, path });
        staged.push(item);
        stagedBytes += item.document.size;
        if (stagedBytes > MAX_ASSET_VIEW_BYTES) {
          throw new Error(`Assets in one upload exceed ${MAX_ASSET_VIEW_BYTES / 1024 / 1024}MB.`);
        }
      }
      for (const item of staged) this.stager.pendingAssetIds.add(item.document.id);
      return staged.map((item) => ({
        path: item.sourcePath,
        filename: item.document.filename,
        assetId: `asset://${item.document.id}`,
      }));
    } catch (error) {
      await Promise.all(staged.map((item) => this.stager.deleteAssetDocument(item.document.id)));
      throw error;
    }
  }

  present(input: PresentViewInput): PresentViewResult {
    const spec = this.validateAndCloneSpec(input.spec);
    const view = this.storeView({ ...input, spec, interactive: false });
    this.stager.viewAssetIds.set(view.id, new Set());
    void this.pruneHtmlDocuments().catch((error) =>
      this.warn(`Could not prune HTML documents: ${this.errorMessage(error)}`),
    );
    void this.stager
      .pruneAssetDocuments()
      .catch((error) => this.warn(`Could not prune assets: ${this.errorMessage(error)}`));
    this.broadcastSnapshot();
    return { id: view.id, revision: view.revision, title: view.title };
  }

  async presentHtmlFile(input: PresentHtmlFileInput): Promise<PresentViewResult> {
    return this.presentHtmlFiles({
      title: input.title,
      previews: [
        {
          path: input.path,
          ...(input.webRoot ? { webRoot: input.webRoot } : {}),
          title: input.title,
          ...(input.viewport ? { viewport: input.viewport } : {}),
          ...(input.height !== undefined ? { height: input.height } : {}),
          ...(input.allowScripts !== undefined ? { allowScripts: input.allowScripts } : {}),
          ...(input.cleanupSource !== undefined ? { cleanupSource: input.cleanupSource } : {}),
        },
      ],
      ...(input.viewId ? { viewId: input.viewId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
  }

  async presentHtmlFiles(input: PresentHtmlFilesInput): Promise<PresentViewResult> {
    return this.createView({
      title: input.title,
      html: input.previews,
      ...(input.columns !== undefined ? { columns: input.columns } : {}),
      ...(input.viewId ? { viewId: input.viewId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
  }

  readState(viewId?: string, path?: string): ViewStateResult {
    const view = this.requireView(viewId);
    if (path !== undefined) this.validateStatePath(path, true);
    const state = structuredClone(view.state);
    return {
      id: view.id,
      revision: view.revision,
      title: view.title,
      state,
      ...(path !== undefined ? { value: structuredClone(getByPath(state, path)) } : {}),
    };
  }

  updateState(viewId: string | undefined, operations: StateUpdateOperation[]): ViewStateResult {
    if (operations.length === 0) throw new Error("At least one state operation is required.");
    if (operations.length > 100) throw new Error("A state update can contain at most 100 operations.");

    const view = this.requireView(viewId);
    const state = structuredClone(view.state) as Record<string, unknown>;
    for (const operation of operations) {
      this.validateStatePath(operation.path, false);
      if (operation.op === "set") {
        if (!("value" in operation)) throw new Error(`Set operation for ${operation.path} is missing a value.`);
        setByPath(state, operation.path, structuredClone(operation.value));
      } else if (operation.op === "remove") {
        removeByPath(state, operation.path);
      } else {
        throw new Error("Unknown state operation.");
      }
    }
    if (this.serializedSize(state) > MAX_STATE_BYTES) {
      throw new Error(`Web UI state exceeds ${MAX_STATE_BYTES / 1024}KB.`);
    }

    view.state = state;
    (view.spec as Spec & { state?: StateModel }).state = structuredClone(state);
    view.revision += 1;
    view.updatedAt = Date.now();
    this.broadcastSnapshot();
    return { id: view.id, revision: view.revision, title: view.title, state: structuredClone(state) };
  }

  async requestInput(options: RequestInputOptions): Promise<WuiInputResult> {
    if (options.signal?.aborted) {
      return Promise.resolve({ status: "aborted", viewId: options.viewId ?? "pending", requestId: "pending" });
    }
    const created = await this.createView({
      title: options.title,
      spec: options.spec,
      ...(options.viewId ? { viewId: options.viewId } : {}),
      mode: options.mode ?? "append",
      feedback: {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    });
    return created.feedback!;
  }

  async stop(reason = "Coding agent session ended"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    this.store.end("session-ended");

    this.protocol.close(reason);
    await this.stager.close();

    await new Promise<void>((resolveClose) => {
      if (!this.httpServer?.listening) {
        resolveClose();
        return;
      }
      this.httpServer.close(() => resolveClose());
      setTimeout(resolveClose, 500).unref();
    });

    await this.tunnel.stop();
    this.websocketServer?.close();
    this.websocketServer = undefined;
    this.httpServer = undefined;
    this.endpointValue = undefined;
  }

  private warn(message: string): void {
    try {
      if (this.options.onWarning) this.options.onWarning(message);
      else console.warn(`[pi-wui] ${message}`);
    } catch {
      console.warn(`[pi-wui] ${message}`);
    }
  }

  private async listenOnRandomPort(server: HttpServer): Promise<number> {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = randomInt(PORT_MIN, PORT_MAX + 1);
      const result = await new Promise<"listening" | "retry">((resolveAttempt, rejectAttempt) => {
        const onListening = () => {
          cleanup();
          resolveAttempt("listening");
        };
        const onError = (error: NodeJS.ErrnoException) => {
          cleanup();
          if (error.code === "EADDRINUSE" || error.code === "EACCES") {
            resolveAttempt("retry");
          } else {
            rejectAttempt(error);
          }
        };
        const cleanup = () => {
          server.off("listening", onListening);
          server.off("error", onError);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen({ host: "127.0.0.1", port, exclusive: true });
      });
      if (result === "listening") return port;
    }
    throw new Error(`Unable to find a free port between ${PORT_MIN} and ${PORT_MAX}.`);
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (
      request.url !== "/ws" ||
      !this.httpRouter.isAllowedHost(request.headers.host) ||
      !this.httpRouter.isAllowedOrigin(request.headers.origin) ||
      !this.websocketServer
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.websocketServer?.emit("connection", websocket, request);
    });
  }

  private handleAction(socket: WebSocket, message: Extract<ClientMessage, { type: "action" }>, view: PortalView): void {
    if (this.recentEvents.has(message.eventId)) {
      this.send(socket, { type: "ack", eventId: message.eventId, ok: true });
      return;
    }
    if (this.serializedSize(message.state) > MAX_STATE_BYTES) {
      this.send(socket, {
        type: "ack",
        eventId: message.eventId,
        ok: false,
        message: "Form state is too large.",
      });
      return;
    }
    if (view.requestId && message.requestId !== view.requestId) {
      this.send(socket, {
        type: "ack",
        eventId: message.eventId,
        ok: false,
        message: "This request is no longer active.",
      });
      return;
    }

    this.rememberEvent(message.eventId);
    view.state = structuredClone(message.state);
    view.updatedAt = Date.now();

    if (message.action === "cancel") {
      view.status = "cancelled";
      this.send(socket, { type: "ack", eventId: message.eventId, ok: true });
      this.broadcastSnapshot();
      if (view.requestId && this.store.pendingInputs.has(view.requestId)) {
        this.store.finish(view.requestId, {
          status: "cancelled",
          viewId: view.id,
          requestId: view.requestId,
        });
      }
      return;
    }

    view.status = "submitted";
    const submission: WuiSubmission = {
      status: "submitted",
      action: "submit",
      viewId: view.id,
      ...(view.requestId ? { requestId: view.requestId } : {}),
      params: structuredClone(message.params),
      state: structuredClone(message.state),
      submittedAt: Date.now(),
    };

    const wasPending = view.requestId ? this.store.pendingInputs.has(view.requestId) : false;
    this.send(socket, { type: "ack", eventId: message.eventId, ok: true });
    this.broadcastSnapshot();
    if (view.requestId && wasPending) this.store.finish(view.requestId, submission);

    if (!wasPending && this.options.onSubmission) {
      Promise.resolve(this.options.onSubmission(submission, structuredClone(view))).catch(() => {
        // The page already received an acknowledgement; adapter errors are reported by the host agent.
      });
    }
  }

  private storeView(input: PresentViewInput & { spec: Spec; interactive: boolean; requestId?: string }): PortalView {
    const now = Date.now();
    let id = this.normalizeViewId(input.viewId);
    // Calls without a stable viewId create history entries by default. Reusing
    // the active view must be explicit so consecutive presentations do not
    // silently overwrite earlier results in the session.
    if (!id && input.mode === "replace" && this.store.activeViewId) {
      const active = this.store.views.get(this.store.activeViewId);
      if (active && (!active.requestId || !this.store.pendingInputs.has(active.requestId))) id = active.id;
    }
    id ??= `view-${randomBytes(6).toString("base64url")}`;

    const previous = this.store.views.get(id);
    const view: PortalView = {
      id,
      title: input.title.trim().slice(0, 120) || "Web UI",
      spec: structuredClone(input.spec),
      state: structuredClone((input.spec.state ?? {}) as StateModel),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      interactive: input.interactive || this.specContainsInput(input.spec),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      status: "active",
    };
    this.store.views.delete(id);
    this.store.views.set(id, view);
    this.store.activeViewId = id;
    this.pruneViews();
    return view;
  }

  private specContainsInput(spec: Spec): boolean {
    const inputTypes = new Set(["Input", "Textarea", "Select", "Checkbox", "Radio", "Switch", "Slider"]);
    return Object.values(spec.elements).some((element) => inputTypes.has(element.type));
  }

  private validateAndCloneSpec(value: unknown): Spec {
    const size = this.serializedSize(value);
    if (size > MAX_SPEC_BYTES) throw new Error(`Web UI spec exceeds ${MAX_SPEC_BYTES / 1024}KB.`);

    const normalized = normalizeWuiSpec(value);
    const catalogResult = wuiCatalog.validate(normalized);
    if (!catalogResult.success || !catalogResult.data) {
      const issues = catalogResult.error?.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid Web UI spec: ${issues || "catalog validation failed"}`);
    }

    const spec = catalogResult.data as Spec;
    this.restoreRendererFields(spec, normalized);
    this.validateCustomComponentProps(spec);
    if (Object.keys(spec.elements).length > MAX_ELEMENTS) {
      throw new Error(`Web UI spec has more than ${MAX_ELEMENTS} elements.`);
    }
    const structural = validateSpec(spec, { checkOrphans: true });
    if (!structural.valid) {
      const issues = structural.issues
        .filter((issue) => issue.severity === "error")
        .slice(0, 8)
        .map((issue) => issue.message)
        .join("; ");
      throw new Error(`Invalid Web UI structure: ${issues}`);
    }
    return structuredClone(spec);
  }

  private validateCustomComponentProps(spec: Spec): void {
    const definitions = wuiCatalog.data.components as Record<
      string,
      {
        props: {
          safeParse: (
            value: unknown,
          ) =>
            | { success: true; data: Record<string, unknown> }
            | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
        };
      }
    >;
    for (const [key, element] of Object.entries(spec.elements)) {
      if (!WUI_CUSTOM_COMPONENTS.has(element.type)) continue;
      const result = definitions[element.type]!.props.safeParse(element.props);
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "props"}: ${issue.message}`)
          .join("; ");
        throw new Error(`Invalid ${element.type} “${key}”: ${issues}`);
      }
      element.props = result.data;
    }
  }

  private restoreRendererFields(spec: Spec, normalized: unknown): void {
    if (!isRecord(normalized)) return;
    if (isRecord(normalized.state)) {
      (spec as unknown as Record<string, unknown>).state = structuredClone(normalized.state);
    }
    if (!isRecord(normalized.elements)) return;
    for (const [key, source] of Object.entries(normalized.elements)) {
      const target = spec.elements[key];
      if (!target || !isRecord(source)) continue;
      const targetRecord = target as unknown as Record<string, unknown>;
      // Catalog validation sanitizes component props but currently strips
      // state and these renderer-level fields. Restore them before structural
      // validation so bindings, button events, and other behavior reach the browser.
      for (const field of ["on", "repeat", "watch"] as const) {
        if (field in source) targetRecord[field] = structuredClone(source[field]);
      }
    }
  }

  private createSnapshot(): PortalSnapshot {
    const endpoint = this.endpointValue;
    const session: PortalSession = {
      sessionId: this.options.sessionId,
      ...(this.options.agentName ? { agentName: this.options.agentName } : {}),
      ...(this.options.sessionName ? { sessionName: this.options.sessionName } : {}),
      projectName: basename(this.options.cwd) || this.options.cwd,
      cwd: this.options.cwd,
      word: endpoint?.word ?? this.word,
      startedAt: this.startedAt,
    };
    const views: PortalViewSummary[] = [...this.store.views.values()].reverse().map((view) => ({
      id: view.id,
      title: view.title,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      interactive: view.interactive,
      status: view.status,
    }));
    const activeView = this.store.activeViewId ? this.store.views.get(this.store.activeViewId) : undefined;
    return {
      protocolVersion: PROTOCOL_VERSION,
      session,
      views,
      activeView: activeView ? structuredClone(activeView) : null,
    };
  }

  private broadcastSnapshot(): void {
    this.broadcast({ type: "snapshot", snapshot: this.createSnapshot() });
  }

  private broadcast(message: ServerMessage): void {
    this.protocol.broadcast(message);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    this.protocol.send(socket, message);
  }

  private pruneViews(): void {
    while (this.store.views.size > MAX_VIEWS) {
      const candidate = [...this.store.views.values()].find(
        (view) => !view.requestId || !this.store.pendingInputs.has(view.requestId),
      );
      if (!candidate) return;
      this.store.views.delete(candidate.id);
      this.stager.viewAssetIds.delete(candidate.id);
    }
  }

  private async pruneHtmlDocuments(): Promise<void> {
    const referenced = new Set<string>();
    for (const view of this.store.views.values()) {
      for (const element of Object.values(view.spec.elements)) {
        if (element.type !== "HtmlPreview" || typeof element.props.src !== "string") continue;
        const match = element.props.src.match(/^\/sandbox\/([A-Za-z0-9_-]+)(?:\/.*)?$/);
        if (match) referenced.add(match[1]!);
      }
    }
    await this.stager.pruneHtmlDocuments(referenced);
  }

  private rememberEvent(eventId: string): void {
    this.recentEvents.add(eventId);
    this.recentEventQueue.push(eventId);
    while (this.recentEventQueue.length > MAX_RECENT_EVENTS) {
      const oldest = this.recentEventQueue.shift();
      if (oldest) this.recentEvents.delete(oldest);
    }
  }

  private runHeartbeat(): void {
    this.protocol.heartbeat();
  }

  private requireView(viewId?: string): PortalView {
    const id = viewId ?? this.store.activeViewId;
    const view = id ? this.store.views.get(id) : undefined;
    if (!view) throw new Error(viewId ? `Web UI view “${viewId}” was not found.` : "There is no active Web UI view.");
    return view;
  }

  private validateStatePath(path: string, allowRoot: boolean): void {
    if (path === "" && allowRoot) return;
    if (!path.startsWith("/") || path.length < 2) {
      throw new Error("State paths must be RFC 6901 JSON Pointers such as /form/name.");
    }
    const tokens = path.slice(1).split("/");
    for (const token of tokens) {
      if (/~(?:[^01]|$)/.test(token)) throw new Error(`Invalid JSON Pointer path: ${path}`);
      const decoded = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(decoded)) {
        throw new Error(`Unsafe state path: ${path}`);
      }
    }
  }

  private normalizeViewId(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
      throw new Error("viewId must contain only letters, numbers, underscores, or dashes (max 64).");
    }
    return value;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private serializedSize(value: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      throw new Error("Web UI data must be JSON-serializable.");
    }
  }
}

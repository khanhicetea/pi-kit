import { timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import {
  type ClientMessage,
  isRecord,
  type PortalSnapshot,
  type PortalView,
  parseClientMessage,
  type ServerMessage,
} from "./shared/protocol";

const AUTH_TIMEOUT_MS = 5_000;

interface AuthenticatedClient {
  authenticated: boolean;
  alive: boolean;
  authTimer: NodeJS.Timeout;
}

export interface SessionProtocolCallbacks {
  token: string;
  maxStateBytes: number;
  snapshot: () => PortalSnapshot;
  getView: (viewId: string) => PortalView | undefined;
  onState: (view: PortalView, state: Record<string, unknown>) => void;
  onAction: (socket: WebSocket, message: Extract<ClientMessage, { type: "action" }>, view: PortalView) => void;
  serializedSize: (value: unknown) => number;
}

/** Authentication, message dispatch, acknowledgements, and heartbeat lifecycle. */
export class SessionProtocol {
  private readonly clients = new Map<WebSocket, AuthenticatedClient>();
  constructor(private readonly callbacks: SessionProtocolCallbacks) {}

  get hasAuthenticatedBrowser(): boolean {
    return [...this.clients.values()].some((client) => client.authenticated);
  }

  handleConnection(socket: WebSocket): void {
    const authTimer = setTimeout(() => socket.close(4001, "authentication timeout"), AUTH_TIMEOUT_MS);
    authTimer.unref();
    this.clients.set(socket, { authenticated: false, alive: true, authTimer });
    socket.on("pong", () => {
      const client = this.clients.get(socket);
      if (client) client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "text messages only");
        return;
      }
      this.handleMessage(socket, data.toString());
    });
    socket.on("close", () => this.remove(socket));
    socket.on("error", () => this.remove(socket));
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "error", code: "invalid_json", message: "Invalid JSON message." });
      return;
    }
    const message = parseClientMessage(parsed);
    if (!message) {
      if (isRecord(parsed) && parsed.type === "action" && typeof parsed.eventId === "string")
        this.send(socket, {
          type: "ack",
          eventId: parsed.eventId,
          ok: false,
          message: "The form submission was invalid. Reload the view and try again.",
        });
      else this.send(socket, { type: "error", code: "invalid_message", message: "Invalid protocol message." });
      return;
    }
    const client = this.clients.get(socket);
    if (!client) return;
    if (!client.authenticated) {
      if (message.type !== "auth" || !this.tokenMatches(message.token)) {
        socket.close(4003, "authentication failed");
        return;
      }
      client.authenticated = true;
      clearTimeout(client.authTimer);
      this.send(socket, { type: "auth_ok", snapshot: this.callbacks.snapshot() });
      return;
    }
    if (message.type === "auth") return;
    this.handleAuthenticated(socket, message);
  }

  private handleAuthenticated(socket: WebSocket, message: Exclude<ClientMessage, { type: "auth" }>): void {
    if (message.type === "get_view") {
      const view = this.callbacks.getView(message.viewId);
      if (view) this.send(socket, { type: "view", view: structuredClone(view) });
      else this.send(socket, { type: "error", code: "view_not_found", message: "That view no longer exists." });
      return;
    }
    const view = this.callbacks.getView(message.viewId);
    if (!view || view.revision !== message.revision) {
      if (message.type === "action")
        this.send(socket, {
          type: "ack",
          eventId: message.eventId,
          ok: false,
          message: "The view changed. Refresh and try again.",
        });
      return;
    }
    if (message.type === "state_update") {
      if (this.callbacks.serializedSize(message.state) <= this.callbacks.maxStateBytes)
        this.callbacks.onState(view, structuredClone(message.state));
      return;
    }
    this.callbacks.onAction(socket, message, view);
  }

  send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  broadcast(message: ServerMessage): void {
    for (const [socket, client] of this.clients) if (client.authenticated) this.send(socket, message);
  }
  heartbeat(): void {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        socket.terminate();
        this.remove(socket);
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }
  close(reason: string): void {
    this.broadcast({ type: "session_ended", reason });
    for (const socket of this.clients.keys()) socket.close(1001, "session ended");
    this.clients.clear();
  }

  private remove(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) clearTimeout(client.authTimer);
    this.clients.delete(socket);
  }
  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.callbacks.token);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}

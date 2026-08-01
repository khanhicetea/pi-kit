import type { Spec, StateModel } from "@json-render/core";

export const PROTOCOL_VERSION = 1;

export type ViewStatus = "active" | "submitted" | "cancelled" | "timed-out";

export interface PortalSession {
  sessionId: string;
  agentName?: string;
  sessionName?: string;
  projectName: string;
  cwd: string;
  word: string;
  startedAt: number;
}

export interface PortalView {
  id: string;
  title: string;
  spec: Spec;
  state: StateModel;
  revision: number;
  createdAt: number;
  updatedAt: number;
  interactive: boolean;
  requestId?: string;
  status: ViewStatus;
}

export interface PortalViewSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  interactive: boolean;
  status: ViewStatus;
}

export interface PortalSnapshot {
  protocolVersion: number;
  session: PortalSession;
  views: PortalViewSummary[];
  activeView: PortalView | null;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "get_view"; viewId: string }
  | {
      type: "action";
      eventId: string;
      viewId: string;
      revision: number;
      requestId?: string;
      action: "submit" | "cancel";
      params: Record<string, unknown>;
      state: StateModel;
    }
  | {
      type: "state_update";
      viewId: string;
      revision: number;
      state: StateModel;
    };

export type ServerMessage =
  | { type: "auth_ok"; snapshot: PortalSnapshot }
  | { type: "snapshot"; snapshot: PortalSnapshot }
  | { type: "view"; view: PortalView }
  | { type: "ack"; eventId: string; ok: boolean; message?: string }
  | { type: "error"; code: string; message: string }
  | { type: "session_ended"; reason: string };

export interface WuiSubmission {
  status: "submitted";
  action: "submit";
  viewId: string;
  requestId?: string;
  params: Record<string, unknown>;
  state: StateModel;
  submittedAt: number;
}

export type WuiInputResult =
  | WuiSubmission
  | {
      status: "cancelled" | "timed-out" | "session-ended" | "aborted";
      viewId: string;
      requestId: string;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "auth" && typeof value.token === "string") {
    return { type: "auth", token: value.token };
  }

  if (value.type === "get_view" && typeof value.viewId === "string") {
    return { type: "get_view", viewId: value.viewId };
  }

  if (
    value.type === "state_update" &&
    typeof value.viewId === "string" &&
    typeof value.revision === "number" &&
    isRecord(value.state)
  ) {
    return {
      type: "state_update",
      viewId: value.viewId,
      revision: value.revision,
      state: value.state,
    };
  }

  if (
    value.type === "action" &&
    typeof value.eventId === "string" &&
    typeof value.viewId === "string" &&
    typeof value.revision === "number" &&
    (value.action === "submit" || value.action === "cancel") &&
    isRecord(value.params) &&
    isRecord(value.state) &&
    (value.requestId === undefined || typeof value.requestId === "string")
  ) {
    return {
      type: "action",
      eventId: value.eventId,
      viewId: value.viewId,
      revision: value.revision,
      ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
      action: value.action,
      params: value.params,
      state: value.state,
    };
  }

  return null;
}

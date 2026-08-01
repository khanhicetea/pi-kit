import type { PortalSnapshot } from "../shared/protocol";

export type SessionConnectionState = "connecting" | "live" | "reconnecting" | "ended" | "error";

const TITLE_STATUS_ICON: Record<SessionConnectionState | "attention", string> = {
  attention: "🔴",
  live: "🟢",
  connecting: "🟡",
  reconnecting: "🟡",
  ended: "⚫",
  error: "⚠️",
};

export function getSessionDocumentTitle(
  connection: SessionConnectionState,
  snapshot: PortalSnapshot | null,
  activeViewTitle?: string,
): string {
  const needsAttention =
    connection === "live" && snapshot?.views.some((view) => view.interactive && view.status === "active");
  const statusIcon = needsAttention ? TITLE_STATUS_ICON.attention : TITLE_STATUS_ICON[connection];
  const viewTitle = activeViewTitle ?? snapshot?.activeView?.title ?? "No active view";
  return `${statusIcon} ${viewTitle} - pi-wui`;
}

import type { Spec, StateModel } from "@json-render/core";
import { createStateStore, JSONUIProvider, Renderer } from "@json-render/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ClientMessage,
  type PortalSnapshot,
  type PortalView,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../shared/protocol";
import {
  activateRecentView,
  getNextRecentViewExpiry,
  pruneRecentViews,
  type RecentViewsState,
  reconcileRecentViews,
} from "./recent-views";
import {
  handlers as createRegistryHandlers,
  PORTAL_ACTION_EVENT,
  type PortalActionRequest,
  registry,
} from "./registry";
import { getSessionDocumentTitle, type SessionConnectionState } from "./session-title";

type ConnectionState = SessionConnectionState;
type ActionButtonState = PortalView["status"] | "submitting" | "cancelling";
type ThemePreference = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "pi-wui-theme";

function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "auto") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return "auto";
}

function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === "dark" || (preference === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0c0e12" : "#f5f6f8");
}

function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useLayoutEffect(() => applyTheme(preference), [preference]);
  useEffect(() => {
    if (preference !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("auto");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  const cycle = useCallback(() => {
    setPreference((current) => {
      const next: ThemePreference = current === "auto" ? "light" : current === "light" ? "dark" : "auto";
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // The selected theme still applies for the lifetime of this page.
      }
      return next;
    });
  }, []);

  return { preference, cycle };
}

interface PendingAction {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

function createEventId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function readCapabilityToken(): string | null {
  const storageKey = `pi-wui-token:${window.location.origin}`;
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (fromHash) {
    sessionStorage.setItem(storageKey, fromHash);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return fromHash;
  }
  return sessionStorage.getItem(storageKey);
}

function usePortalConnection() {
  const token = useMemo(readCapabilityToken, []);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const retryCountRef = useRef(0);
  const endedRef = useRef(false);
  const pendingActionsRef = useRef(new Map<string, PendingAction>());
  const selectedViewIdRef = useRef<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(token ? "connecting" : "error");
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null);
  const [activeView, setActiveView] = useState<PortalView | null>(null);
  const [error, setError] = useState<string | null>(
    token ? null : "Missing capability token. Reopen the link from your coding agent.",
  );

  useEffect(() => {
    if (!token) return;
    let disposed = false;

    const rejectPending = (message: string) => {
      for (const pending of pendingActionsRef.current.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      pendingActionsRef.current.clear();
    };

    const connect = () => {
      if (disposed || endedRef.current) return;
      setConnection(retryCountRef.current > 0 ? "reconnecting" : "connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "auth", token } satisfies ClientMessage));
      });

      socket.addEventListener("message", (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          setError("Received an invalid Web UI message.");
          return;
        }

        if (message.type === "auth_ok" || message.type === "snapshot") {
          if (message.snapshot.protocolVersion !== PROTOCOL_VERSION) {
            setConnection("error");
            setError("Web UI protocol version mismatch. Reload the integration and this page.");
            socket.close();
            return;
          }
          retryCountRef.current = 0;
          setConnection("live");
          setError(null);
          setSnapshot(message.snapshot);
          selectedViewIdRef.current = message.snapshot.activeView?.id ?? null;
          setActiveView(message.snapshot.activeView);
          return;
        }
        if (message.type === "view") {
          // Ignore a response for a tab that the user switched away from while
          // the request was in flight.
          if (message.view.id !== selectedViewIdRef.current) return;
          setActiveView(message.view);
          return;
        }
        if (message.type === "ack") {
          const pending = pendingActionsRef.current.get(message.eventId);
          if (!pending) return;
          pendingActionsRef.current.delete(message.eventId);
          window.clearTimeout(pending.timer);
          if (message.ok) pending.resolve();
          else pending.reject(new Error(message.message ?? "The action was rejected."));
          return;
        }
        if (message.type === "session_ended") {
          endedRef.current = true;
          setConnection("ended");
          setError(message.reason);
          rejectPending(message.reason);
          return;
        }
        if (message.type === "error") setError(message.message);
      });

      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) socketRef.current = undefined;
        rejectPending("Connection to the coding agent was lost.");
        if (disposed || endedRef.current) return;
        if (event.code === 4003) {
          setConnection("error");
          setError("Authentication failed. Reopen the current Web UI link from your coding agent.");
          return;
        }
        retryCountRef.current += 1;
        setConnection("reconnecting");
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retryCountRef.current, 5));
        retryTimerRef.current = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        // close triggers the reconnect path and provides a less noisy UX.
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
      rejectPending("Page closed.");
    };
  }, [token]);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const selectView = useCallback(
    (viewId: string, requestView: boolean): boolean => {
      const previousViewId = selectedViewIdRef.current;
      selectedViewIdRef.current = viewId;
      if (!requestView) return true;
      if (!send({ type: "get_view", viewId })) {
        selectedViewIdRef.current = previousViewId;
        setError("The coding agent is not connected yet.");
        return false;
      }
      return true;
    },
    [send],
  );

  const updateState = useCallback(
    (view: PortalView, state: StateModel) => {
      send({ type: "state_update", viewId: view.id, revision: view.revision, state });
    },
    [send],
  );

  const dispatchAction = useCallback(
    (view: PortalView, action: "submit" | "cancel", params: Record<string, unknown>, state: StateModel) => {
      const eventId = createEventId();
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingActionsRef.current.delete(eventId);
          reject(
            new Error(
              "The coding agent did not acknowledge the form submission. Check the agent session and try again.",
            ),
          );
        }, 10_000);
        pendingActionsRef.current.set(eventId, { resolve, reject, timer });
        const sent = send({
          type: "action",
          eventId,
          viewId: view.id,
          revision: view.revision,
          ...(view.requestId ? { requestId: view.requestId } : {}),
          action,
          params,
          state,
        });
        if (!sent) {
          pendingActionsRef.current.delete(eventId);
          window.clearTimeout(timer);
          reject(new Error("The coding agent is not connected yet."));
        }
      }).catch((actionError) => {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
        throw actionError;
      });
    },
    [send],
  );

  return { connection, snapshot, activeView, error, selectView, updateState, dispatchAction };
}

function ThemeToggle({ preference, onClick }: { preference: ThemePreference; onClick: () => void }) {
  const labels: Record<ThemePreference, string> = { auto: "Auto", light: "Light", dark: "Dark" };
  const icons: Record<ThemePreference, string> = { auto: "◐", light: "☀", dark: "☾" };
  const next = preference === "auto" ? "Light" : preference === "light" ? "Dark" : "Auto";
  return (
    <button
      type="button"
      className="portal-theme-toggle"
      onClick={onClick}
      aria-label={`Theme: ${labels[preference]}. Switch to ${next}`}
      title={`Theme: ${labels[preference]} · Click for ${next}`}
    >
      <span aria-hidden="true">{icons[preference]}</span>
    </button>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    connecting: "Connecting",
    live: "Live",
    reconnecting: "Reconnecting",
    ended: "Session ended",
    error: "Connection error",
  };
  return (
    <span className={`portal-connection portal-connection--${state}`}>
      <span className="portal-connection-dot" />
      <span className="portal-connection-label">{labels[state]}</span>
    </span>
  );
}

function EmptyState({ connection, agentName }: { connection: ConnectionState; agentName: string | undefined }) {
  const host = agentName ?? "coding agent";
  return (
    <div className="portal-empty">
      <div className="portal-empty-icon" aria-hidden="true">
        W
      </div>
      <h2>{connection === "live" ? `Waiting for ${host}` : `Connecting to ${host}`}</h2>
      <p>
        {connection === "live"
          ? "Visual views and forms will appear here when the agent uses Web UI."
          : "Keep this page open while the local session connects."}
      </p>
    </div>
  );
}

function ViewLoading({ agentName }: { agentName: string | undefined }) {
  return (
    <div className="portal-empty" role="status">
      <div className="portal-empty-icon portal-empty-icon--loading" aria-hidden="true">
        W
      </div>
      <h2>Loading view</h2>
      <p>Restoring the latest state from {agentName ?? "the coding agent"}…</p>
    </div>
  );
}

export function applyActionButtonUx(spec: Spec, state: ActionButtonState): Spec {
  if (state === "active") return spec;

  const next = structuredClone(spec);
  for (const element of Object.values(next.elements)) {
    if (element.type !== "Button") continue;
    const press = element.on?.press;
    if (!press || Array.isArray(press) || (press.action !== "submit" && press.action !== "cancel")) continue;

    element.props = { ...element.props, disabled: true };
    if (state === "submitting" && press.action === "submit") element.props.label = "Submitting…";
    if (state === "cancelling" && press.action === "cancel") element.props.label = "Cancelling…";
    if (state === "submitted" && press.action === "submit") element.props.label = "Submitted";
    if (state === "cancelled" && press.action === "cancel") element.props.label = "Cancelled";
    if (state === "timed-out") element.props.label = "Expired";
  }
  return next;
}

function ViewRenderer({
  view,
  active,
  updateState,
  dispatchAction,
}: {
  view: PortalView;
  active: boolean;
  updateState: (view: PortalView, state: StateModel) => void;
  dispatchAction: (
    view: PortalView,
    action: "submit" | "cancel",
    params: Record<string, unknown>,
    state: StateModel,
  ) => Promise<void>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: The renderer store intentionally resets only for a new view revision.
  const store = useMemo(() => createStateStore(view.state ?? view.spec.state ?? {}), [view.id, view.revision]);
  const [pendingAction, setPendingAction] = useState<"submit" | "cancel" | null>(null);
  const actionButtonState: ActionButtonState = pendingAction
    ? pendingAction === "submit"
      ? "submitting"
      : "cancelling"
    : view.status;
  const renderedSpec = useMemo(() => applyActionButtonUx(view.spec, actionButtonState), [actionButtonState, view.spec]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: These values intentionally trigger a pending-action reset.
  useEffect(() => {
    setPendingAction(null);
  }, [view.id, view.revision, view.status]);

  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = store.subscribe(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => updateState(view, store.getSnapshot()), 300);
    });
    return () => {
      unsubscribe();
      if (timer) window.clearTimeout(timer);
    };
  }, [store, updateState, view]);

  const actionHandlers = useMemo(
    () =>
      createRegistryHandlers(
        () => () => {},
        () => store.getSnapshot(),
      ),
    [store],
  );

  useEffect(() => {
    if (!active) return;
    const handlePortalAction = (event: Event) => {
      const request = (event as CustomEvent<PortalActionRequest>).detail;
      if (!request) return;
      request.handled = true;
      setPendingAction(request.action);
      void dispatchAction(view, request.action, request.params, request.state).then(request.resolve, (actionError) => {
        setPendingAction(null);
        request.reject(actionError);
      });
    };
    window.addEventListener(PORTAL_ACTION_EVENT, handlePortalAction);
    return () => window.removeEventListener(PORTAL_ACTION_EVENT, handlePortalAction);
  }, [active, dispatchAction, view]);

  return (
    <div className="portal-view">
      <div className="portal-render-surface">
        <JSONUIProvider key={`${view.id}:${view.revision}`} registry={registry} store={store} handlers={actionHandlers}>
          <Renderer spec={renderedSpec} registry={registry} />
        </JSONUIProvider>
      </div>
      {new URLSearchParams(window.location.search).has("debug") && (
        <details className="portal-debug">
          <summary>Raw json-render spec</summary>
          <pre>{JSON.stringify(view.spec, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export default function App() {
  const portal = usePortalConnection();
  const theme = useTheme();
  const [recentViews, setRecentViews] = useState<RecentViewsState>({
    retained: new Map(),
    selectedViewId: null,
  });
  const session = portal.snapshot?.session;
  const selectedView = recentViews.selectedViewId
    ? (recentViews.retained.get(recentViews.selectedViewId)?.view ?? null)
    : null;
  const documentTitle = getSessionDocumentTitle(portal.connection, portal.snapshot, selectedView?.title);

  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  useEffect(() => {
    if (!portal.activeView) return;
    const view = portal.activeView;
    setRecentViews((current) => {
      const retained = current.retained.get(view.id);
      // A same-revision payload contains no new renderer structure. Keep the
      // existing object so iframe/component instances are not reconstructed.
      const replacement = retained?.view.revision === view.revision ? undefined : view;
      return activateRecentView(current, view.id, Date.now(), replacement);
    });
  }, [portal.activeView]);

  useEffect(() => {
    const snapshot = portal.snapshot;
    if (!snapshot) return;
    setRecentViews((current) => reconcileRecentViews(current, snapshot.views));
  }, [portal.snapshot]);

  useEffect(() => {
    const expiresAt = getNextRecentViewExpiry(recentViews);
    if (expiresAt === null) return;
    const timer = window.setTimeout(
      () => {
        setRecentViews((current) => pruneRecentViews(current, Date.now()));
      },
      Math.max(0, expiresAt - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  }, [recentViews]);

  const selectView = useCallback(
    (viewId: string) => {
      if (viewId === recentViews.selectedViewId) return;
      const retained = recentViews.retained.has(viewId);
      // Retained views are already current and mounted. Only ask the server for
      // tabs that have fallen out of the 15-minute cache.
      if (!portal.selectView(viewId, !retained)) return;
      setRecentViews((current) => activateRecentView(current, viewId, Date.now()));
    },
    [portal.selectView, recentViews.retained, recentViews.selectedViewId],
  );

  return (
    <div className="portal-shell">
      <header className="portal-topbar">
        <div
          className="portal-brand"
          title={session ? `${session.sessionName ?? session.projectName} — ${session.cwd}` : "Web UI"}
        >
          <span className="portal-brand-mark">W</span>
          <span className="portal-session-name">{session?.sessionName ?? session?.projectName ?? "Web UI"}</span>
        </div>

        <nav className="portal-tabs" aria-label="Views">
          {portal.snapshot?.views.length ? (
            portal.snapshot.views.map((view) => {
              const isActive = view.id === recentViews.selectedViewId;
              return (
                <button
                  type="button"
                  key={view.id}
                  className={`portal-tab${isActive ? " is-active" : ""}`}
                  onClick={() => selectView(view.id)}
                  aria-current={isActive ? "page" : undefined}
                  title={`${view.title} · ${view.interactive ? "Interactive" : "View"} · ${view.status}`}
                >
                  <span
                    className={`portal-tab-dot portal-tab-dot--${view.status}${view.interactive ? " is-interactive" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="portal-tab-title">{view.title}</span>
                </button>
              );
            })
          ) : (
            <span className="portal-tabs-empty">No views</span>
          )}
        </nav>

        <div className="portal-topbar-actions">
          <ConnectionBadge state={portal.connection} />
          <ThemeToggle preference={theme.preference} onClick={theme.cycle} />
        </div>
      </header>

      <main className="portal-main">
        {portal.error && (
          <div className="portal-error" role="alert">
            {portal.error}
          </div>
        )}
        {recentViews.retained.size > 0 && (
          <div className="portal-view-cache">
            {[...recentViews.retained.values()].map(({ view }) => {
              const active = view.id === recentViews.selectedViewId;
              return (
                <div className={`portal-view-pane${active ? " is-active" : ""}`} key={view.id} aria-hidden={!active}>
                  <ViewRenderer
                    view={view}
                    active={active}
                    updateState={portal.updateState}
                    dispatchAction={portal.dispatchAction}
                  />
                </div>
              );
            })}
          </div>
        )}
        {!selectedView &&
          (recentViews.selectedViewId ? (
            <ViewLoading agentName={session?.agentName} />
          ) : (
            <EmptyState connection={portal.connection} agentName={session?.agentName} />
          ))}
      </main>
    </div>
  );
}

import type { PortalView, PortalViewSummary } from "../shared/protocol";

export const RECENT_VIEW_TTL_MS = 15 * 60 * 1_000;

export interface RetainedView {
  view: PortalView;
  lastActiveAt: number;
}

export interface RecentViewsState {
  retained: Map<string, RetainedView>;
  selectedViewId: string | null;
}

export function activateRecentView(
  state: RecentViewsState,
  viewId: string,
  now: number,
  view?: PortalView,
): RecentViewsState {
  const retained = new Map(state.retained);
  const previous = state.selectedViewId ? retained.get(state.selectedViewId) : undefined;
  if (previous) retained.set(previous.view.id, { ...previous, lastActiveAt: now });

  const target = retained.get(viewId);
  if (view) retained.set(viewId, { view, lastActiveAt: now });
  else if (target) retained.set(viewId, { ...target, lastActiveAt: now });

  return { retained, selectedViewId: viewId };
}

export function reconcileRecentViews(state: RecentViewsState, summaries: PortalViewSummary[]): RecentViewsState {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const retained = new Map(state.retained);
  let changed = false;

  for (const [id, entry] of retained) {
    const summary = byId.get(id);
    if (!summary || summary.revision !== entry.view.revision) {
      retained.delete(id);
      changed = true;
      continue;
    }

    if (
      summary.title !== entry.view.title ||
      summary.updatedAt !== entry.view.updatedAt ||
      summary.status !== entry.view.status ||
      summary.interactive !== entry.view.interactive
    ) {
      retained.set(id, { ...entry, view: { ...entry.view, ...summary } });
      changed = true;
    }
  }

  const selectedViewId = state.selectedViewId && byId.has(state.selectedViewId) ? state.selectedViewId : null;
  if (!changed && selectedViewId === state.selectedViewId) return state;
  return { retained, selectedViewId };
}

export function pruneRecentViews(state: RecentViewsState, now: number, ttl = RECENT_VIEW_TTL_MS): RecentViewsState {
  const retained = new Map(state.retained);
  let changed = false;

  for (const [id, entry] of retained) {
    if (id !== state.selectedViewId && now - entry.lastActiveAt >= ttl) {
      retained.delete(id);
      changed = true;
    }
  }

  return changed ? { ...state, retained } : state;
}

export function getNextRecentViewExpiry(state: RecentViewsState, ttl = RECENT_VIEW_TTL_MS): number | null {
  let next: number | null = null;
  for (const [id, entry] of state.retained) {
    if (id === state.selectedViewId) continue;
    const expiresAt = entry.lastActiveAt + ttl;
    if (next === null || expiresAt < next) next = expiresAt;
  }
  return next;
}

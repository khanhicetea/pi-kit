import assert from "node:assert/strict";
import test from "node:test";
import type { Spec } from "@json-render/core";
import type { PortalView } from "../src/shared/protocol";
import {
  activateRecentView,
  pruneRecentViews,
  RECENT_VIEW_TTL_MS,
  type RecentViewsState,
  reconcileRecentViews,
} from "../src/web/recent-views";

const spec: Spec = {
  root: "text",
  state: {},
  elements: {
    text: { type: "Text", props: { content: "Hello" }, children: [] },
  },
};

function view(id: string, revision = 1): PortalView {
  return {
    id,
    title: id,
    spec,
    state: {},
    revision,
    createdAt: 1,
    updatedAt: revision,
    interactive: false,
    status: "active",
  };
}

function emptyState(): RecentViewsState {
  return { retained: new Map(), selectedViewId: null };
}

test("recent views remain mounted for 15 minutes after switching away", () => {
  let state = activateRecentView(emptyState(), "first", 0, view("first"));

  // A long-open active view starts its retention period when the user leaves it.
  state = activateRecentView(state, "second", 60 * 60_000, view("second"));
  state = pruneRecentViews(state, 60 * 60_000 + RECENT_VIEW_TTL_MS - 1);
  assert.equal(state.retained.has("first"), true);

  state = pruneRecentViews(state, 60 * 60_000 + RECENT_VIEW_TTL_MS);
  assert.equal(state.retained.has("first"), false);
  assert.equal(state.retained.has("second"), true, "the selected view is never pruned");
});

test("returning to a retained view renews its retention period", () => {
  let state = activateRecentView(emptyState(), "first", 0, view("first"));
  state = activateRecentView(state, "second", 100, view("second"));
  state = activateRecentView(state, "first", 200);
  state = activateRecentView(state, "second", 300);

  state = pruneRecentViews(state, 200 + RECENT_VIEW_TTL_MS - 1);
  assert.equal(state.retained.has("first"), true);
});

test("snapshot reconciliation drops removed and stale revisions", () => {
  let state = activateRecentView(emptyState(), "first", 0, view("first"));
  state = activateRecentView(state, "second", 1, view("second"));

  state = reconcileRecentViews(state, [
    {
      id: "second",
      title: "Second updated",
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      interactive: false,
      status: "active",
    },
  ]);

  assert.equal(state.retained.size, 0);
  assert.equal(state.selectedViewId, "second", "the stale selected tab waits for its fresh view payload");
});

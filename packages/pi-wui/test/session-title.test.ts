import assert from "node:assert/strict";
import test from "node:test";
import type { PortalSnapshot, PortalViewSummary } from "../src/shared/protocol.js";
import { getSessionDocumentTitle } from "../src/web/session-title.js";

function snapshot(views: PortalViewSummary[] = []): PortalSnapshot {
  return {
    protocolVersion: 1,
    session: {
      sessionId: "session-1",
      sessionName: "Fix checkout",
      projectName: "shop",
      cwd: "/code/shop",
      word: "violet-otter",
      startedAt: 1,
    },
    views,
    activeView: null,
  };
}

function view(overrides: Partial<PortalViewSummary> = {}): PortalViewSummary {
  return {
    id: "view-1",
    title: "Approval",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    interactive: false,
    status: "active",
    ...overrides,
  };
}

test("document title shows the state icon, active view, and product name", () => {
  assert.equal(getSessionDocumentTitle("live", snapshot(), "Approval"), "🟢 Approval - pi-wui");
  assert.equal(getSessionDocumentTitle("ended", snapshot(), "Approval"), "⚫ Approval - pi-wui");
});

test("document title follows the browser's currently selected view", () => {
  assert.equal(getSessionDocumentTitle("live", snapshot(), "Build results"), "🟢 Build results - pi-wui");
});

test("document title has a useful fallback before a view exists", () => {
  assert.equal(getSessionDocumentTitle("connecting", snapshot()), "🟡 No active view - pi-wui");
});

test("active interactive views take title priority as needing attention", () => {
  const current = snapshot([view({ interactive: true, status: "active" })]);
  assert.equal(getSessionDocumentTitle("live", current, "Approval"), "🔴 Approval - pi-wui");
});

test("completed interactive views do not need attention", () => {
  const current = snapshot([view({ interactive: true, status: "submitted" })]);
  assert.equal(getSessionDocumentTitle("live", current, "Approval"), "🟢 Approval - pi-wui");
});

test("connection state wins when the session is no longer live", () => {
  const current = snapshot([view({ interactive: true, status: "active" })]);
  assert.equal(getSessionDocumentTitle("reconnecting", current, "Approval"), "🟡 Approval - pi-wui");
  assert.equal(getSessionDocumentTitle("error", current, "Approval"), "⚠️ Approval - pi-wui");
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { createWuiMcpServer } from "../src/mcp";
import type { ServerMessage } from "../src/shared/protocol";

const simpleSpec = {
  root: "content",
  state: { count: 1 },
  elements: {
    content: {
      type: "Text",
      props: { text: "MCP view" },
      children: [],
    },
  },
};

const formSpec = {
  root: "form",
  state: { profile: { name: "Ada" } },
  elements: {
    form: {
      type: "Card",
      props: { title: "Profile" },
      children: ["name", "submit"],
    },
    name: {
      type: "Input",
      props: {
        label: "Name",
        name: "name",
        type: "text",
        value: { $bindState: "/profile/name" },
      },
      children: [],
    },
    submit: {
      type: "Button",
      props: { label: "Save" },
      on: { press: { action: "submit", params: { intent: "save" } } },
      children: [],
    },
  },
};

test("MCP adapter exposes WUI tools and preserves live state", async () => {
  const staticDir = await mkdtemp(join(tmpdir(), "pi-wui-mcp-test-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>WUI test</title>");

  const { mcp, service } = createWuiMcpServer({
    staticDir,
    cwd: process.cwd(),
    sessionId: "mcp-test-session",
    agentName: "Codex",
  });
  const client = new Client({ name: "codex-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        "wui_get_design_guide",
        "wui_get_component_docs",
        "wui",
        "wui_wait_for_feedback",
        "wui_upload_assets",
        "wui_read_state",
        "wui_update_state",
        "wui_read_events",
        "wui_status",
        "wui_stop",
      ],
    );

    const guide = await client.callTool({ name: "wui_get_design_guide", arguments: {} });
    assert.match(String((guide.structuredContent as Record<string, unknown>).guide), /# WUI Design/);
    assert.match(String((guide.structuredContent as Record<string, unknown>).catalog), /# WUI Catalog/);

    const componentDocs = await client.callTool({
      name: "wui_get_component_docs",
      arguments: { components: ["Dialog"] },
    });
    const componentDocsData = componentDocs.structuredContent as {
      components: Array<{ name: string; common: boolean; props: { type?: string } }>;
    };
    assert.equal(componentDocsData.components[0]?.name, "Dialog");
    assert.equal(componentDocsData.components[0]?.common, false);
    assert.equal(componentDocsData.components[0]?.props.type, "object");

    const initial = await client.callTool({ name: "wui_status", arguments: {} });
    assert.deepEqual(initial.structuredContent, {
      running: false,
      browserConnected: false,
      pendingFeedbackViewIds: [],
      queuedEventCount: 0,
    });

    const presented = await client.callTool({
      name: "wui",
      arguments: { title: "MCP test", spec: simpleSpec },
    });
    assert.equal(presented.isError, undefined);
    const presentedData = presented.structuredContent as Record<string, unknown>;
    assert.equal(presentedData.status, "presented");
    assert.match(String(presentedData.url), /^http:\/\/[a-z]+-7f000001\.nip\.io:\d+\/#token=/);
    assert.match(String(presentedData.fallbackUrl), /^http:\/\/127\.0\.0\.1:\d+\/#token=/);

    const updated = await client.callTool({
      name: "wui_update_state",
      arguments: { operations: [{ op: "set", path: "/count", value: 2 }] },
    });
    assert.equal((updated.structuredContent as Record<string, unknown>).status, "updated");

    const state = await client.callTool({
      name: "wui_read_state",
      arguments: { path: "/count" },
    });
    assert.equal((state.structuredContent as Record<string, unknown>).value, 2);

    const form = await client.callTool({
      name: "wui",
      arguments: { title: "MCP feedback", spec: formSpec, feedback: {} },
    });
    const formData = form.structuredContent as Record<string, unknown>;
    assert.equal(formData.status, "waiting");
    const wait = client.callTool({
      name: "wui_wait_for_feedback",
      arguments: { viewId: formData.viewId },
    });
    await submitForm(String(formData.fallbackUrl));
    const submitted = await wait;
    const submission = submitted.structuredContent as Record<string, unknown>;
    assert.equal(submission.status, "submitted");
    assert.deepEqual(submission.params, { intent: "save" });
    assert.deepEqual(submission.state, { profile: { name: "Ada" } });

    const invalid = await client.callTool({
      name: "wui_update_state",
      arguments: { operations: [] },
    });
    assert.equal(invalid.isError, true);

    const stopped = await client.callTool({ name: "wui_stop", arguments: {} });
    assert.equal((stopped.structuredContent as Record<string, unknown>).status, "stopped");
    assert.equal(service.isRunning, false);
  } finally {
    await service.stop("MCP test finished");
    await client.close();
    await mcp.close();
  }
});

async function submitForm(url: string): Promise<void> {
  const endpoint = new URL(url);
  const token = new URLSearchParams(endpoint.hash.slice(1)).get("token");
  assert.ok(token);

  const socket = new WebSocket(`ws://${endpoint.host}/ws`, {
    origin: `http://${endpoint.host}`,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out submitting the MCP form.")), 5_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.type === "auth_ok") {
        const view = message.snapshot.activeView;
        assert.ok(view?.requestId);
        socket.send(
          JSON.stringify({
            type: "action",
            eventId: "mcp-feedback-test",
            viewId: view.id,
            revision: view.revision,
            requestId: view.requestId,
            action: "submit",
            params: { intent: "save" },
            state: view.state,
          }),
        );
      }
      if (message.type === "ack" && message.eventId === "mcp-feedback-test") {
        clearTimeout(timer);
        socket.close();
        if (message.ok) resolve();
        else reject(new Error(message.message ?? "MCP feedback was rejected."));
      }
    });
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import webAccessKit from "../extensions/web-access-kit.ts";
import { createWebAccessKitServer } from "../server.ts";

async function post(url: string, token: string | undefined, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

test("HTTP server exposes the tools through its prefixed MCP endpoint", async () => {
	const app = createWebAccessKitServer({ host: "127.0.0.1", port: 0, prefix: "/remote-tools", token: "test-token" });
	const address = await app.start();
	const baseUrl = `http://127.0.0.1:${address.port}/remote-tools`;
	try {
		const health = await fetch(`${baseUrl}/health`);
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), {
			status: "ok",
			name: "web-access-kit",
			version: "0.2.3",
			mcpEndpoint: "/remote-tools/mcp",
			directToolEndpoints: {
				web_fetch_page: "/remote-tools/tools/web_fetch_page",
				web_search: "/remote-tools/tools/web_search",
			},
		});

		assert.equal((await post(`${baseUrl}/mcp`, undefined, {})).status, 401);

		const initialized = await post(`${baseUrl}/mcp`, "test-token", {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26" },
		});
		assert.equal(initialized.status, 200);
		assert.equal((await initialized.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name, "web-access-kit");


		const directTool = await post(`${baseUrl}/tools/web_fetch_page`, "test-token", { url: "http://127.0.0.1" });
		assert.equal(directTool.status, 400);
		assert.match((await directTool.json() as { error: string }).error, /Blocked non-public network target/);

		const previousRemoteUrl = process.env.WEB_ACCESS_KIT_URL;
		const previousToken = process.env.WEB_ACCESS_KIT_TOKEN;
		const remoteTools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
		try {
			process.env.WEB_ACCESS_KIT_URL = baseUrl;
			process.env.WEB_ACCESS_KIT_TOKEN = "test-token";
			webAccessKit({ registerTool: (tool: any) => remoteTools.set(tool.name, tool), on: () => undefined } as never);
			await assert.rejects(
				remoteTools.get("web_fetch_page")!.execute("test", { url: "http://127.0.0.1" }),
				/remote web_fetch_page failed: web_fetch_page failed: Blocked non-public network target/,
			);
		} finally {
			if (previousRemoteUrl === undefined) delete process.env.WEB_ACCESS_KIT_URL;
			else process.env.WEB_ACCESS_KIT_URL = previousRemoteUrl;
			if (previousToken === undefined) delete process.env.WEB_ACCESS_KIT_TOKEN;
			else process.env.WEB_ACCESS_KIT_TOKEN = previousToken;
		}

		const tools = await post(`${baseUrl}/mcp`, "test-token", { jsonrpc: "2.0", id: 2, method: "tools/list" });
		const body = await tools.json() as { result: { tools: Array<{ name: string }> } };
		assert.deepEqual(body.result.tools.map((tool) => tool.name), ["web_fetch_page", "web_search"]);
	} finally {
		await app.close();
	}
});

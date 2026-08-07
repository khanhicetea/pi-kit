import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webAccessKit from "../extensions/web-access-kit.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

function fakeExtension(exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		on() {},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		exec(command: string, args: string[]) {
			return exec(command, args);
		},
	} as unknown as ExtensionAPI;
	webAccessKit(pi);
	return tools;
}

test("a repeated GET text fetch is served from the in-session cache", async () => {
	let execCalls = 0;
	let outputPath = "";
	const tools = fakeExtension(async (_command, args) => {
		execCalls++;
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, "hello world", "utf8");
		return { code: 0, stdout: "__WEB_ACCESS_KIT_META__200\ttext/plain\thttps://93.184.216.34/\t", stderr: "" };
	});

	const first = await tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34" }, undefined);
	assert.equal(execCalls, 1);
	assert.equal(first.details.cached, undefined);

	const second = await tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34" }, undefined);
	// Served from cache: curl was not invoked a second time.
	assert.equal(execCalls, 1);
	assert.equal(second.details.cached, true);
	assert.equal(second.content[0].text, first.content[0].text);
});

test("HEAD requests and binary responses are not cached", async () => {
	let execCalls = 0;
	let outputPath = "";
	const tools = fakeExtension(async (_command, args) => {
		execCalls++;
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, new Uint8Array([0, 1, 2, 3]));
		return { code: 0, stdout: "__WEB_ACCESS_KIT_META__200\tapplication/octet-stream\thttps://93.184.216.34/file\t", stderr: "" };
	});

	await tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34/file" }, undefined);
	await tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34/file" }, undefined);
	// Binary artifacts are never cached, so both calls hit the network fake.
	assert.equal(execCalls, 2);
});

test("PI_WEB_FETCH_MAX_BYTES lowers the download cap", async () => {
	const previous = process.env.PI_WEB_FETCH_MAX_BYTES;
	process.env.PI_WEB_FETCH_MAX_BYTES = "1024";
	let outputPath = "";
	const tools = fakeExtension(async (_command, args) => {
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, new Uint8Array(2048), "utf8");
		return { code: 0, stdout: "__WEB_ACCESS_KIT_META__200\ttext/plain\thttps://93.184.216.34/cap-test\t", stderr: "" };
	});
	try {
		await assert.rejects(
			tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34/cap-test" }, undefined),
			/response exceeded the .* download limit/i,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_FETCH_MAX_BYTES;
		else process.env.PI_WEB_FETCH_MAX_BYTES = previous;
	}
});

test("PI_WEB_SEARCH_MODEL flows into the search result model", async () => {
	const previous = process.env.PI_WEB_SEARCH_MODEL;
	process.env.PI_WEB_SEARCH_MODEL = "custom-test-model";
	const tools = fakeExtension(async (command) => {
		if (command === "agy") return { code: 0, stdout: "No grounding URLs in this output.", stderr: "" };
		throw new Error(`unexpected command ${command}`);
	});
	try {
		const result = await tools.get("web_search")!.execute("call", { query: "test" }, undefined);
		assert.equal(result.details.model, "custom-test-model");
		assert.equal(result.details.resolvedGroundingUrls, 0);
		assert.equal(result.details.unresolvedGroundingUrls, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_SEARCH_MODEL;
		else process.env.PI_WEB_SEARCH_MODEL = previous;
	}
});

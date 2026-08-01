import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webAccessKit from "../extensions/web-access-kit.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

function fakeExtension(exec: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		on() {},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		exec(_command: string, args: string[]) {
			return exec(args);
		},
	} as unknown as ExtensionAPI;
	webAccessKit(pi);
	return tools;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("ordinary text fetches remove their raw temporary directory", async () => {
	let outputPath = "";
	const tools = fakeExtension(async (args) => {
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, "hello", "utf8");
		return {
			code: 0,
			stdout: "__WEB_ACCESS_KIT_META__200\ttext/plain\thttps://93.184.216.34/\t",
			stderr: "",
		};
	});

	const result = await tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34" }, undefined);
	assert.match(result.content[0].text, /hello/);
	assert.equal(await pathExists(dirname(outputPath)), false);
});

test("failed fetches remove partial temporary files", async () => {
	let outputPath = "";
	const tools = fakeExtension(async (args) => {
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, "partial", "utf8");
		return { code: 7, stdout: "", stderr: "connection failed" };
	});

	await assert.rejects(
		tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34" }, undefined),
		/web_fetch_page failed: connection failed/,
	);
	assert.equal(await pathExists(dirname(outputPath)), false);
});

test("post-download size checks reject and clean oversized decoded output", async () => {
	let outputPath = "";
	const tools = fakeExtension(async (args) => {
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, new Uint8Array(5 * 1024 * 1024 + 1));
		return {
			code: 0,
			stdout: "__WEB_ACCESS_KIT_META__200\ttext/plain\thttps://93.184.216.34/\t",
			stderr: "",
		};
	});

	await assert.rejects(
		tools.get("web_fetch_page")!.execute("call", { url: "https://93.184.216.34" }, undefined),
		/response exceeded the 5\.0MB download limit/,
	);
	assert.equal(await pathExists(dirname(outputPath)), false);
});

test("binary fetches retain only the artifact returned to the caller", async () => {
	let outputPath = "";
	const tools = fakeExtension(async (args) => {
		outputPath = args[args.indexOf("--output") + 1];
		await writeFile(outputPath, new Uint8Array([0, 1, 2]));
		return {
			code: 0,
			stdout: "__WEB_ACCESS_KIT_META__200\tapplication/octet-stream\thttps://93.184.216.34/file\t",
			stderr: "",
		};
	});

	const result = await tools.get("web_fetch_page")!.execute(
		"call",
		{ url: "https://93.184.216.34/file" },
		undefined,
	);
	assert.equal(result.details.fullOutputPath, outputPath);
	assert.equal(await pathExists(outputPath), true);
	await rm(dirname(outputPath), { recursive: true, force: true });
});

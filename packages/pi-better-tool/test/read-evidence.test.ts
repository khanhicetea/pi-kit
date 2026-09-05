import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLatestReadEvidence } from "../src/read-evidence.ts";
import { normalizeToLF, splitBom } from "../src/text.ts";

type MessageFixture =
	| {
		type: "message";
		message: {
			role: "assistant";
			content: Array<{ type: "toolCall"; id: string; name: "read"; arguments: { path: string; offset?: number; limit?: number } }>;
		};
	}
	| {
		type: "message";
		message: {
			role: "toolResult";
			toolCallId: string;
			toolName: "read";
			isError: boolean;
			content: Array<{ type: "text"; text: string }>;
		};
	};

type CompactionFixture = {
	type: "compaction";
	retainedTail: Array<MessageFixture["message"]>;
};

let cwd: string;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-better-read-evidence-"));
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function manager(entries: Array<MessageFixture | CompactionFixture>) {
	return {
		buildContextEntries: () => entries,
	} as unknown as Pick<ExtensionContext["sessionManager"], "buildContextEntries">;
}

async function builtinRead(path: string, options: { offset?: number; limit?: number } = {}) {
	const tool = createReadToolDefinition(cwd);
	return tool.execute("read-call", { path, ...options }, undefined, undefined, {} as never);
}

function pair(path: string, output: string, options: { id?: string; offset?: number; limit?: number; isError?: boolean } = {}): MessageFixture[] {
	const id = options.id ?? "read-call";
	return [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path, offset: options.offset, limit: options.limit } }] },
		},
		{
			type: "message",
			message: { role: "toolResult", toolCallId: id, toolName: "read", isError: options.isError ?? false, content: [{ type: "text", text: output }] },
		},
	];
}

async function find(path: string, content: string, entries: Array<MessageFixture | CompactionFixture>) {
	return findLatestReadEvidence(
		manager(entries),
		await realpath(join(cwd, path)),
		splitBom(normalizeToLF(content)).text,
		(readPath) => realpath(join(cwd, readPath)),
	);
}

describe("read evidence from built-in output", () => {
	it("verifies a user-limited built-in read and reports its exact range", async () => {
		const content = "one\ntwo\nthree\nfour\n";
		await writeFile(join(cwd, "sample.txt"), content);
		const result = await builtinRead("sample.txt", { offset: 2, limit: 2 });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		await expect(find("sample.txt", content, pair("sample.txt", output, { offset: 2, limit: 2 }))).resolves.toEqual({
			startLine: 2,
			endLine: 3,
			startOffset: 4,
			endOffset: 14,
		});
	});

	it("materializes retained-tail messages when present", async () => {
		const content = "one\ntwo\nthree\n";
		await writeFile(join(cwd, "retained.txt"), content);
		const result = await builtinRead("retained.txt", { offset: 2, limit: 1 });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		const retainedTail = pair("retained.txt", output, { offset: 2, limit: 1 }).map((entry) => entry.message);
		await expect(find("retained.txt", content, [{ type: "compaction", retainedTail }])).resolves.toMatchObject({ startLine: 2, endLine: 2 });
	});

	it("does not fall back when the newest same-file read failed", async () => {
		const content = "one\ntwo\n";
		await writeFile(join(cwd, "newest.txt"), content);
		const valid = await builtinRead("newest.txt", { limit: 1 });
		const output = valid.content[0]?.type === "text" ? valid.content[0].text : "";
		const entries = [
			...pair("newest.txt", output, { id: "older", limit: 1 }),
			...pair("newest.txt", "failed", { id: "newer", limit: 1, isError: true }),
		];
		await expect(find("newest.txt", content, entries)).resolves.toBeNull();
	});

	it("rejects stale or altered output", async () => {
		const content = "one\ntwo\n";
		await writeFile(join(cwd, "stale.txt"), content);
		await expect(find("stale.txt", content, pair("stale.txt", "old", { limit: 1 }))).resolves.toBeNull();
	});

	it("accepts CRLF read output under the documented LF-normalized policy", async () => {
		const content = "one\r\ntwo\r\n";
		await writeFile(join(cwd, "crlf.txt"), content);
		const result = await builtinRead("crlf.txt", { limit: 1 });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		await expect(find("crlf.txt", content, pair("crlf.txt", output, { limit: 1 }))).resolves.toMatchObject({ startLine: 1, endLine: 1 });
	});

	it("verifies default line and byte truncation boundaries", async () => {
		const lineContent = `${Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n")}\n`;
		await writeFile(join(cwd, "many-lines.txt"), lineContent);
		const lineResult = await builtinRead("many-lines.txt");
		const lineOutput = lineResult.content[0]?.type === "text" ? lineResult.content[0].text : "";
		await expect(find("many-lines.txt", lineContent, pair("many-lines.txt", lineOutput))).resolves.toMatchObject({ endLine: 2_000 });

		const byteContent = `${Array.from({ length: 1_000 }, (_, index) => `${index}: ${"é".repeat(80)}`).join("\n")}\n`;
		await writeFile(join(cwd, "many-bytes.txt"), byteContent);
		const byteResult = await builtinRead("many-bytes.txt");
		const byteOutput = byteResult.content[0]?.type === "text" ? byteResult.content[0].text : "";
		const evidence = await find("many-bytes.txt", byteContent, pair("many-bytes.txt", byteOutput));
		expect(evidence).not.toBeNull();
		expect(evidence!.endLine).toBeLessThan(1_000);
	});

	it("handles EOF with and without a terminal newline", async () => {
		for (const [name, content] of [["terminal.txt", "one\ntwo\n"], ["unterminated.txt", "one\ntwo"]] as const) {
			await writeFile(join(cwd, name), content);
			const result = await builtinRead(name, { offset: 2 });
			const output = result.content[0]?.type === "text" ? result.content[0].text : "";
			await expect(find(name, content, pair(name, output, { offset: 2 }))).resolves.toMatchObject({ startLine: 2 });
		}
	});

	it("conservatively rejects BOM reads because matching content is BOM-stripped", async () => {
		const content = "﻿one\ntwo\n";
		await writeFile(join(cwd, "bom.txt"), content);
		const result = await builtinRead("bom.txt", { limit: 1 });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		await expect(find("bom.txt", content, pair("bom.txt", output, { limit: 1 }))).resolves.toBeNull();
	});

	it("rejects built-in output when the first line exceeds the byte limit", async () => {
		const content = `${"x".repeat(60 * 1024)}\nnext\n`;
		await writeFile(join(cwd, "long-line.txt"), content);
		const result = await builtinRead("long-line.txt");
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";
		await expect(find("long-line.txt", content, pair("long-line.txt", output))).resolves.toBeNull();
	});
});

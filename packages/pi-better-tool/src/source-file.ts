import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_SOURCE_BYTES } from "./symbols.ts";
import { normalizeToLF, splitBom } from "./text.ts";

/** Bounded local source read; no silent decoding loss and no special files. */
export async function readSource(path: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("The path is not a regular source file.");
		if (stat.size > MAX_SOURCE_BYTES) throw new Error("Source exceeds the 2 MiB symbol analysis limit; use read with offset/limit.");
		const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_SOURCE_BYTES + 1));
		let length = 0;
		while (length < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("The source changed during the read; retry read_symbol.");
		const bytes = buffer.subarray(0, length);
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch { throw new Error("The source is not valid UTF-8; convert its encoding before symbol parsing."); }
		if (bytes.includes(0)) throw new Error("The source contains NUL bytes; binary/UTF-16 input is not supported.");
		signal?.throwIfAborted();
		return splitBom(normalizeToLF(content)).text;
	} finally {
		await handle.close();
	}
}

/** Only inspect a bounded number of siblings; never perform a hidden repo scan. */
export async function sourceReadError(path: string, error: unknown): Promise<string> {
	const code = (error as NodeJS.ErrnoException)?.code;
	const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
	const lines = [`Could not read source ${JSON.stringify(path)}: ${message}`];
	if (code === "ENOENT" || code === "ENOTDIR") {
		const names: string[] = [];
		try {
			const directory = await opendir(dirname(path));
			let inspected = 0;
			for await (const entry of directory) {
				if (entry.isFile()) names.push(entry.name);
				if (++inspected >= 100) break;
			}
		} catch { /* Parent may also be missing or inaccessible. */ }
		const stem = basename(path).split(".")[0].toLowerCase();
		names.sort((a, b) => Number(b.toLowerCase().includes(stem)) - Number(a.toLowerCase().includes(stem)) || a.localeCompare(b));
		if (names.length) lines.push("Nearby file candidates (bounded listing, not automatic path corrections):", ...names.slice(0, 8).map((name) => `  ${JSON.stringify(join(dirname(path), name))}`));
		lines.push("Verify the path and retry read_symbol; use find/ls if the parent path is wrong.");
	} else if (code === "EACCES" || code === "EPERM") {
		lines.push("Check file permissions. Do not retry the same call until access changes.");
	} else lines.push("Use read for ordinary text, images, or bounded line ranges; no symbol boundaries were returned.");
	return lines.join("\n");
}

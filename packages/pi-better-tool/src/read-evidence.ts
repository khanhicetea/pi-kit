import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { normalizeToLF } from "./text.ts";

export interface ReadEvidence {
	/** 0-based, end-exclusive offsets in LF-normalized, BOM-stripped content. */
	startOffset: number;
	endOffset: number;
	/** 1-based inclusive range actually shown to the model. */
	startLine: number;
	endLine: number;
}

interface ReadCall {
	path: string;
	offset?: number;
	limit?: number;
}

interface StoredToolResult {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: Array<{ type: string; text?: string }>;
}

/**
 * Find the newest successful read of targetPath still present in the active
 * model context. The returned range is accepted only when the stored tool
 * output exactly matches what the built-in read tool would produce from the
 * current file bytes. This makes stale or custom read output fail closed.
 */
export async function findLatestReadEvidence(
	sessionManager: Pick<ExtensionContext["sessionManager"], "buildContextEntries"> | undefined,
	targetPath: string,
	normalizedContent: string,
	resolvePath: (path: string) => Promise<string>,
): Promise<ReadEvidence | null> {
	if (!sessionManager) return null;
	const entries = sessionManager.buildContextEntries();
	const calls = new Map<string, ReadCall>();

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const item of entry.message.content) {
			if (item.type !== "toolCall" || item.name !== "read") continue;
			const args = item.arguments as Record<string, unknown>;
			if (typeof args.path !== "string") continue;
			calls.set(item.id, {
				path: args.path,
				offset: typeof args.offset === "number" ? args.offset : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			});
		}
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const result = entry.message as StoredToolResult;
		if (result.toolName !== "read" || result.isError) continue;
		const call = calls.get(result.toolCallId);
		if (!call) continue;

		let readPath: string;
		try {
			readPath = await resolvePath(call.path);
		} catch {
			continue;
		}
		if (readPath !== targetPath) continue;

		// This is the latest successful read of this file. If it cannot be
		// verified, do not silently fall back to older, potentially stale intent.
		return evidenceFromBuiltinRead(normalizedContent, call, result.content);
	}
	return null;
}

function evidenceFromBuiltinRead(
	content: string,
	call: ReadCall,
	blocks: Array<{ type: string; text?: string }>,
): ReadEvidence | null {
	if (blocks.length !== 1 || blocks[0].type !== "text" || typeof blocks[0].text !== "string") return null;
	if (call.offset !== undefined && (!Number.isInteger(call.offset) || call.offset < 1)) return null;
	if (call.limit !== undefined && (!Number.isInteger(call.limit) || call.limit < 1)) return null;
	const actualOutput = normalizeToLF(blocks[0].text);
	const allLines = content.split("\n");
	const startIndex = call.offset ? Math.max(0, call.offset - 1) : 0;
	if (startIndex >= allLines.length) return null;

	let selectedContent: string;
	let userLimitedLines: number | undefined;
	if (call.limit !== undefined) {
		const endIndex = Math.min(startIndex + call.limit, allLines.length);
		selectedContent = allLines.slice(startIndex, endIndex).join("\n");
		userLimitedLines = endIndex - startIndex;
	} else {
		selectedContent = allLines.slice(startIndex).join("\n");
	}

	const truncation = truncateHead(selectedContent);
	if (truncation.firstLineExceedsLimit) return null;

	let expectedOutput = truncation.content;
	let visibleLines = truncation.outputLines;
	if (truncation.truncated) {
		const startLine = startIndex + 1;
		const endLine = startLine + truncation.outputLines - 1;
		const nextOffset = endLine + 1;
		if (truncation.truncatedBy === "lines") {
			expectedOutput += `\n\n[Showing lines ${startLine}-${endLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
		} else {
			expectedOutput += `\n\n[Showing lines ${startLine}-${endLine} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
	} else if (userLimitedLines !== undefined && startIndex + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startIndex + userLimitedLines);
		const nextOffset = startIndex + userLimitedLines + 1;
		expectedOutput += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
		visibleLines = userLimitedLines;
	}

	if (actualOutput !== expectedOutput || visibleLines <= 0 || visibleLines > DEFAULT_MAX_LINES) return null;

	const startLine = startIndex + 1;
	const endLine = startLine + visibleLines - 1;
	const startOffset = offsetAtLine(content, startLine);
	const endOffset = offsetAtLine(content, endLine + 1);
	return { startOffset, endOffset, startLine, endLine };
}

/** Offset of a 1-based line; the line after EOF maps to content.length. */
function offsetAtLine(content: string, line: number): number {
	if (line <= 1) return 0;
	let currentLine = 1;
	let offset = 0;
	while (currentLine < line) {
		const newline = content.indexOf("\n", offset);
		if (newline === -1) return content.length;
		offset = newline + 1;
		currentLine++;
	}
	return offset;
}

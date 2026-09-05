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
	/** 1-based inclusive range represented by the verified read output. */
	startLine: number;
	endLine: number;
}

interface ReadCall {
	id: string;
	path: string;
	offset?: number;
	limit?: number;
}

interface StoredToolResult {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: Array<{ type: string; text?: string }>;
}

interface StoredAssistant {
	role: "assistant";
	content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }>;
}

interface ContextEntryLike {
	type: string;
	message?: StoredAssistant | StoredToolResult | { role: string };
	retainedTail?: Array<StoredAssistant | StoredToolResult | { role: string }>;
}

/**
 * Find the newest read call for targetPath in Pi's compaction-aware stored
 * context. The call is accepted only when its successful result exactly
 * matches the built-in read formatting for the current LF-normalized content.
 *
 * This establishes stored-context evidence, not proof of the final provider
 * payload after other extensions' context/provider hooks.
 */
export async function findLatestReadEvidence(
	sessionManager: Pick<ExtensionContext["sessionManager"], "buildContextEntries"> | undefined,
	targetPath: string,
	normalizedContent: string,
	resolvePath: (path: string) => Promise<string>,
): Promise<ReadEvidence | null> {
	if (!sessionManager) return null;
	const entries = sessionManager.buildContextEntries() as ContextEntryLike[];
	const messages = entries.flatMap((entry) => {
		if (entry.type === "message" && entry.message) return [entry.message];
		if (entry.type === "compaction" && Array.isArray(entry.retainedTail)) return entry.retainedTail;
		return [];
	});
	const calls: ReadCall[] = [];
	const results = new Map<string, StoredToolResult>();

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const item of (message as StoredAssistant).content) {
				if (item.type !== "toolCall" || item.name !== "read" || typeof item.id !== "string") continue;
				const args = item.arguments as Record<string, unknown> | undefined;
				if (!args || typeof args.path !== "string") continue;
				calls.push({
					id: item.id,
					path: args.path,
					offset: typeof args.offset === "number" ? args.offset : undefined,
					limit: typeof args.limit === "number" ? args.limit : undefined,
				});
			}
		} else if (message.role === "toolResult") {
			const result = message as StoredToolResult;
			if (result.toolName === "read") results.set(result.toolCallId, result);
		}
	}

	for (let index = calls.length - 1; index >= 0; index--) {
		const call = calls[index];
		let readPath: string;
		try {
			readPath = await resolvePath(call.path);
		} catch {
			// Without a canonical identity we cannot prove that this newer read is
			// unrelated, so fail closed instead of falling back to older intent.
			return null;
		}
		if (readPath !== targetPath) continue;

		// Never fall back to older intent when the newest same-file read is
		// missing, failed, malformed, or stale.
		const result = results.get(call.id);
		if (!result || result.isError) return null;
		return evidenceFromBuiltinRead(normalizedContent, call, result.content);
	}
	return null;
}

export function evidenceFromBuiltinRead(
	content: string,
	call: Pick<ReadCall, "path" | "offset" | "limit">,
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

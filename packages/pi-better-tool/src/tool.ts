/**
 * The "better edit" tool: a drop-in override of pi's built-in edit tool.
 *
 * Normal matching closely tracks the built-in tool and keeps its success
 * result shape so the built-in diff renderer is inherited. Conservative
 * schema, encoding, read-evidence, and commit-boundary checks are intentional
 * safety differences. Instead of a bare "Could
 * not find edits[1]" error that forces the model to re-read the file and
 * guess at larger context, failures include recovery context:
 *
 * - ambiguous literal oldText → if the latest verified read of the file shows
 *   exactly one occurrence, select it and report up to four retryable remaining
 *   candidates; otherwise return occurrence line numbers + minimal context
 * - not-found oldText → closest matching region with a per-line comparison
 *   and the exact file bytes to retry with
 */

import {
	generateDiffString,
	generateUnifiedPatch,
	withFileMutationQueue,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { constants, type Stats } from "node:fs";
import {
	access as fsAccess,
	readFile as fsReadFile,
	realpath as fsRealpath,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { analyzeEdits, applyAnalysis, fuzzyFindText, normalizeEdits, type EditOp } from "./apply.ts";
import {
	formatAutoDisambiguationSuccess,
	formatEditFailure,
	type AutoDisambiguation,
} from "./diagnostics.ts";
import { findLatestReadEvidence } from "./read-evidence.ts";
import {
	detectLineEnding,
	findAllOccurrences,
	getLineSpans,
	lineAt,
	normalizeToLF,
	restoreLineEndings,
	splitBom,
} from "./text.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

export const betterEditSchema = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		minItems: 1,
		maxItems: 100,
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type BetterEditInput = Static<typeof betterEditSchema>;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Match pi's built-in path normalization for tool arguments. */
function normalizeToolPath(input: string): string {
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);

	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
	}

	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(homedir(), path.slice(2));
	}
	if (/^file:\/\//.test(path)) return fileURLToPath(path);
	return path;
}

function resolveToCwd(filePath: string, cwd: string): string {
	const path = normalizeToolPath(filePath);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isSingleEditInput(value: unknown): value is { oldText: string; newText: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const edit = value as { oldText?: unknown; newText?: unknown };
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Compatibility shim, ported from the built-in tool: some models send edits as
 * a JSON string, or send a single edit object instead of a one-element array,
 * or use the legacy top-level oldText/newText shape.
 */
export function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") {
		return input;
	}
	const args = input as {
		edits?: unknown;
		oldText?: unknown;
		newText?: unknown;
		[path: string]: unknown;
	};

	let preparedEdits = args.edits;
	if (typeof preparedEdits === "string") {
		try {
			const parsed: unknown = JSON.parse(preparedEdits);
			if (Array.isArray(parsed)) preparedEdits = parsed;
			else if (isSingleEditInput(parsed)) preparedEdits = [parsed];
		} catch {
			// leave as-is; schema validation will report it
		}
	} else if (isSingleEditInput(preparedEdits)) {
		preparedEdits = [preparedEdits];
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		const edits = Array.isArray(preparedEdits) ? [...(preparedEdits as EditOp[])] : [];
		edits.push({ oldText: args.oldText, newText: args.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = args;
		return { ...rest, edits };
	}
	return preparedEdits === args.edits ? args : { ...args, edits: preparedEdits };
}

export interface BetterEditSuccess {
	content: Array<{ type: "text"; text: string }>;
	details: EditToolDetails;
}

export interface BetterEditOperations {
	access(path: string): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<Stats>;
	writeFile(path: string, content: string): Promise<void>;
}

const defaultOperations: BetterEditOperations = {
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
	readFile: (path) => fsReadFile(path),
	realpath: (path) => fsRealpath(path),
	stat: (path) => fsStat(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
};

export interface BetterEditExecutionOptions {
	operations?: BetterEditOperations;
	/** Test/integration seam; runs before the write commit boundary. */
	formatSuccess?: typeof formatAutoDisambiguationSuccess;
}

function describeFsError(error: unknown): string {
	return error instanceof Error && "code" in error
		? `Error code: ${(error as NodeJS.ErrnoException).code}`
		: error instanceof Error
			? error.message
			: String(error);
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function decodeEditableUtf8(buffer: Buffer, path: string): string {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new Error(`Could not edit file: ${path}. The file is not valid UTF-8; unsupported encodings are never transcoded.`);
	}
	if (buffer.includes(0)) {
		throw new Error(`Could not edit file: ${path}. The file contains NUL bytes and is treated as binary or an unsupported text encoding.`);
	}
	return buffer.toString("utf-8");
}

function countLiteralOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

export async function executeBetterEdit(
	input: BetterEditInput,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "sessionManager">>,
	options: BetterEditExecutionOptions = {},
): Promise<BetterEditSuccess> {
	const edits: EditOp[] = input.edits ?? [];
	if (!input.path || !Array.isArray(edits) || edits.length === 0 || edits.length > 100) {
		throw new Error("Edit tool input is invalid. path must be non-empty and edits must contain 1-100 replacements.");
	}
	const absolutePath = resolveToCwd(input.path, ctx.cwd);
	const ops = options.operations ?? defaultOperations;
	const formatSuccess = options.formatSuccess ?? formatAutoDisambiguationSuccess;

	return withFileMutationQueue(absolutePath, async () => {
		// Never reject from an abort listener: the queue must remain held until
		// in-flight filesystem work settles.
		const throwIfAborted = () => {
			if (signal?.aborted) throw new Error("Operation aborted before the edit was committed; no write was started.");
		};
		throwIfAborted();

		try {
			await ops.access(absolutePath);
		} catch (error) {
			throwIfAborted();
			throw new Error(`Could not access file for editing: ${input.path}. ${describeFsError(error)}. No write was started.`);
		}
		throwIfAborted();

		let buffer: Buffer;
		let initialStat: Stats;
		try {
			const beforeReadStat = await ops.stat(absolutePath);
			buffer = await ops.readFile(absolutePath);
			initialStat = await ops.stat(absolutePath);
			if (!sameFileIdentity(beforeReadStat, initialStat)) throw new Error("target-changed-during-read");
		} catch (error) {
			throwIfAborted();
			if (error instanceof Error && error.message === "target-changed-during-read") {
				throw new Error(`Could not edit file: ${input.path}. The target identity changed while it was being read; no write was started. Re-read and retry.`);
			}
			throw new Error(`Could not read file for editing: ${input.path}. ${describeFsError(error)}. No write was started.`);
		}
		const rawContent = decodeEditableUtf8(buffer, input.path);
		throwIfAborted();

		const { bom, text: content } = splitBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);

		const selections = new Map<number, number>();
		const resolutions: AutoDisambiguation[] = [];
		let result = analyzeEdits(normalizedContent, edits, { ambiguousSelections: selections });
		let readEvidence: Awaited<ReturnType<typeof findLatestReadEvidence>> | undefined;
		const normalizedEdits = normalizeEdits(edits);
		const exactBase = normalizedEdits.every(
			(edit) => !fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch,
		);

		while (!result.ok && result.failure.kind === "ambiguous" && exactBase) {
			const editIndex = result.failure.editIndex;
			if (selections.has(editIndex)) break;
			const edit = normalizedEdits[editIndex];
			const exactCount = countLiteralOccurrences(normalizedContent, edit.oldText);
			const exactOffsets = findAllOccurrences(normalizedContent, edit.oldText, 256);
			// Fuzzy-equivalent aliases cannot be mapped safely to original offsets.
			if (exactCount !== result.failure.occurrenceCount) break;

			if (readEvidence === undefined) {
				let canonicalTarget: string;
				try {
					canonicalTarget = await ops.realpath(absolutePath);
				} catch (error) {
					throw new Error(`Could not resolve edit target: ${input.path}. ${describeFsError(error)}. No write was started.`);
				}
				readEvidence = await findLatestReadEvidence(
					ctx.sessionManager,
					canonicalTarget,
					normalizedContent,
					async (readPath) => ops.realpath(resolveToCwd(readPath, ctx.cwd)),
				);
			}
			if (!readEvidence) break;

			const candidates = exactOffsets.filter(
				(offset) =>
					offset >= readEvidence!.startOffset &&
					offset + edit.oldText.length <= readEvidence!.endOffset,
			);
			if (candidates.length !== 1) break;

			const selectedOffset = candidates[0];
			const spans = getLineSpans(normalizedContent);
			selections.set(editIndex, selectedOffset);
			resolutions.push({
				editIndex,
				oldText: edit.oldText,
				chosenRange: {
					start: lineAt(spans, selectedOffset) + 1,
					end: lineAt(spans, selectedOffset + Math.max(1, edit.oldText.length) - 1) + 1,
				},
				readRange: { start: readEvidence.startLine, end: readEvidence.endLine },
			});
			result = analyzeEdits(normalizedContent, edits, { ambiguousSelections: selections });
		}

		if (!result.ok) {
			throw new Error(formatEditFailure({ path: input.path, normalizedContent, edits, failure: result.failure }));
		}

		const { baseContent, newContent } = applyAnalysis(normalizedContent, result.analysis);
		if (baseContent === newContent) {
			throw new Error(formatEditFailure({
				path: input.path,
				normalizedContent,
				edits,
				failure: { kind: "no-change" },
			}));
		}

		// Prepare every required success artifact before crossing the write
		// boundary. Optional diagnostics are bounded and cannot fail after commit.
		const finalContent = bom + restoreLineEndings(newContent, originalEnding);
		const diffResult = generateDiffString(baseContent, newContent);
		const success: BetterEditSuccess = {
			content: [{
				type: "text",
				text: formatSuccess(
					`Successfully replaced ${edits.length} block(s) in ${input.path}.`,
					newContent,
					resolutions,
				),
			}],
			details: {
				diff: diffResult.diff,
				patch: generateUnifiedPatch(input.path, baseContent, newContent),
				firstChangedLine: diffResult.firstChangedLine,
			},
		};
		throwIfAborted();

		// Best-effort external modification detection. This is not a lock or a
		// race-free compare-and-swap; another process can still change the target
		// after this check and before/during the write.
		try {
			const [currentBuffer, currentStat] = await Promise.all([
				ops.readFile(absolutePath),
				ops.stat(absolutePath),
			]);
			if (!sameFileIdentity(initialStat, currentStat) || !buffer.equals(currentBuffer)) {
				throw new Error("target-changed");
			}
		} catch (error) {
			throwIfAborted();
			if (error instanceof Error && error.message === "target-changed") {
				throw new Error(`Could not edit file: ${input.path}. The target changed after it was read; no write was started. Re-read and retry.`);
			}
			throw new Error(`Could not revalidate file before writing: ${input.path}. ${describeFsError(error)}. No write was started.`);
		}
		throwIfAborted();

		try {
			await ops.writeFile(absolutePath, finalContent);
		} catch (error) {
			throw new Error(`Could not complete write to ${input.path}. ${describeFsError(error)}. The file may be unchanged, partially written, or fully written; inspect it before retrying.`);
		}
		// A resolved write is the commit boundary. Ignore cancellation that arrived
		// during it and report the committed result; no fallible formatting remains.
		return success;
	});
}

export function registerBetterEditTool(pi: ExtensionAPI, options: BetterEditExecutionOptions = {}): void {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a single local file using exact text replacement. Every edits[].oldText should match a unique, non-overlapping region of the original file. Repeated literal text is selected only when exactly one tracked occurrence is contained in the latest verified stored-context read. Failures include bounded recovery context; low-confidence, non-unique, omitted, or stale candidates require a read before retrying.",
		promptSnippet:
			"Make precise local file edits with exact text replacement; failures return bounded recovery context",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly).",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls.",
			"In edit, each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
			"Keep edit edits[].oldText as small as possible while still being unique in the file; do not pad with large unchanged regions.",
			"When edit safely auto-disambiguates repeated text from the latest verified stored-context read, its success message lists bounded remaining candidates for an optional follow-up edit.",
			"When edit fails, reuse only a fenced snippet explicitly marked retryable. If edit reports low confidence, competing candidates, omitted output, stale evidence, or a write that may have modified the file, read the referenced file/range before retrying.",
		],
		parameters: betterEditSchema,
		prepareArguments: (args: unknown): BetterEditInput => prepareEditArguments(args) as BetterEditInput,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			return executeBetterEdit(input, signal, ctx, options);
		},
	});
}

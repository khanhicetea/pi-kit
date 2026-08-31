/**
 * The "better edit" tool: a drop-in override of pi's built-in edit tool.
 *
 * Happy-path behavior is identical to the built-in tool (same schema, same
 * matching semantics, same result shapes so the built-in diff renderer is
 * inherited). The difference is failure behavior: instead of a bare "Could
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
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, realpath as fsRealpath, writeFile as fsWriteFile } from "node:fs/promises";
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
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
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

	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {
			// leave as-is; schema validation will report it
		}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		const edits = Array.isArray(args.edits) ? [...(args.edits as EditOp[])] : [];
		edits.push({ oldText: args.oldText, newText: args.newText });
		const { oldText: _oldText, newText: _newText, ...rest } = args;
		return { ...rest, edits };
	}
	return args;
}

export interface BetterEditSuccess {
	content: Array<{ type: "text"; text: string }>;
	details: EditToolDetails;
}

export async function executeBetterEdit(
	input: BetterEditInput,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "sessionManager">>,
): Promise<BetterEditSuccess> {
	const edits: EditOp[] = input.edits ?? [];
	if (!Array.isArray(edits) || edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	const absolutePath = resolveToCwd(input.path, ctx.cwd);

	return withFileMutationQueue(absolutePath, async () => {
		// Do not reject from an abort event listener here: that would release the
		// mutation queue while an in-flight filesystem operation may still finish.
		const throwIfAborted = () => {
			if (signal?.aborted) throw new Error("Operation aborted");
		};
		throwIfAborted();

		try {
			await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
		} catch (error) {
			throwIfAborted();
			const errorMessage =
				error instanceof Error && "code" in error
					? `Error code: ${(error as NodeJS.ErrnoException).code}`
					: String(error);
			throw new Error(`Could not edit file: ${input.path}. ${errorMessage}.`);
		}
		throwIfAborted();

		const buffer = await fsReadFile(absolutePath);
		const rawContent = buffer.toString("utf-8");
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
			const exactOffsets = findAllOccurrences(normalizedContent, edit.oldText);
			// Fuzzy-equivalent aliases cannot be mapped safely to original offsets.
			if (exactOffsets.length !== result.failure.occurrenceOffsets.length) break;

			if (readEvidence === undefined) {
				const canonicalTarget = await fsRealpath(absolutePath);
				readEvidence = await findLatestReadEvidence(
					ctx.sessionManager,
					canonicalTarget,
					normalizedContent,
					async (readPath) => fsRealpath(resolveToCwd(readPath, ctx.cwd)),
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
			throw new Error(
				formatEditFailure({
					path: input.path,
					normalizedContent,
					edits,
					failure: result.failure,
				}),
			);
		}

		const { baseContent, newContent } = applyAnalysis(normalizedContent, result.analysis);
		if (baseContent === newContent) {
			throw new Error(
				formatEditFailure({
					path: input.path,
					normalizedContent,
					edits,
					failure: { kind: "no-change" },
				}),
			);
		}
		throwIfAborted();

		const finalContent = bom + restoreLineEndings(newContent, originalEnding);
		await fsWriteFile(absolutePath, finalContent, "utf-8");
		throwIfAborted();

		const diffResult = generateDiffString(baseContent, newContent);
		const patch = generateUnifiedPatch(input.path, baseContent, newContent);
		return {
			content: [
				{
					type: "text",
					text: formatAutoDisambiguationSuccess(
						`Successfully replaced ${edits.length} block(s) in ${input.path}.`,
						newContent,
						resolutions,
					),
				},
			],
			details: {
				diff: diffResult.diff,
				patch,
				firstChangedLine: diffResult.firstChangedLine,
			} satisfies EditToolDetails,
		};
	});
}

export function registerBetterEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText should match a unique, non-overlapping region of the original file. When literal text is repeated, edit may safely select it only if exactly one occurrence was fully shown by the latest verified read of that file; the success result then includes up to four remaining disambiguated candidates. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. On failure the error includes recovery context (closest matching region or per-occurrence disambiguation snippets) so you can retry immediately without re-reading the file.",
		promptSnippet:
			"Make precise file edits with exact text replacement; failures return recovery context (closest match or disambiguation snippets)",
		promptGuidelines: [
			"Use edit for precise changes (edits[].oldText must match exactly)",
			"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
			"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
			"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
			"When edit safely auto-disambiguates repeated text from the latest verified read, its success message lists up to four remaining occurrences with effective prefix/suffix context for an optional follow-up edit.",
			"When an edit call fails, the error message already contains recovery context: the closest matching region with exact file bytes (not-found) or each occurrence with a ready-to-use disambiguated oldText (ambiguous match). Retry the edit using that text directly instead of re-reading the file.",
		],
		parameters: betterEditSchema,
		prepareArguments: (args: unknown): BetterEditInput => prepareEditArguments(args) as BetterEditInput,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			return executeBetterEdit(input, signal, ctx);
		},
	});
}

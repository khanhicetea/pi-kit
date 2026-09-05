# pi-better-tool

Better built-in tools for the [pi coding agent](https://github.com/earendil-works/pi-mono) — starting with an `edit` override that turns many failed edits into recoverable ones.

## Why

Pi's built-in `edit` requires every `edits[].oldText` to identify one non-overlapping region. When matching fails, this override returns bounded context that can make the next action safer:

- **Ambiguous literal match after a bounded read** — selects an occurrence only when exactly one tracked literal occurrence is fully contained in the newest verified stored-context `read` of the same file.
- **Other ambiguous matches** — reports bounded occurrence ranges and whole-line prefix/suffix expansions that are unique under edit matching.
- **Text not found** — reports a bounded closest-region comparison. It gives direct-retry wording only when the exact candidate is unique, sufficiently similar, and meaningfully better than a distinct runner-up.

Low-confidence, competing, stale, oversized, or omitted candidates tell the model to read the referenced range instead of retrying blindly.

## Install

```bash
pi install npm:@khanhicetea/pi-better-tool
```

For local development from this monorepo:

```bash
pi install /absolute/path/to/pi-kit/packages/pi-better-tool
```

It is also registered in the root `package.json` under `pi.extensions`.

## Example: ambiguous oldText

````text
Found 2 occurrences of the text in dup.go. The text must be unique. Please provide more context to make it unique.

Occurrences:
  1. lines 2-3
  2. lines 6-7

Disambiguated oldText candidates are shown below when they fit safely. A fenced snippet can be reused exactly; an omitted snippet must be read from its referenced range first:

Occurrence 1 (lines 2-3) — minimum context: 0 lines before, 1 line after:
```
	log()
}

func second() {
```

Tip: only fenced snippets explicitly presented as retryable should be copied into oldText.

No changes were written — the file was not modified.
````

## Example: competing closest matches

````text
Could not find the exact text in handlers.ts. The old text must match exactly including all whitespace and newlines.

Closest match in the file: lines 10-12 (~91% line similarity).
...
Candidate file content at lines 10-12 is not safe for a direct retry (a distinct candidate at lines 30-32 has a similar heuristic score (~90%)). Read and verify this range before editing.
```
function firstHandler() {
	work();
}
```

No changes were written — the file was not modified.
````

Similarity scores are heuristics, not probabilities.

## Behavior and compatibility

The normal matching path follows Pi's built-in edit implementation:

- exact match first, then fuzzy fallback for trailing whitespace, smart quotes, dashes, Unicode compatibility forms, and Unicode spaces
- uniqueness checked in fuzzy-normalized space
- all edits matched against the original content rather than applied incrementally
- overlap and no-change detection
- CRLF restoration and UTF-8 BOM preservation
- built-in-compatible success details (`details.diff`, `details.patch`, and `details.firstChangedLine`)
- no custom renderers, so Pi's built-in edit renderer is inherited

Intentional safety/compatibility differences are:

- 1–100 edits are accepted per call; empty batches are rejected by the public schema
- empty and fuzzy-normalized-empty `oldText` values are rejected
- invalid UTF-8 and NUL-containing files are rejected rather than silently transcoded
- conservative stored-read-based selection may resolve repeated literal text
- self-overlapping string occurrences retain Pi's non-overlapping counting policy

The argument compatibility shim accepts `edits` as an array, JSON string, single edit object, or legacy top-level `oldText`/`newText`. Preparation is pure and idempotent.

### Read-evidence boundary

Read evidence is taken from Pi's active, compaction-aware **stored session context**. Retained-tail messages are handled when the host exposes them. The newest same-file read must have a matching successful result and reproduce built-in read formatting for the current LF-normalized content. Missing, failed, malformed, or stale newest evidence blocks fallback to older intent.

This is not proof of the final provider payload: another extension may remove messages in a `context` hook or rewrite the provider request. CRLF read output is intentionally compared after LF normalization, so this guarantee is content/format verification rather than literal byte identity. BOM-bearing read output is conservatively rejected because edit matching strips the BOM. Fuzzy/Unicode-equivalent ambiguity and highly repetitive files also fail closed.

### Local filesystem and commit guarantees

This override uses local Node.js filesystem operations. It does **not** inherit an SSH, container, sandbox, or other custom edit backend.

All replacements are analyzed before writing, so a matching/overlap/no-change/diagnostic failure starts no write. Immediately before writing, the tool performs a best-effort content and file-identity recheck to catch many external modifications.

The final write is still an in-place filesystem overwrite:

- it is not a cross-process lock or race-free compare-and-swap
- it is not rollback- or crash-safe filesystem atomicity
- another process can modify the file after the pre-write check
- a rejected write may leave the file unchanged, partially written, or fully written; inspect it before retrying

A resolved write is the tool's commit boundary. The extension returns the committed result rather than throwing a post-write cancellation error. A host may still suppress result delivery when cancelling the surrounding tool run; cancellation cannot roll back a completed filesystem write. Temporary-file/rename replacement is deliberately not used because it can replace symlinks, break hard-link semantics, or alter metadata without a carefully defined cross-platform policy.

### Output and resource bounds

Diagnostic text is kept below Pi's 50 KB / 2,000-line tool-output limits. Markdown snippets are added atomically so a fence is never cut; oversized snippets are omitted with read guidance. Success expansion is skipped for oversized files. Closest-match work has explicit query, line, and operation budgets and falls back to concise read guidance when exhausted.

`details.diff` and `details.patch` remain complete for renderer compatibility and are not blindly truncated as diagnostic text.

## Host compatibility

Pi's packaging guidance requires wildcard peer dependencies for Pi core packages. This package follows that guidance rather than bundling Pi. Version 0.2.1 is typechecked and tested against `@earendil-works/pi-coding-agent` 0.82.1; host upgrades should run the read-format, exported-helper, renderer-shape, and session-context compatibility tests.

## Development

```bash
npm run check     # typecheck + tests
npm test          # vitest only
```

## Publishing

From the repository root:

```bash
npm run check --workspace=@khanhicetea/pi-better-tool
npm pack --dry-run --workspace=@khanhicetea/pi-better-tool
npm publish --workspace=@khanhicetea/pi-better-tool
```

## License

MIT

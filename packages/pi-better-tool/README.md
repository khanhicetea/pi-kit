# pi-better-tool

Context-aware tools for the [Pi coding agent](https://github.com/earendil-works/pi-mono):

- **`edit`** replaces the built-in edit tool. Failures explain what failed, what was not written, and what to do next.
- **`read_symbol`** is a new tool. Read a whole function, method, class, or type by containing line or exact name. With only a path, get a symbol outline.
- **`read` stays unchanged** for ordinary text, images, and explicit line ranges.

## Install

```bash
pi install npm:@khanhicetea/pi-better-tool
```

From this monorepo:

```bash
pi install /absolute/path/to/pi-kit/packages/pi-better-tool
```

The root `package.json` also registers the extension. After local changes, use `/reload` in Pi to load the new tool definition. After upgrading to a release that adds grammar packages, restart Pi once: ast-grep’s native language registry cannot be extended by `/reload` in an already-running process.

## Read the symbol, not guessed line windows

After grep identifies a location:

```json
{"path":"src/server.ts","line":142}
```

Call `read_symbol` with an exact name instead:

```json
{"path":"src/server.ts","symbol":"Server.handleRequest"}
```

Get the enclosing class or function:

```json
{"path":"src/server.ts","line":142,"parent":1}
```

Discover names and ranges without reading every body:

```json
{"path":"src/server.ts"}
```

### Arguments

| Argument | Meaning |
| --- | --- |
| `path` | Local relative/absolute path; supports `@path`, `~/path`, and file URLs. |
| `line` | 1-based file line. Select the innermost declaration containing it. |
| `column` | Optional 1-based UTF-16 column with `line`, to distinguish same-line symbols. |
| `symbol` | Exact, case-sensitive name or qualified name such as `Server.run`. Combine with `line` for duplicate names. |
| `parent` | Move outward through enclosing declarations; default 0, maximum 20. |
| `context` | Extra whole lines before/after the declaration; default 0, maximum 20. |
| `offset` | 1-based position **within the selection**, not a file line. For an outline, the entry position. |
| `limit` | Maximum source lines (default 1000) or outline entries (default 50); maximum 1800. |

Omit both `line` and `symbol` for an outline. Named selection never silently chooses the first duplicate. Line selection never silently chooses between same-line siblings. Candidate lists include concrete calls with names and positions.

### Languages and boundaries

Syntax parsing uses Tree-sitter through `@ast-grep/napi`, not indentation or brace-counting guesses:

- JavaScript, JSX, TypeScript, TSX, and their module extensions
- Bash-compatible shell scripts (`.sh`, `.bash`, `.zsh`, and related extensions)
- C and C++ (including common header and CUDA/Arduino extensions)
- C# and Java
- Kotlin
- PHP
- Python and `.pyi`
- Ruby (including `Gemfile` and `Rakefile`)
- Rust
- Swift

The reader handles named declarations, nested functions, JS/TS arrow functions and methods, Python decorators, Rust attributes, and containing classes/types. It includes export/declaration wrappers when applicable. It returns **whole source lines**, so a line can also contain adjacent code. It does not resolve imports, references, overload implementations, macros, or runtime bindings. Leading standalone comments are not automatically attached to a declaration.

Incomplete syntax, unsupported languages, unavailable parsers, and locations without declarations do not produce guessed symbol boundaries. Failures give a bounded source preview or candidate list and concrete next-call arguments. Missing paths include a bounded list of nearby files when the parent directory is accessible.

### Output and pagination

Results identify the selected symbol, enclosing names, full declaration range, displayed file range, and a SHA-256 source snapshot. Source appears in an unnumbered fenced block, so line-number prefixes cannot accidentally enter `oldText`.

Large selections return a whole-line page, explicitly marked **partial**, with the complete next `read_symbol` arguments. Follow that continuation instead of calculating file offsets. Each call reads a fresh snapshot; do not combine pages whose snapshot hashes differ.

Limits:

- Source analysis: 2 MiB UTF-8, 100,000 syntax nodes, 10,000 declarations, 1,024 characters per qualified symbol name.
- Complete read output: 48 KiB / 1,950 lines, including metadata and fences.
- No clipped copyable source lines or broken fences. A line too large to display gets preview/read guidance instead.
- Invalid UTF-8, NUL-containing input, and non-regular files are rejected.

Parser packages are runtime dependencies. Common platforms use prebuilt native binaries. If a grammar is unavailable on a platform, the tool gives read guidance; it never runs repository code, installs a compiler, or builds a grammar during a tool call. The edit tool can still work without loading symbol parsers.

## Recover from an edit failure in the next call

The `edit` input remains:

```json
{
  "path": "src/server.ts",
  "edits": [
    { "oldText": "exact current text", "newText": "replacement text" }
  ]
}
```

All entries match the **original file**, not the output of earlier entries. Matching/overlap failures apply none of the batch. Fix the reported entries and resubmit the **complete batch**.

| Failure | Returned context |
| --- | --- |
| Repeated `oldText` | Occurrence ranges, bounded unique anchor expansions, and concrete context-read calls. |
| Text not found | Closest-region comparison with original whitespace, likely causes, and exact retry text only when unique and clearly better than competing candidates. |
| Overlapping entries | Both ranges plus a unique merged source anchor when it fits. Apply both intended changes to one `newText`. |
| Empty anchor | Explain insertion anchoring and give a context-read call. |
| No change | Explain that the output is identical; do not repeat the same call. |
| Replacement already appears | Report its locations as a clue, not proof that the intended change is complete. |

A failed batch starts with, for example:

```text
[edit failure: not-found]
Batch status: 0/2 replacements written. Fix edits[1] and resubmit the complete batch against the original file; no earlier replacement was applied.
```

Only snippets explicitly presented as retryable may be copied directly into `oldText`. Low-confidence, competing, stale, oversized, or omitted candidates require verification. Suggested `read_symbol` calls get the enclosing source declaration without another search for its boundary. Similarity scores are heuristics, not probabilities.

### Verified read evidence

For repeated **literal** text, edit can select an occurrence only when exactly one tracked occurrence is fully contained in the newest verified same-file read result in Pi's active, compaction-aware **stored session context**.

Both readers participate:

- Built-in `read`: reproduce its current LF-normalized output and truncation format.
- `read_symbol`: regenerate the result from the original arguments and current source. Snapshot, selection, envelope, and displayed source must all agree. Result `details` alone are never trusted.

Only displayed source is evidence. Outline entries, unseen parts of partial symbols, and omitted final newline separators are not. The newest same-file failed, missing, malformed, or stale result blocks fallback to an older read. Retained-tail compaction messages are supported when the host exposes them. Canonical paths support symlink aliases.

This verifies stored context, not the final provider payload: other extensions can remove messages or rewrite requests. Built-in BOM-bearing read output remains conservatively rejected; `read_symbol` deliberately strips a UTF-8 BOM and normalizes CRLF before parsing and snapshotting. Fuzzy-equivalent ambiguity and highly repetitive files fail closed.

## Edit safety and compatibility

The matching engine preserves exact-first/fuzzy-fallback behavior, fuzzy-space uniqueness, original-file batch matching, overlap/no-change checks, CRLF restoration, and UTF-8 BOM preservation. Success details keep Pi's `diff`, `patch`, and `firstChangedLine` shape; the built-in edit renderer is inherited.

Intentional safeguards include 1–100 replacements per call, rejection of empty/fuzzy-empty anchors, and rejection of invalid UTF-8 or NUL-containing files. Self-overlapping strings retain Pi's non-overlapping occurrence-counting policy. The pure compatibility shim accepts array, JSON-string, single-object, and legacy top-level edit arguments.

Both tools use the **local filesystem**. They do not inherit an SSH, container, or sandbox backend. File mutations use Pi's shared mutation queue. Immediately before writing, edit rechecks file identity and content to catch many external changes.

The final write remains an **in-place overwrite**, not a cross-process lock, race-free compare-and-swap, or crash-safe atomic transaction. Another process can change a file after the check. A rejected write may leave the file unchanged, partially written, or fully written: inspect it before retrying. A resolved write is the commit boundary; later cancellation cannot roll it back. In-place writes preserve existing symlink/hard-link semantics.

Edit diagnostics stay below Pi's 50 KiB / 2,000-line limits. Snippets are omitted atomically when needed, and similarity work is bounded. Renderer `details.diff` and `details.patch` remain complete rather than being blindly truncated.

## Development

Tested against `@earendil-works/pi-coding-agent` 0.82.1. Pi/typebox peer dependencies remain wildcard ranges, as Pi's packaging guidance requires. Re-run the read-format, session-evidence, and renderer compatibility tests on host upgrades.

```bash
npm run check --workspace @khanhicetea/pi-better-tool
npm pack --dry-run --workspace @khanhicetea/pi-better-tool
```

Tests cover existing edit behavior, recovery round-trips, syntax boundaries across languages, nested/duplicate symbols, pagination, encoding/size failures, cancellation, and read-to-edit evidence.

## License

MIT

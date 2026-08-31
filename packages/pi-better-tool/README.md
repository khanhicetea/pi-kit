# pi-better-tool

Better built-in tools for the [pi coding agent](https://github.com/earendil-works/pi-mono) — starting with an `edit` override that turns failed edits into recoverable ones.

## Why

The built-in `edit` tool requires `edits[].oldText` to match **exactly and uniquely**. When it doesn't, the tool fails with a bare error:

```
Could not find edits[1] in /code/app.go. The oldText must match exactly including all whitespace and newlines.
```

That failure wastes a whole loop: the model has to `read` the file again, guess a larger context, and retry — sometimes failing again. `pi-better-tool` keeps the refusal (writing the wrong occurrence would be worse) but returns **recovery context** so the next call succeeds without re-reading:

- **Ambiguous match (2+ occurrences)** — bounded occurrence line numbers plus the **minimum prefix/suffix context** that makes the first few occurrences unique, rendered as ready-to-use `oldText` snippets when they fit safely.
- **Text not found** — the closest matching region (fuzzy line similarity), a line-by-line comparison against your `oldText`, the exact file bytes to retry with, and likely causes (tabs vs spaces, indentation, case).

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

```text
Found 2 occurrences of the text in dup.go. The text must be unique. Please provide more context to make it unique.

Occurrences:
  1. lines 2-3
  2. lines 6-7

Retry with a disambiguated oldText: pick ONE occurrence below and reuse its snippet exactly. Each snippet already includes the minimum surrounding context that makes it unique:

Occurrence 1 (lines 2-3) — minimum context: 0 lines before, 1 line after:
```
	log()
}

func second() {
```

Occurrence 2 (lines 6-7) — minimum context: 0 lines before, 0 lines after:
```
	log()
}
```

Tip: use the snippet byte-for-byte as the new oldText, and make newText the snippet with your change applied (the snippet may span whole lines).

No changes were written — the file was not modified.
```

## Example: text not found

```text
Could not find the exact text in tabs.go. The old text must match exactly including all whitespace and newlines.

Closest match in the file: lines 3-5 (~91% line similarity).
Differences vs your oldText (2 of 3 compared lines match):
  file line 4 differs from your oldText line 2:
    file:     →tab→fmt.Println("hi")
    oldText:      fmt.Println("hi")

Exact file content at lines 3-5 — retry using this text as oldText (then apply your change to newText):
```
func main() {
	fmt.Println("hi")
}
```

Possible cause:
- whitespace mismatch: the text matches when ALL whitespace is removed — check tabs vs spaces and indentation width

No changes were written — the file was not modified.
```

## Behavior

Happy-path semantics are **identical** to the built-in `edit` tool:

- same schema (`path` + `edits[{oldText,newText}]`), including the compatibility shim for models that send `edits` as a JSON string, a single edit object, or legacy top-level `oldText`/`newText`
- same matching engine ported from pi's `edit-diff.ts`: exact match first, fuzzy fallback (trailing whitespace, smart quotes, dashes, unicode spaces), uniqueness checked in fuzzy-normalized space, all edits matched against the original content, overlap/empty/no-change detection
- same BOM and CRLF handling
- same success result shape (`details.diff` / `details.patch` / `details.firstChangedLine`), and no custom renderers — the built-in diff renderer is inherited

Failure behavior is the difference: errors carry the recovery context described above, and nothing is written on failure (edits remain atomic).

Diagnostics degrade gracefully: files over ~2 MB skip the analysis and return the plain built-in-style error; repeated blocks that cannot be disambiguated within 12 context lines get a guidance note instead of snippets. Complete diagnostic output is bounded below pi's 50 KB / 2,000-line tool-output limit. Oversized exact snippets are omitted with a line range instead of being presented as copyable text, and low-confidence or non-unique closest matches require verification before retrying.

## Development

```bash
npm run check     # typecheck + tests
npm test          # vitest only
```

## Publishing

From the repository root, verify the package and inspect its tarball before publishing:

```bash
npm run check --workspace=@khanhicetea/pi-better-tool
npm pack --dry-run --workspace=@khanhicetea/pi-better-tool
npm publish --workspace=@khanhicetea/pi-better-tool
```

The package is configured for public publishing under the `@khanhicetea` scope. npm authentication is required.

## License

MIT

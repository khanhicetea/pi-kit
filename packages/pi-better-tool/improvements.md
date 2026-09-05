# pi-better-tool: audit and implementation backlog

> **Implementation status (2026-09-05):** Addressed in the working tree. The implementation keeps direct in-place writes to preserve symlink/hard-link semantics, adds an explicit commit boundary and indeterminate-write errors, validates UTF-8/NUL input, bounds complete Markdown output and similarity work, compares distinct candidates, preserves original comparison text, handles retained-tail fixtures when exposed, strengthens read evidence and schemas, and expands regression coverage. Final provider-payload visibility and cross-process/crash-safe atomicity remain documented limitations rather than guarantees.

## Scope and handoff

Static audit of package version **0.2.1**: all seven `src/*.ts` files, all four test files, `README.md`, `package.json`, and `tsconfig.json`. Also consulted the installed Pi extension/session/package documentation and tool-override example.

**No scripts, tests, builds, installs, or benchmarks were run.** Examples below are source-derived regression cases, not executed reproductions. References use file paths and symbols so they remain useful as line numbers change. Paths are relative to this package unless otherwise stated.

Priority: **P1** = mutation safety or misleading recovery; **P2** = robustness, performance, or compatibility; **P3** = polish. Separate intentional changes to built-in matching semantics from bug fixes; obtain approval before changing those semantics.

### Preserve these strengths

- Read/analyze/write are already inside Pi's shared `withFileMutationQueue`. Pi documents that this helper canonicalizes existing symlink targets; do not introduce a second, incompatible queue.
- Matching failures are structured and all replacements are analyzed before any write.
- Read-based selection already requires a verified bounded read and declines many unsafe cases.
- Failure diagnostics already limit file size, snippet size, occurrence listings, and final output.
- Built-in renderer inheritance and the `EditToolDetails` result shape are intentionally preserved.

## 1. P1 — Distinguish pre-write failure from committed edits

**Evidence:** `src/tool.ts`, `executeBetterEdit`: after `await fsWriteFile(...)`, the function calls `throwIfAborted()`, generates both diffs, and formats success diagnostics. Any exception at those stages is reported as a failed tool call even though the file was modified. The README claims nothing is written on failure.

**Impact:** Cancellation during an in-flight write can produce an ordinary “Operation aborted” after a successful mutation. A subsequent retry may change another occurrence or otherwise misinterpret the file state. Optional diagnostic formatting also runs after the mutation.

**Implementation:** Define an explicit commit boundary. Prepare required result data before committing where practical; make optional success diagnostics best-effort. After a completed write, do not report a generic pre-commit cancellation. Preserve the existing rule that the queue stays held until in-flight filesystem work settles. If Pi's outer cancellation handling prevents delivery of a success result, document that limitation accurately rather than promising rollback.

**Acceptance:** Add controlled filesystem/formatter seams and cases for abort before read, before write, during write, and after commit; inject a formatting failure. Assert final bytes and reported commit status in each case, plus successful execution of a later queued edit.

## 2. P1 — Narrow the atomicity claim and address filesystem write failures

**Evidence:** `src/tool.ts` directly overwrites using `fsWriteFile`; only the preliminary `fsAccess` receives contextual error wrapping. There is no rollback, temporary-file commit, or check for changes by writers outside Pi's queue. The existing “atomic” test verifies analysis failure, not filesystem failure.

**Impact:** A failed overwrite can leave a truncated/partially written file. External editors and other processes do not participate in the in-process queue and their changes can be overwritten. These are filesystem-hardening gaps, not evidence that the shared queue is broken.

**Implementation:** Immediately clarify the README: replacement validation is all-or-nothing, but crash-safe filesystem atomicity and cross-process coordination are not guaranteed. Evaluate a same-directory temporary-file/rename strategy with an explicit policy for permissions, symlinks, hard links, ownership, and Windows behavior. A pre-commit content/identity check can catch many external modifications, but must not be described as a cross-process lock or fully race-free compare-and-swap. Wrap read/write/realpath failures with path, operation, and an honest statement of whether modification may have occurred.

**Acceptance:** Fault-injection cases for partial write/rejection, target disappearance, external modification, and symlink behavior. Do not ship a naive rename implementation that replaces a symlink or silently changes hard-link semantics.

## 3. P1 — Bound complete success output, including Markdown fences

**Evidence:** `src/diagnostics.ts`, `formatAutoDisambiguationSuccess`, allows four resolutions times four snippets. It limits each snippet body to 2,500 bytes but has no final output budget. `fenceFor` chooses a fence longer than every backtick run, and `renderSnippet` emits that fence twice. A near-limit backtick run can roughly triple rendered size, pushing the combined result past Pi's 50 KB limit. Success diagnostics also lack the large-content guard used by failure diagnostics.

**Implementation:** Use a shared byte/line-budgeted output builder for both success and failure. Budget headings, fences, separators, and omission notices, not just snippet bodies. Add snippets atomically; omit a whole snippet instead of cutting its fence. Skip expensive post-edit expansion on oversized content and retain the essential success/selection summary.

**Acceptance:** Four resolutions with four long-backtick candidates each; multibyte UTF-8; maximum-line snippets; large files. Every result stays below the documented limits and every copyable fence is complete. Keep `details.diff`/`patch` compatible with the renderer; audit those separately rather than blindly truncating patches.

## 4. P1 — Do not equate one high-scoring candidate with unambiguous intent

**Evidence:** `src/similarity.ts`, `findClosestRegion`, returns only the best region. `src/diagnostics.ts`, `formatNotFound`, labels it directly retryable when its score is at least 0.75 and its exact snippet is unique. It never compares a runner-up. Two similar functions may each have unique text while being equally plausible targets of a misspelled `oldText`.

**Impact:** The model receives an instruction to retry against whichever plausible region wins the ordering/tie-break, potentially editing the wrong function. This does not auto-write anything, but undermines the safety of the recovery advice.

**Implementation:** Distinguish “unique under edit matching” from “confidently identified intended region.” Track distinct competing regions and require meaningful score separation before direct-retry wording. Overlapping windows around the same block should not count as independent alternatives. Otherwise show bounded alternatives and require verification. Similarity percentages are heuristic scores, not probabilities.

**Acceptance:** Equal-scoring near-duplicate functions, a small score gap, and a clearly superior match. Ties must not instruct an unconditional direct retry; candidate ordering should be deterministic.

## 5. P2 — Render line comparisons from original text, not fuzzy-normalized text

**Evidence:** `src/similarity.ts` converts both inputs through `toFuzzyLines` and passes those strings to `alignLines`. Its `AlignOp.fileText` and `oldText` therefore contain normalized quotes, Unicode compatibility characters, and trimmed trailing whitespace. `formatNotFound` prints these as “file” and “oldText” lines. The final fenced snippet is separately sliced from original normalized content, so the snippet and comparison can disagree.

**Implementation:** Keep original LF-normalized lines alongside prepared fuzzy lines. Score and align with normalized representations, but attach original strings to alignment operations. Show invisible whitespace explicitly in comparison-only displays, and distinguish exact equality from approximate similarity. Never apply display escaping to retryable snippets.

**Acceptance:** A not-found query with indentation drift plus smart quotes, tabs, and trailing spaces. Printed differences reflect the actual two inputs; the fenced snippet still round-trips through the edit engine unchanged.

## 6. P2 — Handle retained compaction messages when exposed and qualify model-visibility claims

**Evidence:** The audited implementation only examined entries with `type === "message"`. Some newer/harness session formats document compaction entries with `retainedTail`; the classic extension-facing `ReadonlySessionManager` in the tested Pi version does not expose `buildSessionContext()`. Separately, `buildContextEntries()` represents stored active history, not necessarily the messages after `context` hooks or provider-payload rewriting.

**Impact:** Valid retained reads lose auto-disambiguation after compaction. Conversely, a stored read that another extension removes from outgoing context can still be treated as visible. The README's “still in active context” statement needs a precise boundary.

**Implementation:** Use a supported context-materialization API if exposed to this extension, or a small tested adapter for retained-tail entries; do not scan all history or resurrect discarded reads. Decide whether evidence means stored active history or actual outgoing model-visible messages. If the latter cannot be guaranteed across extension hooks, document the limit and consider a conservative opt-out for read-based selection.

**Acceptance:** New retained-tail compaction, legacy `firstKeptEntryId` compaction, fork/tree navigation, discarded reads, retained tool results without their calls, and a context hook that removes a read. No fallback to old intent when the newest same-file evidence cannot be verified.

## 7. P2 — Add direct, realistic read-evidence tests

**Evidence:** There is no dedicated `test/read-evidence.test.ts`. Current read-selection tests construct short handcrafted outputs and cover selection, remaining-count bounds, broad reads, and one stale-output case. The verifier reproduces built-in read formatting and truncation using normalized, BOM-stripped content.

**Implementation:** Generate fixtures through Pi's real built-in read tool where possible, then pass its output through the verifier. Add typed session fixtures instead of `any[]` and `as never` for the important lifecycle cases. Explicitly decide whether BOM/CRLF normalization should permit evidence or conservatively reject it; current documentation says “byte-verified” despite LF normalization.

**Acceptance matrix:**

- Default line truncation, byte truncation, first line exceeding the byte limit.
- User limits, reads to EOF, terminal newline, no terminal newline, BOM, CRLF, multibyte characters.
- An occurrence touching or crossing the visible boundary, including trailing newline handling.
- Same-line duplicates, fuzzy/Unicode aliases, multiple selected edits, and overlap after selection.
- A newer unverifiable read plus an older valid one; failed reads and unrelated files.
- Missing call/result pairs, altered/multiblock output, path aliases, symlink resolution failure.

These are coverage gaps, not claims that every listed case is currently broken.

## 8. P2 — Add computational budgets, not just output limits

**Evidence:** `findClosestRegion` ranks roughly three window sizes across up to 10,000 file lines and 300 query lines. Each positional comparison iterates a bigram map. The file-size guard does not cap query bytes or per-line feature work. `countFuzzyOccurrences` allocates via `split`; ambiguity offsets are fully materialized. `executeBetterEdit` repeatedly normalizes/rescans all edits as each ambiguity is resolved. All this runs synchronously while the mutation queue is held.

**Implementation:** Introduce explicit limits on diagnostic query bytes, per-line preparation, comparison operations, and expansion work. Fall back to concise range-based guidance when exhausted. Cache fuzzy content, normalized needles, and line spans within a call. Use allocation-light counting with early termination where only uniqueness is needed, and separate bounded occurrence display from total counting. For cancellation during expensive CPU work, periodic signal checks alone are insufficient without yielding to the event loop; use bounded chunks if needed.

**Acceptance:** Deterministic work-budget tests for long single lines, near-limit files, repetitive content, large edit batches, and oversized queries. Keep a small performance smoke test, but do not rely solely on the existing five-second wall-clock test to prove boundedness.

## 9. P2 — Specify and test edge-case matching semantics before claiming full parity

**Evidence:** `src/text.ts` counts non-overlapping occurrences (`split`, and advancing by `needle.length`). For content `aaa` and needle `aa`, it reports one occurrence despite two possible starting offsets. This may intentionally mirror Pi; it is a compatibility decision, not automatically a regression. Separately, the fuzzy overlay assumes `splitLinesWithEndings(original)` and fuzzy line spans have equal length. A whitespace-only final unterminated line can disappear after `trimEnd`, invalidating that assumption.

**Implementation:** Add a parity decision table and targeted tests before changing matching behavior. Investigate a fuzzy edit on `value   \nnext\n   ` using `oldText: "value\nnext"`: normalization removes the final whitespace-only line from the span representation, leading the overlay to reject with its line-count error. Preserve untouched trailing bytes without assuming identical nonempty-line arrays. Explicitly document any intentional divergence for self-overlapping needles, whitespace-only needles, and fuzzy changes to other characters on a touched line.

**Acceptance:** The trailing-whitespace fixture preserves the final spaces; mixed exact/fuzzy edits preserve untouched regions; overlap ambiguity has a documented policy and tests. Expand built-in differential coverage beyond the current three happy-path fixtures, including Unicode/NFKC, EOF, mixed endings, no-change, and failure categories.

## 10. P1 — Reject unsafe text encodings before rewriting

**Evidence:** `executeBetterEdit` decodes every buffer with `buffer.toString("utf-8")` and rewrites the whole file as UTF-8. Invalid UTF-8 is replaced during decoding; matching an unrelated valid ASCII region can therefore corrupt bytes elsewhere in the file. There is no explicit binary/encoding gate.

**Implementation:** Validate UTF-8 without silently replacing invalid sequences and refuse unsupported encodings before mutation. Define a conservative policy for binary/NUL-containing files. Preserve the existing UTF-8 BOM behavior. Treat this as a safety improvement that may differ from built-in behavior, not as a reason to silently transcode files.

**Acceptance:** Invalid UTF-8 outside a successfully matching region, UTF-16 input, valid non-ASCII UTF-8, and UTF-8 BOM. Rejected files remain byte-identical and receive actionable encoding guidance.

## 11. P3 — Tighten integration contracts and documentation

**Evidence and actions:**

- `package.json` pins Pi 0.82.1 only for development while using wildcard peers. **Wildcard Pi/typebox peers follow Pi's packaging guidance; do not blindly replace them or bundle Pi.** Instead document the minimum/tested host versions and test required exports and read-format compatibility when upgrading. Track the upstream source/version of copied matching and path helpers.
- `tool.ts` uses direct local filesystem operations. Document that this override does not inherit an SSH/container/custom edit backend. If remote support is desired, add an explicit operations adapter with a matching read-evidence identity policy; never silently mix local writes with remote reads.
- `betterEditSchema` accepts an empty edits array although execution rejects it. Consider `minItems: 1` and basic path validation; preserve empty `newText` for deletion. Test preparation idempotence and malformed shapes. `prepareEditArguments` currently mutates parts of the input; prefer a documented pure normalization contract if compatible with Pi.
- The blanket prompt guideline says failures already contain retryable context and to retry without rereading, whereas low-confidence, oversized, and no-match diagnostics explicitly require a read. Qualify that instruction and ensure every guideline names `edit`, as Pi appends them without a tool-specific heading.
- README examples nest triple-backtick fences inside triple-backtick fences and contain older wording. Use longer outer fences and examples reflecting current output; explain that snippets are LF-normalized rather than literally original CRLF bytes.

**Acceptance:** Registration tests assert the safety exceptions in prompt guidance and schema constraints. Documentation matches implemented limits and failure guarantees, describes local-backend scope, and renders examples correctly.

## Suggested implementation sequence

1. Fix commit-state reporting, encoding safeguards, and output budgeting; narrow the atomicity documentation immediately.
2. Improve candidate-confidence wording and original-text comparisons.
3. Add realistic read-evidence tests, then handle retained-tail entries where exposed and qualify visibility claims.
4. Add resource budgets and matching edge-case regressions.
5. Complete compatibility/documentation cleanup; evaluate stronger filesystem commits as a separately reviewed change.

For each change, the implementing agent should report changed files, the new regression cases, checks actually run, remaining risks, and any intentional departure from Pi's built-in semantics. This audit itself authorizes no source implementation and reports no passing tests.

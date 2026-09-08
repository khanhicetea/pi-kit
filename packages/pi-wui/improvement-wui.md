# pi-wui improvement ideas

Date: 2026-09-08  
Reviewed package: `packages/pi-wui`, version `0.1.5`

## Summary

Focus first on **safe form recovery**, **smaller agent responses**, and **consistent UI composition**. Then improve report navigation and prototype review.

These are proposals, not implemented features or measured performance results. This review used source code and package documentation. It did not run a browser audit, user study, or token benchmark.

## Current strengths to preserve

The package already provides:

- Lazy server startup and additive tool loading through `wui_load`.
- Targeted component documentation rather than the complete catalog in every prompt.
- State reads by JSON Pointer and state updates without resending the full spec.
- Stable view IDs, view history, reconnects, and a 15-minute mounted-view cache.
- Submit/cancel acknowledgements and pending/finished button labels.
- Light, dark, and system themes; responsive layouts; accessible chart data.
- Local asset staging and isolated HTML previews with scripts disabled by default.
- A shared service and contracts for Pi and MCP.

Do not rebuild these features under new names. Extend them where the current contracts leave a gap.

## Priority overview

Effort is relative: S = localized change; M = several modules; L = protocol or rendering work with broad tests.

| Priority | Idea | Main benefit | Effort |
| --- | --- | --- | --- |
| P1 | 1. Show draft sync and recovery status | Prevent lost user work | L |
| P1 | 2. Bound and select agent-visible state | Save tokens; protect context | M |
| P1 | 3. Add task-specific authoring guides and recipes | Reduce generation and repair work | M |
| P1 | 4. Add browser interaction regression tests | Protect end-user reliability | M |
| P2 | 5. Support atomic spec patches | Make UI revisions smaller | L |
| P2 | 6. Make history easier to navigate | Reduce interruptions and search time | M |
| P2 | 7. Make form deadlines and completion clear | Reduce expired or uncertain submissions | M |
| P2 | 8. Add a report reading and export layer | Make results easier to use and retain | M |
| P2 | 9. Add prototype inspection controls | Shorten design review loops | M |
| P3 | 10. Bound inactive-view resource use | Keep long sessions responsive | M |

## 1. Show draft sync and recovery status

**Evidence:** `src/web/App.tsx`, `ViewRenderer` debounces full-state updates by 300 ms. `usePortalConnection.updateState` calls `send` but does not act on its boolean result. The connection badge reports the socket state, not whether the latest field edits reached the server.

**Proposal:**

- Show `Saving`, `Saved`, and `Unsynced changes` near interactive forms.
- Acknowledge state updates with a sequence number. Mark a draft saved only after acknowledgement.
- Retain unsent edits in memory during disconnects. On reconnect, compare the server revision before restoring them.
- If the agent changed the form, let the user choose how to handle conflicting edits. Do not overwrite either side silently.
- Keep submit disabled while delivery is unavailable. Never automatically replay submit/cancel actions as if they were harmless state updates.
- Consider session-storage draft recovery as an explicit option, with size limits and a clear-data control. Exclude sensitive fields by default.

**Acceptance:** Test disconnect while typing, reconnect after a server update, refresh before the debounce fires, and two connected browser tabs. The UI must not display `Saved` for an unacknowledged draft.

**Implementation area:** `src/web/App.tsx`, `src/shared/protocol.ts`, server message handling, and browser tests.

## 2. Bound and select agent-visible state

**Evidence:** `src/wui-service.ts`, `stateResult` returns complete state unless one pointer is supplied; `feedbackResult` returns complete submitted state. `src/tool-contracts.ts` has one optional read path and no feedback projection. `src/index.ts`, `handlePassiveSubmission` serializes form state and then passes it to `truncateForAgent`, with a 32,000-character cap configured in the module.

**Proposal:**

- Add an optional list of return paths for feedback and state reads. A form could return `/answers` without returning its chart data or option lists.
- Add explicit response modes: `summary`, `selected`, and `full`. Preserve existing behavior until a documented migration.
- Return compact update receipts containing view ID, revision, and changed paths when the caller does not need the full state.
- Apply a shared output budget across Pi and MCP. For large results, return valid structured metadata, an explicit truncation flag, and a session-scoped retrieval handle with bounded pagination.
- Preserve the original submitted snapshot behind the handle. A later live-state read is not necessarily the same data.
- Keep cancellation, timeout, and error outcomes explicit in every compact response.

**Acceptance:** A form with large display-only data returns every selected answer without that display data. Oversized results remain recoverable and do not become cut-off JSON. Test escaped JSON Pointer segments and missing paths.

**Token impact:** This can reduce tool-result tokens. Measure actual serialized model input; smaller browser messages alone do not prove token savings.

## 3. Add task-specific authoring guides and recipes

**Evidence:** `skills/wui-design/SKILL.md` requires the complete common catalog reference before catalog composition. The public `WuiParameters` contract accepts a full element graph. Targeted component discovery already exists.

**Proposal:**

- Split common guidance into small, versioned task sections: form, report, chart, and HTML prototype. Keep the security and binding rules in one shared core.
- Let component discovery optionally return just the schema, or the schema plus one example. Keep an explicit complete mode.
- Start with tested recipe examples: comparison report, decision form, KPI dashboard, and prototype comparison.
- If benchmarks justify it, add a few server-expanded recipes. The agent supplies content and data; the package supplies the repeated layout graph.
- Use deterministic expansion into the existing validated spec. Do not create a second arbitrary scripting language.
- Keep a raw-spec escape hatch. Recipes should not constrain bespoke work.

**Acceptance:** Compare the same tasks with the current workflow. Record guide tokens, generated argument tokens, tool calls, validation failures, and human-rated UI quality. Reject shorter workflows that increase repair attempts or omit important controls.

**Caution:** Loading more tools or dynamically replacing tool groups can have provider-specific cache costs. Preserve the existing additive loader behavior unless measurements support a change.

## 4. Add browser interaction regression tests

**Evidence:** `package.json` runs `tsx --test test/*.test.ts`. Its coverage command explicitly excludes `src/web/**`. The package has server, tool, MCP, and browser-helper tests, but those checks do not by themselves demonstrate complete browser interaction coverage.

**Proposal:**

- Add a small browser suite using deterministic local fixtures.
- Cover keyboard-only form submission, validation focus, theme switching, narrow layouts, reconnect recovery, history navigation, and iframe isolation.
- Add visual baselines for a form, a dense report, a chart dashboard, and a multi-preview layout.
- Run automated accessibility checks, then manually verify focus order and screen-reader announcements.
- Test at narrow phone, tablet, and desktop widths. Include long labels and large text, not only ideal demo content.

**Acceptance:** The suite must detect a lost draft, an inaccessible submit control, unintended page-wide horizontal overflow, and a sandbox policy regression. Avoid brittle screenshot assertions for dynamic timestamps.

## 5. Support atomic spec patches

**Evidence:** `src/tool-contracts.ts` exposes state `set`/`remove` operations, but `wui` takes a full spec for structural changes. Existing stable IDs identify a view, not an individual structural edit transaction.

**Proposal:** Add bounded element operations such as updating props, replacing children, and adding/removing elements. Require a view ID and expected revision. Apply the batch to a copy, validate the complete resulting graph, then commit atomically.

Keep state-only changes on `wui_update_state`. Reject stale revisions with a small conflict response and a targeted retrieval path. Preserve unaffected form state and component instances where safe.

**Acceptance:** Changing one chart title does not require the full dashboard spec. Invalid references, cycles, and stale revisions leave the current view unchanged. Measure tokens and repair calls against full replacement.

**Trade-off:** Patch semantics add complexity. Build this after reliable sync and revision handling, not before.

## 6. Make history easier to navigate

**Evidence:** `src/web/App.tsx`, `App` maps history entries into topbar buttons. Incoming active views pass through `activateRecentView`, which makes automatic navigation an important behavior to review.

**Proposal:**

- Add a searchable history drawer with title, time, type, and status.
- Show visible `Needs input`, `Submitted`, and `Expired` labels, not only dots or hover text.
- Let users remain on an older view while the agent publishes another. Show a `New view available` control instead of always changing their reading context.
- Add local pin/hide controls. Explain that a browser pin does not extend server retention unless that is explicitly supported.
- Preserve keyboard focus and scroll position when switching views.

**Acceptance:** With 30 history entries, users can find an unfinished form and return to their report without an agent call. Test updates while the user is typing in an older form.

## 7. Make form deadlines and completion clear

**Evidence:** `WuiParameters.feedback` supports a timeout from 5 to 3,600 seconds, with a 600-second default. `ViewFeedbackStore.createPending` starts the timeout when pending feedback is created. `applyActionButtonUx` already handles submitting, submitted, cancelled, and expired labels.

**Proposal:**

- Add a form-level status strip with the deadline and a clear completion receipt.
- Show a warning near expiry. Avoid screen-reader announcements every second.
- Explain whether the agent received the form and whether the user can still edit it.
- On expiry, preserve draft visibility and offer an explicit request to reopen. Reopening must create a new request identity; do not silently revive an expired request.
- Consider an optional bounded delivery grace period before the first authenticated display. Do not let absent browsers keep feedback requests alive indefinitely.

**Acceptance:** Test opening a form near its deadline, server receipt with a delayed acknowledgement, cancellation, and session shutdown. Completion receipts must remain unambiguous.

## 8. Add a report reading and export layer

**Evidence:** The README documents Markdown, tables, charts, and links as composition primitives. The inspected portal shell provides history, connection status, and theme controls, rather than a dedicated report toolbar.

**Proposal:**

- Add optional report metadata: summary, generated time, data time range, assumptions, and sources.
- Provide an on-page section index for long reports, plus compact/comfortable density controls.
- Add a source-list recipe with title, domain, URL, and access date. Distinguish source-backed facts from agent interpretation; never fabricate provenance.
- Add user-triggered copy, print, Markdown export, and table CSV export. Clearly label filtered exports versus full data.
- Keep browser reading controls local so sorting, filtering, and expanding details do not trigger model turns.

**Acceptance:** Users can inspect evidence and export a useful report after generation without asking the agent to rewrite it. Exported files must not contain capability tokens, temporary server URLs, or hidden form state. Defend spreadsheet exports against formula injection.

**Scope:** Start with catalog reports. Exporting arbitrary scripted sandboxes safely is a separate problem.

## 9. Add prototype inspection controls

**Evidence:** The README and `HtmlFileAttachmentParameters` expose responsive/mobile/tablet/desktop viewports and staged HTML files. The package already supports several prototypes in one comparison grid.

**Proposal:**

- Add portal-side viewport switching, fit-to-panel zoom, and fullscreen inspection without regenerating HTML.
- Show the effective viewport width and whether scripts are enabled.
- Add a bounded review action: select a concept, attach a short comment, and submit one structured response.
- Provide clear fallback text when preview loading fails. Do not claim to know iframe-internal errors that the opaque-origin boundary prevents the portal from reading.

**Acceptance:** A user compares one concept at several widths and sends one review response with no new generation call. Preserve opaque-origin sandboxing; do not add `allow-same-origin` just to inspect preview internals.

## 10. Bound inactive-view resource use

**Evidence:** `src/web/App.tsx` mounts every retained view through `ViewRenderer`, including inactive panes. The existing 15-minute cache preserves iframe and component instances for fast tab restoration.

**Proposal:**

- Add an explicit maximum number of mounted views alongside the time limit.
- Evict least-recently-used inactive views while protecting pending forms and unsynced drafts.
- Separate serializable catalog state from expensive mounted renderer instances.
- Explain when unloading an HTML preview will reset its internal state; arbitrary sandbox state cannot be assumed serializable.
- Measure before choosing defaults. A time limit alone does not establish an acceptable memory limit.

**Acceptance:** Compare memory, CPU, and tab-switch latency with many chart and scripted-preview views. Confirm that the chosen limit does not erase pending form input.

## Delivery plan

1. **Establish a baseline:** fixed form/report/prototype fixtures; token counts; correction calls; browser timings; user task completion.
2. **First release:** bounded selected feedback, task-specific guide sections, browser regression tests, and clear form status.
3. **Second release:** acknowledged draft sync, conflict recovery, and less disruptive history navigation.
4. **Later releases:** atomic spec patches, report export, preview inspection, and measured cache limits.

Use local, opt-in metrics. Record sizes, timings, and outcome codes, not form contents or capability URLs. Test shared contract changes through both Pi and MCP, including their different feedback waiting flows.

## Success measures

- **End-user:** successful submissions, lost-draft incidents, time to find a view, and task completion without assistance.
- **Tokens:** total model input/output for the complete task, including guide reads, discovery, retries, and feedback—not just one smaller payload.
- **UI quality:** keyboard completion, mobile overflow, readability, clear source attribution, and understandable error recovery.
- **Runtime:** first-view latency, tab-switch latency, disconnected recovery time, and memory after repeated views.

Do not weaken sandboxing, validation, or user control to improve a token or latency metric.

# pi-dede audit and implementation handoff

## Scope and constraints

Static audit of `@khanhicetea/pi-dede` version `0.4.0`: source modules, README/SPEC, orchestration guidance, and selected existing unit/integration tests. No scripts, builds, tests, installs, or child processes were run. Findings below are source-derived, not runtime reproductions. Paths are relative to `packages/pi-dede/`; symbol names provide stable navigation anchors.

Preserve the current product boundary: synchronous bounded delegation, at most three running children, at most one mutation-capable child across calls, explicit continuation/resume, and no automatic retries or background-agent expansion. The existing separation of validation, transport, scheduling, lineage storage, and rendering is worth keeping.

**Priority:** P1 = correctness/reliability first; P2 = important robustness or contract fixes; P3 = optional follow-up. Implement each item narrowly, with focused regression tests. Tests described here are instructions for the implementing agent, not checks performed during this audit.

## P1 — Correctness and lifecycle

### 1. Finish immediately when the initial RPC prompt is rejected

**Evidence:** `src/rpc-child.ts`, `RpcChild.handleEvent()` and `finish()`.

The `response` branch sets `promptError` and calls `finish()`, but `finish()` returns unless `settled || exited`. A child that rejects a prompt and remains alive waiting for commands does not resolve `done`. The runner can wait until its deadline and report `timed_out`, offering a resume for a task that never started. This contradicts the transport's documented fail-fast behavior.

**Change:** Treat prompt rejection as a terminal outcome independently of process exit. Correlate the response with the initial command ID (`dede-task`) as well as its command type. Reap the process through the usual disposal path; do not create a timeout-resume capability.

**Acceptance:** A fake child emits only a rejected prompt response and stays alive. The result promptly becomes `failed`, includes the rejection reason, releases tracking/permits, and has no resume handle. Add a dedicated `test/rpc-child.test.ts` or focused integration case; the current fake-Pi tests primarily acknowledge prompts successfully.

### 2. Validate parsed JSON before reading event fields

**Evidence:** `src/json-events.ts`, `PiJsonCollector.processLine()`.

`JSON.parse(line)` is cast directly to an object, then `event.type` is accessed outside the parse catch. Valid JSON `null` throws here. Since collection happens in a stdout `data` listener, this can escape the tool promise and affect the parent process. Arrays and primitive JSON are also not valid protocol events but are not rejected consistently.

**Change:** Parse into `unknown`, require a non-null, non-array object and a suitable event type, and validate fields at each event boundary. Keep tolerant handling for unknown future event types. Separate malformed payload handling from failures in observer callbacks rather than swallowing every exception indiscriminately.

**Acceptance:** Feed `null`, strings, numbers, arrays, malformed event fields, and then a valid completion. Collection never throws for bad wire data, diagnostics remain bounded, and the valid completion still works. Extend `test/json-events.test.ts` beyond syntactically invalid JSON.

### 3. Serialize artifact directory initialization and coordinate cleanup

**Evidence:** `src/runner.ts`, `ArtifactManager.write()` and `cleanup()`; one manager is shared by parallel children in `src/index.ts`.

Two first writes can both observe `!this.directory`, independently await `mkdtemp()`, and overwrite the stored directory path. Only the last stored directory is cleaned up; the other directory, potentially containing a child's full answer, is orphaned. Cleanup can also race an in-flight initialization/write because `closed` is checked only before awaiting filesystem work.

**Change:** Use a shared initialization promise, local immutable directory references, and tracked in-flight writes. Shutdown must prevent new writes and drain or cancel already-started writes before removing every owned temporary directory. Clean up partially initialized directories on failure.

**Acceptance:** Concurrent oversized child outputs create one owned artifact directory, all returned paths are readable, and cleanup removes everything. Test cleanup during deferred initialization and a failed initialization followed by the chosen retry/failure policy.

### 4. Make disposal bounded and exception-safe, including process descendants

**Evidence:** `src/runner.ts`, `runChild()`, `ChildProcessManager.track()/terminate()`; `src/rpc-child.ts`, `close()/send()`.

After timed waits and `terminate()`, the runner still unconditionally executes `await child.closed`. Thus the advertised deadline is not a strict upper bound on waiting. Process tracking also ends on any process `error`, not just confirmed exit; termination is skipped once tracking disappears. Finally, the process lifecycle is not enclosed in a comprehensive `try/finally` after spawn.

Process-tree cleanup also needs explicit verification: a leader can exit while a background descendant remains, and tracking only the leader's `close` event is not proof that its process group is gone. This matters especially for workers and their mutation lease.

**Change:** Introduce an idempotent disposal operation with a finite total budget and explicit diagnostics when termination cannot be confirmed. Distinguish spawn failure, transport error, leader exit, and process-group cleanup. Always clear timers/listeners and attempt cleanup on exceptional paths. Do not silently release the writer safety invariant when descendants may still be mutating; choose an explicit fail-closed/quarantine policy.

**Acceptance:** Cover cancellation before prompt delivery, ignored abort/TERM, spawn failure, repeated disposal, a leader exiting with a background descendant, and a simulated missing `close` event. Ensure no indefinite tool wait and no overlapping live writers. Check Windows behavior separately; `spawnSync('taskkill', ...)` currently has no explicit timeout and blocks the parent event loop.

### 5. Distinguish pre-launch setup failures from failures after a lineage has run

**Evidence:** `src/index.ts`, per-agent catch block around `runChild()`; `src/resume.ts`, `release()`.

Any exception with an existing lineage lease calls `release()`, restoring its old capability. But exceptions can occur after the child has executed—for example, writing the oversized answer artifact can fail after settlement. Returning the old continuation index/resume state then misrepresents a conversation that has already advanced, and an agent may repeat mutations believing setup failed.

**Change:** Track launch/settlement phases explicitly or return a typed outcome that preserves them. Restore a claimed capability only when no task could have been delivered. After execution, transition using the actual outcome or consume the capability with a clear inspection diagnostic. Prefer making optional artifact failures non-fatal to an otherwise known child outcome.

**Acceptance:** Pre-spawn task-file failure preserves the capability and index. Post-run artifact failure does not roll the lineage back to its previous state. Preserve available result text, usage, and session identity in both cases.

## P2 — Observable contracts and integration safety

### 6. Reserve model-visible space for continuation handles and usable full-output retrieval

**Evidence:** `src/output.ts`, `childBody()/boundedChild()`; `src/runner.ts`, `DETAILS_TEXT_CAP`.

Successful output is assembled as context, session, answer, then continuation instructions. Head truncation removes the continuation handle whenever the answer fills the budget. Timeout instructions correctly precede partial output, but successful continuation instructions do not. Additionally, answers larger than the model-visible budget but smaller than 32 KiB have no artifact; “More text remains in structured tool details” is not a retrieval mechanism available to the model.

**Change:** Render a bounded metadata/control section before the answer and allocate an explicit remaining answer budget. Keep handles, session identity, truncation disclosure, and retrieval guidance visible even with long diagnostics/context strings. Provide a readable artifact or precise persistent-session retrieval route for model-truncated answers, not just for answers exceeding the structured-text cap.

**Acceptance:** A three-child result with long Unicode answers still exposes every continuation/resume handle and stays within byte/line limits. Cover oversized first lines, long errors/fallback reasons, and answers between the model-visible and 32 KiB limits in `test/output.test.ts`.

### 7. Preserve accounting and final state on cancellation and cleanup failures

**Evidence:** `src/index.ts`, `combinedSignal.aborted` check before the final return, `detailedUsages`, outer `finally`, and shutdown handler.

Completed child usage is returned only on the normal success path. If the parent aborts after a sibling has completed, execution throws instead of returning those totals/details. Also, failures removing a run directory can replace the otherwise completed return and skip subsequent footer bookkeeping. A failure during shutdown's directory removal can skip artifact/store cleanup.

**Change:** Investigate the supported Pi mechanism for retaining cancelled-run details and nested usage, and use it without turning cancellation into success. Structure cleanup as independent best-effort operations with guaranteed final bookkeeping; report cleanup failures separately from child execution failures. Track in-flight setup/execution so shutdown cannot finish while an asynchronous allocator subsequently creates new owned state. `ChildResumeStore.allocate()/allocateFork()` currently check `closed` only before their awaits.

**Acceptance:** One sibling succeeds with nonzero usage while another is cancelled: accounting is not silently lost. Inject directory-removal failure and shutdown during allocation; remaining cleanup still runs, footer state clears, and no late capability is added to a closed store. If the host API cannot persist usage for cancelled tools, document that limitation explicitly rather than promising complete accounting.

### 8. Expose trusted child CLI overrides as flag/value configuration

**Decision:** `additionalArgs` is a JSON object mapping flags to boolean or string values. `true` emits a boolean flag, `false` omits it, and a string emits a flag/value pair. This supports extension-defined options such as `"--fast": true` without needing pi-dede to know every extension's CLI surface.

**Constraints:** Positional prompts and malformed/NUL-containing flags remain rejected. The override map is trusted configuration: it may supersede pi-dede's own trailing CLI options, so the configuration owner is responsible for preserving RPC/session/tool lifecycle behavior. Any override makes auto context selection isolate the child, since prompt/model/tool fidelity cannot be established locally.

**Acceptance:** Cover extension-defined boolean flags, generic flag/value pairs, equals normalization, profile/global precedence, and invalid object values.

### 9. Verify fork compatibility beyond active tool names

**Evidence:** `src/fork-context.ts`, `captureMasterForkSnapshot()/forkIneligibility()`; `src/invocation.ts`; `src/child-runtime.ts`.

Fork eligibility captures active tool names but not definitions or provenance. A master-only dynamically registered tool may be absent in the child; a same-named override may have a different schema. The exact-system-prompt override is also just one `before_agent_start` handler: later child extensions can modify it. Master context hooks/provider payload rewrites are not reproduced by copying persisted session entries.

**Change:** Validate model identity, ordered tool metadata/schema fingerprints, and effective prompt information where the host exposes them. Prefer local validation or a bounded bootstrap-ready RPC event; do not add an LLM turn for a capability handshake or repeatedly recompute unchanged metadata. Make `auto` fall back with a specific reason when required compatibility cannot be established; make forced `fork` fail clearly. If byte-for-byte provider-prefix equivalence cannot be verified, describe it as best-effort rather than guaranteed. Keep cache-read metrics as observations, not proof of complete prefix equality. Measure validation overhead against the short-task budget described below.

**Acceptance:** Cover master-only dynamic tools, same-name/different-schema overrides, later prompt hooks, and modified context hooks. Existing fork integration tests inspect argv/environment and fake-child input; they do not demonstrate the real provider-visible tool/prompt surface.

### 10. Resolve the Pi executable explicitly

**Evidence:** `src/invocation.ts`, `resolvePiExecutable()`.

Any existing `process.argv[1]` is assumed to be Pi and relaunched with Pi CLI arguments. This works for ordinary CLI startup, but an SDK embedding or wrapper can have an unrelated application entrypoint, causing the host program to be launched again instead of Pi. The tests deliberately replace `argv[1]` with a fake script, so they reinforce this assumption rather than check it.

**Change:** Resolve a known Pi CLI entrypoint or provide an explicit trusted executable configuration/injection. Reuse `argv[1]` only when its identity is established. Retain supported standalone/Bun handling and produce an actionable error when no supported launcher is available.

**Acceptance:** Cover normal Pi CLI, Node SDK host, wrapper script, standalone binary, Bun virtual path, and unavailable executable. Avoid invoking an unrelated existing script.

### 11. Align public guidance and fork output contracts

**Evidence:** `src/schema.ts`, `AgentSchema.model.description`; `src/tool-definition.ts`; `src/profiles.ts`, `OUTPUT_CONTRACT` and `addForkTaskContract()`; `skills/pi-dede/SKILL.md`.

The model field description says omission uses profile defaults, while resolution and the tool guidelines use the master model for `auto`/`fork`. The skill's delegation gate says parallel lanes must be read-only, but its run-shape table permits one worker alongside scouts. Fork tasks include the word limit but omit the shared five-answer/eight-evidence-bullet contract and explicit uncertainty/recommendation rules that the SPEC claims both modes receive.

**Change:** Update the model field description with context-mode-aware precedence, explicitly including auto fallback behavior. Make the skill gate describe one writer plus genuinely independent read-only lanes. Share the output contract between isolated and fork task construction, keeping the fork's inherited system prompt untouched.

**Acceptance:** Add assertions for the actual schema description and fork task contract, not only isolated prompt assembly. README, SPEC, schema, skill, and examples agree on defaults and permitted run shapes.

## P3 — Focused follow-up ideas

### 12. Make runtime compatibility and failure tests explicit

**Evidence:** `package.json` uses wildcard Pi peer dependencies while development targets `0.82.1`; implementation depends on specific lifecycle, RPC, session, and tool-usage APIs. `test/integration.test.ts` uses a fake Pi protocol process; one timeout test shortens every global timeout via a spy.

**Change:** Establish and document a verified minimum Pi/Node version before tightening peer/engine ranges. Add an opt-in real-Pi smoke lane using a deterministic local provider, without paid model calls. Inject clock/spawn/filesystem seams for race and timeout tests instead of globally shortening unrelated timers. Prioritize regression cases from items 1–10 rather than adding broad snapshots.

**Acceptance:** A supported-version matrix covers actual bootstrap loading, tool blocking, settlement, persistent continuation, and shutdown. Unsupported versions fail with useful guidance rather than obscure missing-method errors.

### 13. Bound retained capabilities and improve diagnostics without expanding the workflow

**Evidence:** `src/resume.ts`, `pruneContinuations()` excludes timeout-resume records; `src/index.ts` footer counts only the process semaphore, excluding children waiting on the mutation semaphore; `src/runner.ts` sets first-event time through progress callbacks rather than every RPC event.

**Ideas:**

- Consider a separate bounded TTL/cap for abandoned timeout handles. This changes the current documented retention policy, so make it explicit and preserve inspectable session files. Deep-copy `additionalArgs` in `cloneAgent()` as well as tools/env to uphold immutable capability snapshots.
- Show writer-lock waits and queue duration separately from execution duration. Do not acquire a process slot early merely to improve the counter.
- Rename `timeToFirstEventMs` to match its current meaning, or measure the first parsed event and expose useful phase timings separately. Report malformed/oversized protocol counts and whether soft steering was merely sent or acknowledged.
- Clarify that the writer lease coordinates children in one extension runtime only—not master-side edits, other Pi processes, or external editors. Require disjoint scopes/current-state verification where readers run alongside a worker.

**Acceptance:** Long-lived sessions have documented retention bounds, queue UI includes lock-waiting children, metrics have precise definitions, and no new automatic retry/background workflow is introduced.

## Refined direction: short, economical delegation

This refinement incorporates `../pi-tactician/src/guidance.ts`. Its objective is **fewer necessary inference barriers**, not maximal fanout, maximal cache-hit percentage, or fewer tool calls counted in isolation. The recommendations here are design proposals, not additional confirmed bugs. They supplement—not replace—the lifecycle fixes above.

### 14. Choose between direct tools, a cheap isolated child, and a cached fork

**Starting seams:** `src/tool-definition.ts`, `skills/pi-dede/SKILL.md`, `skills/pi-dede/references/recipes.md`, `src/schema.ts`, `src/fork-context.ts`.

Current model resolution is cache-first: omitted model with `auto`/`fork` retains the master's model; profile model defaults apply only to explicit isolation. Consequently, configuring a cheap scout does not make an ordinary auto scout cheap. Preserve this compatibility behavior, but teach the master to choose intentionally:

| Work | Preferred route | Reason |
| --- | --- | --- |
| Known file read, grep, or one authorized test command | Direct tools; batch independent calls | Another model adds startup, input, output, and verification overhead without removing meaningful reasoning. |
| Named log/test-failure classification or bounded contract check requiring several reasoning/tool steps | Short isolated child with a configured cheaper model | Small task context can avoid several expensive master inference rounds. |
| Evidence task that genuinely needs substantial prior reasoning/history | Same-model auto/fork | A reusable prefix may be cheaper than rebuilding necessary context; measure rather than assume. |
| High-risk ambiguity, architecture decisions, or cross-cutting synthesis | Master | The master retains the decision; outsource only clearly separable evidence. |

Compare **total expected cost**: delegation setup + child input/cache/output + master handoff/verification + likely repair, versus direct master work. Also compare wall-clock critical path. A cheaper model that times out, needs repeated clarification, or returns unreliable evidence can lose both comparisons. A large cached fork can still cost more than a tiny isolated prompt.

Do not add a separate model-powered routing/planning call. Start with concise guidance and user-configured profile models. Use an explicit `contextMode: "isolated"` for deliberate cheap-model routing; keep auto/fork omission semantics clear. Avoid hard-coded model rankings/prices and automatic escalation. If later introducing an economy policy, make it opt-in, transparent, and distinct from context compatibility.

**Acceptance:** Guidance examples show all three routes and distinguish a trivial command from a small reasoning task. Model-resolution tests retain current semantics. Task scenarios reject delegation for a single lookup but allow an inexpensive child for bounded multi-step checking.

### 15. Make the short path actually short, without promising cache warmth

**Starting seams:** `src/runner.ts`, `src/schema.ts`, `src/profiles.ts`, `src/index.ts`.

Aim for tens of seconds for selected microtasks, not routine multi-minute assignments. For initial recipes, use a **60-second hard execution timeout**, a small scope, low thinking only when adequate, and an explicit completion boundary. This is an illustrative ceiling, not a performance claim. Do not globally shrink worker/reviewer limits before measurement.

Distinguish three things:

- **Parent cache retention:** returning promptly may improve the chance that the parent's prior prefix remains reusable on its next request. Retention, eviction, cache keys, and prefix matching are provider-dependent. There is no universal safe duration or guarantee.
- **Child prefix reuse:** same-model compatible forks may reuse a parent prefix; a cheaper different-model isolated child should not be assumed to share that cache.
- **Child continuation reuse:** a related continuation may reuse its own prior context, but growing lineage and revalidation have costs. Prefer a fresh small child for unrelated work.

The synchronous `Promise.all` in `src/index.ts` makes the slowest sibling hold the tool result. Group children of similar expected duration; do not attach a long investigation to a short check merely to fill a batch. Parent-independent tool work should be emitted as siblings where the host supports actual concurrent execution, not sequentially after delegation. Do not assume sibling tool calls execute concurrently without checking host behavior.

Execution timeout alone is not a total return budget: setup, writer/process queues, and disposal add time. First expose these phases, then consider a separate end-to-end deadline covering queue/setup/run/cleanup. Distinguish an expired queue wait from an executed-task timeout; do not offer a resume for work never delivered. If adding short-run tuning, replace the fixed 30-second soft-warning lead with a proportionally bounded lead so short tasks are not told to stop almost immediately.

**Acceptance:** Fake-clock tests cover short warning timing and deadline accounting, including queue waits. No keepalive model requests, automatic resumes, persistent background agents, or cache-warming traffic are introduced.

### 16. Apply Tactician readiness inside each child, with a compact evidence contract

**Starting seams:** `src/profiles.ts`, `src/profile-prompts/`, and the skill recipes.

Small children should not repeat the parent's entire discovery process. Supply one decision question, verified starting files/symbols, relevant trusted rules, required evidence, permitted actions, and a stop condition. Carry a short Tactician-compatible rule into isolated prompts and fork task suffixes: issue already-grounded independent calls together; wait only for information dependencies; sequence authorized dependent commands without an unnecessary reasoning turn. Do not paste the full Tactician guidance into every task or dynamically alter a fork's inherited system prefix.

Add two concrete cheap-child recipes:

1. **Failure classification:** Given a named existing test log and relevant source/test paths, classify one failure family, cite the decisive lines, identify the likely owning symbol, state uncertainty, and stop. No rerun, edits, or broad suite. Use isolated profile-default cheap model and read-only tools.
2. **Focused validation:** Given an approved patch scope and exact authorized command, execute that check once, interpret the result, return command/exit status and decisive evidence, and stop. No fixes, installs, suite expansion, or automatic reruns. Give only the needed tools; `bash` is mutation-capable under current policy and must take the sole writer lease. Do not relabel it read-only because the assignment says “testing.”

The second recipe is worthwhile when interpretation or several bounded checks remove master reasoning rounds—not just to relay a single exit code. Both recipes must respect user restrictions; **this audit still authorizes no script/test execution**.

Target roughly 100–200 words for these small evidence tasks, within the existing 400-word ceiling: verdict; decisive evidence; uncertainty; unfinished work if any. Keep full logs in a retrievable artifact rather than returning them to the master. Permit `inconclusive` instead of pressuring a cheaper model to invent a verdict. The master verifies the consequential claim or artifact, not every step of the child's work again; escalate only a demonstrated gap.

**Acceptance:** Prompt tests verify the rule and compact contract in isolated and fork modes. Examples never place a tester alongside another writer, never run checks against unfinished mutations, and never duplicate the same review across three children.

### 17. Measure avoided master rounds and end-to-end value, not cache hits alone

**Starting seams:** `src/types.ts`, `src/index.ts`, `src/runner.ts`, `src/json-events.ts`, `src/render.ts`.

Use existing child usage as a base. Add small, optional phase diagnostics: setup, queue, spawn-to-first-response, execution, disposal, total delegation duration, resolved model/context mode, input/output/cache tokens, turns, and provider-reported cost when available. Keep verbose diagnostics out of model-visible output by default. Missing cost or cache data means unknown, not zero.

A later opt-in evaluation should compare direct master execution, cheap isolated delegation, and compatible same-model fork on representative bounded tasks. Record answer correctness, evidence quality, total task cost, end-to-end median/tail latency, master inference rounds, and repairs/escalations. Parent-next-request cache reuse requires host/provider usage visibility and cannot be inferred from the child's `cacheRead` count. Cache-hit ratios are provider-specific; specify their denominator and do not equate high ratios with low total cost.

Evaluate both warm and cold starts and realistic context sizes. Tool-turn counts alone are not inference-barrier counts when multiple calls share a turn. Do not add runtime benchmarking, paid requests, telemetry uploads, or a new dashboard by default. Gather evidence first; only then tune budgets, profile defaults, or startup optimizations. Process pooling is not a first-line fix because it introduces isolation and lifecycle complexity.

**Acceptance:** Metrics identify where short assignments spend their time and preserve partial usage on failures (item 7). A proposed routing/default change has measured cost/latency/quality evidence rather than a cache-warmth assertion. These evaluations are future work; none were run in this audit.

## Suggested implementation order

1. Align economical-routing/readiness guidance and short recipes (14–16) with existing API behavior; no new router or runtime required. Fold in contract corrections from item 11.
2. Fix prompt rejection and malformed-event handling (1–2), then resource ownership and lineage transitions (3–5). These directly prevent supposedly short delegation from stalling or repeating work.
3. Preserve cancellation accounting and compact model-visible control metadata (7, 6); add lightweight phase metrics (17).
4. Harden CLI/executable/fork compatibility (8–10), avoiding extra LLM turns and unbounded startup checks.
5. Add focused compatibility coverage (12), then evaluate short-budget tuning and routing economics before changing defaults (15, 17).
6. Evaluate optional retention/observability changes (13) separately. Defer pooling, automatic routing/escalation, and large orchestration redesigns.

For each change, the implementing agent should report changed files, focused tests actually executed, remaining risks, and any intentional public-contract change. Do not describe this static audit as a passing test suite.

# pi-dede Specification

**Status:** Static implementation; runtime validation pending. [IMPLEMENTATION-NOTES.md](./IMPLEMENTATION-NOTES.md) specifies audit-hardening changes and limitations and takes precedence over older details below.

**Package:** `@khanhicetea/pi-dede`

**Target:** Pi extension/package API

## 1. Product boundary

`pi-dede` provides short, synchronous delegation to independent Pi children. A new child may start isolated or from a safe fork of the master conversation. It supports two workflows:

1. fan out one to three bounded evidence questions after the master has inspected enough to define exact scope;
2. run one mutation-capable worker after the master has approved a concrete plan.

The master owns decomposition, planning, synthesis, comparison, verification, and the final answer. Children do not plan work for one another and cannot depend on other child results within a run.

A successfully finished child exposes a session-scoped continuation handle. The master may use it for a later bounded task that directly benefits from the same child's context. The continuation reopens the same Pi session in a fresh RPC process, preserves the child's immutable role and capabilities, and requires mutable repository state to be revalidated. A timed-out child instead exposes a resume handle for a deliberate short completion attempt when partial output indicates it is close to completion.

The extension must discourage delegation for first-pass orientation, one-file/symbol lookups, planning, synthesis, overlapping tasks, and work likely finishable in roughly two local tool calls.

## 2. Design principles

1. **Master ownership:** child output is untrusted evidence, never the final outcome.
2. **Bounded fan-out:** at most three active child processes globally and per run.
3. **Bounded synchronous runs:** 180-second default, 1800-second maximum.
4. **Bounded reasoning:** profile defaults are `low` or `medium`, not inherited from the master.
5. **Small outputs:** children are instructed to use at most 400 words; model-visible output is capped at 4 KiB per child and 12 KiB aggregate.
6. **Least privilege with cache fidelity:** isolated children expose only allowed tools. Forked children retain the master's visible tool definitions for prompt-cache compatibility, while an internal `tool_call` hook blocks every call outside the profile's allowed subset. At most one mutation-capable child runs per call, and a runtime-wide mutation lease serializes writers across concurrent calls.
7. **Bounded lineage reuse:** a successful child may receive a related new bounded task with a normal deadline; a timed-out child may receive only a 30–180 second solo completion attempt.
8. **No recursive delegation:** an explicit internal child bootstrap registers the same visible `dede_delegate` definition for cache fidelity, but its execution always fails and the tool policy blocks it.
9. **Observable cancellation:** progress is throttled, deadlines are visible, and Esc aborts process trees.
10. **Bidirectional headless transport:** children run `pi --mode rpc` so the master delivers the task, steers a child near its deadline, and aborts gracefully over stdin/stdout, reserving process-tree termination for the hard deadline. A soft deadline warning always precedes the hard kill.
11. **Progressive orchestration guidance:** the package exposes a parent-only skill that teaches the delegation gate, compact lane contracts, distinct fan-out, verification, and bounded recipes without widening the runtime workflow surface.

## 3. Public tool

```text
name: dede_delegate
label: Đệ Đệ
```

Conceptual input:

```ts
type Profile = "scout" | "reviewer" | "worker" | "custom";
type ToolPreset = "read-only" | "coding" | "none" | "custom";
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ContextMode = "auto" | "fork" | "isolated";
type BuiltinTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

interface AgentRequest {
  id: string;                 // /^[a-z][a-z0-9-]{0,31}$/
  profile?: Profile;          // default: custom; forbidden on continue/resume
  goal: string;               // bounded assignment; only what remains on resume
  contextMode?: ContextMode;  // default auto; forbidden on continue/resume
  continueFrom?: string;      // handle from a successfully finished child
  resume?: string;            // handle from a timed-out child
  systemPrompt?: string;      // narrow role constraints; forbidden on continue/resume
  toolPreset?: ToolPreset;
  tools?: BuiltinTool[];      // exact list; selects the custom preset
  model?: string;
  thinking?: Thinking;
  env?: Record<string, string>; // child-specific environment overrides
  timeoutSeconds?: number;    // 30..1800
}

interface DelegateRequest {
  objective: string;          // master-owned decision/outcome
  sharedContext?: string;     // concise known facts and relevant trusted rules
  agents: AgentRequest[];     // 1..3
  timeoutSeconds?: number;    // 30..1800, default 180
}
```

Unknown fields are rejected. `continueFrom` and `resume` are mutually exclusive, and the same lineage handle may appear only once per request. A request containing `resume` must contain exactly one agent. Handles must be available in the current master runtime and are claimed atomically, all-or-nothing. Continued and resumed agents keep the old context mode, profile, system prompt, model, thinking, environment overrides, additional arguments, and tools; `contextMode`, `profile`, `systemPrompt`, `toolPreset`, `tools`, `model`, `thinking`, and `env` overrides are rejected. Only `id`, `goal`, and `timeoutSeconds` may change. A continuation may use the normal 30–1800 second deadline; a resume remains limited to 30–180 seconds.

String limits use UTF-8 bytes:

| Field | Limit |
|---|---:|
| `objective` | 4 KiB |
| `sharedContext` | 16 KiB |
| `agent.goal` | 4 KiB |
| `agent.systemPrompt` | 8 KiB |
| Final merged environment overrides | 64 variables; 16 KiB total |
| Environment value | 8 KiB |

Validation completes before temporary files, permits, or child processes are created.

## 4. Profiles

| Profile | Default preset | Default thinking | Contract |
|---|---|---:|---|
| `scout` | read-only | low | Answer one repository question with exact evidence |
| `reviewer` | read-only | medium | Review one named behavior, diff, or risk area |
| `worker` | coding | medium | Execute one approved bounded change |
| `custom` | read-only | low | Perform one caller-defined narrow specialty |

Effective thinking precedence is explicit request, profile sidecar configuration, then built-in profile default. The master's thinking level is not inherited.

Effective model precedence for `auto`/`fork` is explicit request, then master model; this keeps the default cache-compatible. For explicit `isolated` mode it is explicit request, profile sidecar configuration, then master model. Children are separate Pi processes but retain normal extension discovery. A provider registered through an installed project/global extension is therefore allowed without extra arguments; an extension loaded only in the master can be loaded explicitly through `additionalArgs` with `-e`/`--extension`. If child extension discovery is disabled with `--no-extensions` and no explicit extension is supplied, validation rejects the setup before launch.

Effective environment precedence is inherited master process environment, global profile sidecar environment, trusted-project profile sidecar environment, explicit `agents[].env`, then pi-dede's internal control fields. Profile environments merge by variable name instead of replacing the complete map.

Sidecar configuration paths:

- `~/.pi/agent/pi-dede.json`
- `.pi/pi-dede.json` for trusted projects only

The config accepts `profiles.<profile>.model`, `profiles.<profile>.thinking`, `profiles.<profile>.env`, optional `profiles.<profile>.additionalArgs`, a top-level `additionalArgs` string array, and `context.forkMinTokens`/`context.forkMaxContextRatio`. The context defaults are 4,000 tokens and 0.7. Extra arguments are inserted after pi-dede's built-in child options and before the task prompt. Arguments that change the model, system prompt, extension set, context resources, or tool surface make `auto` fall back to isolation. The profile-specific list replaces the shared list for that profile when present, including an empty list; a trusted project's top-level array replaces the global array and profile fields override corresponding global profile fields. Environment maps contain portable string keys and string values. Session/delegation control names and process-startup variables (`PATH`, Node/Bun options, dynamic-loader variables, and `BASH_ENV`) are protected from overrides.

## 5. Tool capabilities

| Preset | Tools | Classification |
|---|---|---|
| `read-only` | `read`, `grep`, `find`, `ls` | read-only |
| `coding` | read-only tools plus `bash`, `edit`, `write` | mutation-capable |
| `none` | none | read-only |
| `custom` | exact validated list | derived from list |

`bash`, `edit`, and `write` are always mutation-capable. A run may contain at most one mutation-capable child; the others must be read-only. (Two concurrent writers can clobber one another's edits, so parallel mutation is rejected.) Providing an explicit `tools` list selects the `custom` preset directly, so `toolPreset` may be omitted. In fork mode this table defines executable tools; the provider still receives the master's complete active tool-definition surface, and runtime policy blocks everything outside the selected subset.

## 6. Scheduling

One abort-aware FIFO semaphore belongs to each loaded extension runtime:

```text
MAX_ACTIVE_CHILDREN = 3
```

The process limit applies across simultaneous tool calls. An agent requests a permit only after its secure prompt files are ready. A separate one-permit mutation semaphore applies across simultaneous calls so two writers cannot clobber the shared workspace. Results preserve request order, regardless of process completion order.

There are no dependency graphs, child-to-child messages, planner handoffs, automatic retries, or background runs. Related continuation and short resume are initiated only by a new master tool call.

Successful continuation capabilities are in-memory and scoped to the current master runtime. They expire after 30 idle minutes and only the 12 most recently available successful lineages are retained. Timeout-resume capabilities are not subject to that successful-lineage LRU. Shutdown, reload, session replacement, or master fork clears all capabilities; underlying child session files remain available for normal Pi inspection.

## 7. Child execution

Each child is a separate process launched with `shell: false`, conceptually:

```sh
pi --mode rpc --no-approve \
  --session-dir <pi-project-session-dir> --session <0600-child-session-file> \
  --no-prompt-templates --no-themes \
  --extension <pi-dede-child-bootstrap> \
  --system-prompt <0600-system-file> \
  --tools <isolated-allowed-or-fork-master-visible-tools> \
  --model <provider/model> --thinking <level> \
  [effective shared-or-profile additionalArgs]
```

The task assignment is delivered as an RPC `prompt` command over the child's stdin; it never appears in process arguments. The child stays headless and uses no terminal multiplexer. The master reads the LF-delimited JSONL event stream from stdout for state (final text, usage, activity) and writes control commands back over stdin: the initial `prompt`, a `steer` warning near the deadline, and an `abort` at the deadline. Extension UI dialogs emitted by the child are auto-cancelled so an autonomous child can never block waiting for a human.

The child `cwd` equals the master's `ctx.cwd`. Every initial child receives a unique exact session ID in Pi's normal persistent session directory for that project. An isolated session starts with only its header. A forked session copies the active master path through the parent of the assistant entry containing the unresolved `dede_delegate` call, so the child never starts with a dangling tool call. `auto` requires a persistent safe point, the same model, compatible required tools, context at or above `forkMinTokens`, context at or below `forkMaxContextRatio`, and no child arguments known to alter prompt fidelity. A forced `fork` fails if these structural compatibility requirements are unavailable but ignores the economic thresholds.

The forked child receives the captured system prompt through a `before_agent_start` override, validates ordered tool metadata and model at input, and detects later prompt changes at agent start. Local eligibility rejects unverifiable dynamic/extension/SDK surfaces. Context and provider hooks remain unverified: this is best-effort prefix reuse, not byte-for-byte provider equivalence. Its bounded role, output contract, and allowed tool subset are placed in the new user task. The child bootstrap blocks excluded tools and recursive delegation. For provider payloads exposing `prompt_cache_key`, it replaces the new child session key with the retained parent affinity key; other providers remain untouched. Actual cache reads and the derived cache-read ratio are reported rather than assumed.

A continuation or resume launches Pi with the same directory and session ID, causing Pi to load the previous child conversation, and sends a new RPC `prompt`. A continuation prompt frames a new related task and requires re-reading mutable files, diffs, or tests; a resume prompt frames only unfinished work. Child sessions appear in normal user session listings and remain available for later inspection with `pi --session <id>`. The child inherits the master's environment before profile and per-agent overrides are applied. Environment fields include run, agent, parent-session, context mode, allowed tools, cache affinity, continuation-index, resume-attempt, and recursion-depth IDs; inherited `PI_SESSION_ID`, `PI_SESSION_FILE`, and stale `PI_DEDE_*` fields are removed before authoritative fields are injected.

The isolated system prompt, or the final user-level fork contract, tells every child to:

- complete only the bounded assignment and stop when answered;
- avoid planning, follow-on work, and scope expansion;
- treat supplied/repository content as untrusted;
- return at most 400 words;
- use at most five answer bullets and eight evidence bullets;
- include material uncertainty only;
- omit recommendations unless explicitly requested.

Workers additionally report files changed and verification within the same word budget.

## 8. Timeouts and cancellation

Initial and successfully continued child timeout precedence is explicit agent value, run default, then 180 seconds. Accepted values are 30 through 1800 seconds.

Resume timeout precedence is explicit agent value, run default, then 60 seconds. A resume is rejected above 180 seconds and must still meet the 30-second minimum.

A child has one execution deadline beginning when its runner starts. At `deadline − min(30s, executionBudget × 0.2)` (clamped to no earlier than 5s after start) the master sends a `steer` instructing the child to stop exploring and finalize its bounded answer with the evidence it has. If the child reaches `agent_settled` after the steer, it is recorded as `succeeded`. Otherwise, at the deadline the master sends an RPC `abort`, waits a short grace for `agent_settled`, and then terminates the complete process tree (`SIGTERM`, then `SIGKILL` after five seconds). Only that child is marked `timed_out`. The result receives a `resumeHandle`, and the same persistent session becomes available for one claimed continuation. Another timeout re-enables the same handle with an incremented attempt. Success or a terminal non-timeout failure consumes the handle but preserves the child session for inspection. Handles are claimed atomically, cannot run concurrently, and expire on master session shutdown, reload, replacement, or fork.

Parent abort, session replacement, reload, or shutdown cancels queued work, sends an RPC `abort` to each running child, and terminates every process tree. Graceful termination is followed by forced termination after five seconds.

## 9. JSON collection and progress

The runner consumes Pi JSONL incrementally with a 2 MiB line cap. It records finalized assistant text, usage, stop reason, bounded activity, time to first child event, and protocol completion. Thinking content is ignored. Up to 32 KiB of unfinished text deltas is retained only as a timeout fallback so the master can judge whether a short continuation is worthwhile.

Progress rules:

- answer token deltas never trigger progress renders;
- tool update payloads are ignored;
- tool start/end, retry, compaction, and completion events may update status;
- extension updates are throttled to at most one per 200 ms;
- a one-second heartbeat refreshes elapsed/deadline display while children run;
- activity history is capped at 100 entries.

## 10. Result contract

```ts
interface ChildResult {
  id: string;
  profile: Profile;
  goal: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  model: string;
  thinking: Thinking;
  tools: BuiltinTool[];
  timeoutSeconds: number;
  sessionId?: string;         // present after session allocation; inspect with pi --session <id>
  continuedFrom?: string;
  continuationIndex?: number;
  continuationHandle?: string; // present after successful settlement
  resumedFrom?: string;
  resumeHandle?: string;      // present when short completion remains available
  finalText: string;
  durationMs: number;
  usage: ChildUsage;
  activity: Activity[];
  // optional exitCode, stopReason, errorMessage, stderrTail, artifactPath
}

interface ToolDetails {
  version: 2;
  runId: string;
  status: "succeeded" | "partial" | "failed" | "cancelled";
  startedAt: number;
  durationMs: number;
  results: ChildResult[];
}
```

Limits:

| Content | Bytes | Lines |
|---|---:|---:|
| Model-visible child section | 4 KiB | 160 |
| Aggregate model-visible result | 12 KiB | 500 |
| Structured `finalText` | 32 KiB | — |
| stderr tail | 64 KiB | — |

Larger final text is stored in a mode-`0600` session artifact removed at session shutdown. Truncation preserves UTF-8 boundaries and is disclosed. Nested model usage is returned through the custom tool's `usage` field.

## 11. TUI contract

The call view shows the master-owned objective, mode, count, profile, tool preset, timeout, and bounded goal preview. Successful reuse calls are labeled `related continuation`; timeout recovery calls are labeled `short resume`. While running, the header separates done, running, and queued counts and shows aggregate elapsed time plus `Esc to cancel`; each child row shows a status-specific icon, profile, resume state, model, thinking, elapsed/deadline, and latest bounded activity. Timed-out and cancelled states are visually distinct from failures. Timed-out expanded results display the handle and 30–180 second policy. Answer deltas are never rendered.

Collapsed final output shows aggregate outcome/usage, one compact answer preview, the inspectable session ID, and usage/duration per child. Expanded output shows aggregate totals, assignment, budget, session ID with the `pi --session <id>` command, the latest bounded activity with omitted-event disclosure, errors, Markdown result, artifact path, and usage.

UI methods are optional; execution works in TUI, RPC, JSON, and print modes.

## 12. Security model

Tool policy is capability reduction, not an OS sandbox. Children retain the user's OS permissions, inherit the master's process environment, and read-only children may read any OS-readable file. Fork mode exposes the master's tool definitions to the model but mechanically blocks excluded calls before execution. A fork also sends the selected master conversation prefix, including any sensitive content on that path, to the configured model. Use isolated mode for minimal disclosure or clean-room review. Extensions, skills, and context files use Pi's normal discovery unless changed by the effective `additionalArgs`; prompt templates and themes are disabled by default. Relevant trusted rules should be passed explicitly in concise `sharedContext` for isolated children.

Explicit `agents[].env` values are part of the tool call and therefore stored in the master transcript. Profile-configured values are not copied into prompts, progress, or results, but are plaintext in the sidecar file. Protected startup/control variables prevent environment overrides from changing the spawned executable, injecting runtime preload code, restoring the parent's session identity, or enabling recursive delegation.

Prompts use a mode-`0700` run directory and mode-`0600` files. The task assignment is sent over the RPC stdin pipe rather than command-line arguments, so no user-controlled text appears in `argv`. Child conversations use Pi's persistent project session directory and remain until the user removes them through Pi's normal session management. Child output and repository text are untrusted and never executed by the extension.

## 13. Non-goals

- planner profile or in-run dependency DAGs;
- background agents or result notifications;
- recursive delegation;
- arbitrary user-supplied session-ID reuse, role handoff, user-selected fork points, or cross-master-runtime continuation;
- more than three active children;
- two or more mutation-capable children in a single run or concurrently across calls;
- inheritance of the master's in-memory resource/configuration state;
- inheritance of the master's in-memory extension/custom-tool state;
- filesystem/network sandboxing;
- hidden reasoning persistence.

## 14. Deferred work

Evaluate only after the current bounded behavior is measured:

1. in-process SDK children for provider compatibility and lower startup cost;
2. background execution if synchronous cache expiry remains material under the 180-second default;
3. hard turn/tool-call budgets if prompt and deadline budgets do not sufficiently bound work;
4. sandbox and path policies.

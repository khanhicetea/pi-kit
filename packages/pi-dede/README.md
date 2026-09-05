# Đệ Đệ (`pi-dede`)

A deliberately narrow Pi extension for short delegation. It helps a master fan out bounded evidence questions after local inspection, or hand one approved implementation to a solo worker. New children default to `auto` context selection: pi-dede can fork a safe prefix of the master conversation for context and prompt-cache reuse, or retain the original isolated start.

`pi-dede` is synchronous: the master waits for the children. Its defaults therefore favor fewer agents, low reasoning effort, small outputs, and short deadlines.

## When to use it

Use `dede_delegate` only when the master already knows enough to define exact scope.

Good uses:

- two or three independent, non-overlapping repository questions;
- one focused risk review of named files or behavior;
- one mutation-capable worker executing a concrete master-approved plan.

Do not use it for:

- first-pass repository orientation;
- a single file or symbol lookup;
- planning or synthesis;
- work likely finishable in roughly two local tool calls;
- broad tasks such as “review the project” or “implement the feature”.

The master owns decomposition, comparison, verification, planning, and the final answer.

### Write delegation lanes as contracts

After local inspection, give every child a compact contract:

1. one outcome or question;
2. a named source seam or scope;
3. the evidence to return;
4. true hard constraints;
5. a stop condition.

Before parallel fan-out, compare the goals. Each lane must remain distinct without its id—do not clone one prompt and swap only labels, issue numbers, or broad paths. For a worker, also provide the approved scope, success criteria, focused validation, and required changed-files/checks/risks handoff.

The installed package exposes a `pi-dede` skill with detailed recipes. Pi loads it on demand when a delegation/orchestration task matches, or you can invoke `/skill:pi-dede` explicitly.

## Audit hardening

See [IMPLEMENTATION-NOTES.md](./IMPLEMENTATION-NOTES.md) for current lifecycle, CLI, fork-compatibility and cancellation-accounting constraints, intentional contract changes, and deferred validation. Those notes qualify the older descriptions below; no runtime compatibility matrix or performance claims have been verified.

Choose direct tools for a known lookup/command, explicit isolation with a configured cheaper profile for bounded multi-step interpretation, and same-model auto/fork for substantial necessary history. Compare total cost and critical-path latency, including handoff and repair—not cache reads alone. Selected microtasks can use a 60-second execution ceiling; setup, queues and disposal add time. See the skill recipes for concrete examples.

## Features

- One LLM-callable tool: `dede_delegate`
- One to three independent persistent children per call
- `auto`, `fork`, and `isolated` context modes for new children
- Safe master-session forks that exclude the unresolved delegation tool call
- Best-effort master-prefix reuse with ordered tool metadata checks; unverified extension/SDK surfaces fall back or reject forced forks
- Runtime-enforced child tool subsets even when forked children retain master-visible tool definitions
- Parent prompt-cache affinity with measured cache-read ratios where the provider exposes it
- Global three-process FIFO limit across concurrent calls
- Parallel read-only evidence collection
- One explicitly authorized coding worker per mutation run
- Built-in `scout`, `reviewer`, `worker`, and `custom` profiles
- Packaged `pi-dede` orchestration skill with bounded recipes and anti-pattern repairs
- 180-second default and 1800-second maximum child deadline
- Compact 400-word response contract
- 4 KiB model-visible limit per child and 12 KiB aggregate limit
- Persistent child session IDs for later inspection with `pi --session <id>`
- Session-scoped continuation handles for related follow-up tasks after success
- Separate short resume handles for timed-out children
- Atomic per-lineage claims and a runtime-wide mutation lease
- Throttled TUI progress with elapsed/deadline display
- Nested usage accounting and process-tree cancellation
- Per-turn settled summary of subagent count and cost grouped by model ID
- Steer-then-kill soft deadline: a child is warned to finalize before it is hard-terminated
- Explicit prompt-template and theme discovery disabled; other child resources follow Pi defaults

## Install

```sh
pi install npm:@khanhicetea/pi-dede
# Local checkout:
pi install /absolute/path/to/pi-dede
```

For development:

```sh
npm install
npm run check
pi -e ./src/index.ts
```

## Soft deadline steering

Children run as headless `pi --mode rpc` processes. The master drives each child over a bidirectional stdin/stdout JSON channel: it sends the task as a `prompt`, reads the event stream for progress, and—uniquely for a hard timeout—can `steer` a child that is running long.

Each child has one deadline (default 180s, 30–1800s). At most thirty seconds (20% of the execution budget for shorter runs) before the deadline (and never in the first five seconds of a run), the master sends a steering message telling the child to stop exploring and produce its final bounded answer with the evidence it has. A child that reaches a settled state after the steer is recorded as `succeeded`. A child that does not finalize receives an RPC `abort` at the deadline, a short grace to settle, and then a hard process-tree termination (`SIGTERM`, then `SIGKILL`); it is recorded as `timed_out` and keeps its short-resume handle.

Esc, session replacement, reload, and shutdown all send an RPC `abort` and then terminate the running children. Extension UI dialogs a child emits are auto-cancelled, so an autonomous child can never hang waiting for a human to answer it.

## Evidence fan-out

The two lanes below answer different questions and request different evidence: one establishes flow and invariants; the other evaluates replay/expiry failure modes.

```json
{
  "objective": "Decide whether the refresh-token change is safe to implement",
  "sharedContext": "Scope: src/auth/token.ts and tests/auth/token.test.ts. Preserve the public TokenStore interface.",
  "agents": [
    {
      "id": "flow",
      "profile": "scout",
      "goal": "Trace refresh-token creation and validation only in the named files. Return the exact symbols and invariants needed by a change; stop after the flow is established."
    },
    {
      "id": "risk",
      "profile": "reviewer",
      "goal": "Review replay and expiry behavior only in the named files. Return actionable failure modes with line evidence; stop after at most five findings."
    }
  ]
}
```

Independent children start as global slots become available. Results preserve request order.

## Reuse the master conversation

Set `agents[].contextMode` on a new child:

- `auto` (default) forks when the master has a safe persistent checkpoint, the model and required tools are compatible, and configured context economics allow it; otherwise it starts isolated and reports the reason;
- `fork` requires a safe compatible master fork and fails before launch when it cannot provide one;
- `isolated` uses the original clean child session and compact `sharedContext` contract.

```json
{
  "objective": "Check the edge case using decisions already established in this conversation",
  "agents": [{
    "id": "edge",
    "profile": "scout",
    "contextMode": "fork",
    "goal": "Inspect the named edge case, return exact evidence, and stop."
  }]
}
```

The fork ends immediately before the assistant message containing the unresolved `dede_delegate` call. Each child receives its own persistent session file and new task prompt. In fork mode the child keeps the master's exact effective system prompt and visible tool definitions; the final task prompt states the bounded role and allowed subset, and an internal `tool_call` hook blocks every tool outside that subset. Recursive delegation remains blocked.

Forking is not always cheaper. `auto` defaults to a 4,000-token minimum and a 70% context-window ceiling, requires the same model, and falls back when child-specific arguments alter the prompt/model/tool surface. Results disclose the resolved mode, inherited token estimate, provider-reported cache reads, cache ratio, time to first child event, and any fallback reason.

## Worker

After the master has synthesized evidence and approved a concrete plan, run one mutation-capable worker. It may run in its own call, or alongside read-only scouts in a single call—but a run allows at most one mutation-capable child.

```json
{
  "objective": "Apply the approved refresh-token validation change",
  "sharedContext": "Exact plan, relevant repository rules, and invariants go here.",
  "agents": [
    {
      "id": "worker",
      "profile": "worker",
      "goal": "Change only src/auth/token.ts and its focused tests according to the supplied plan. Run the named test command and stop."
    }
  ],
  "timeoutSeconds": 300
}
```

Any child with `bash`, `edit`, or `write` is mutation-capable. At most one mutation-capable child may run per call; it may run alongside read-only agents. A runtime-wide mutation lease also serializes writers from concurrent `dede_delegate` calls, preventing separate calls from clobbering the same workspace.

## Continue a successfully finished child

Every successfully finished child returns a `continuationHandle`. Use `continueFrom` when a new bounded task is directly related to that child's previous context—for example, asking a scout to inspect a related path or asking a worker to fix a review finding in its own implementation.

```json
{
  "objective": "Fix the verified review finding",
  "sharedContext": "The master verified the current diff and found <specific issue>.",
  "agents": [{
    "id": "worker-fix",
    "continueFrom": "dede_00000000-0000-4000-8000-000000000000",
    "goal": "Re-read the affected files, fix only <issue>, run <focused check>, and stop.",
    "timeoutSeconds": 300
  }]
}
```

Continuation rules:

- the same persistent Pi session and active conversation branch are reopened in a fresh RPC process;
- profile, system instructions, model, thinking, environment, additional arguments, and tools remain immutable;
- only `id`, `goal`, and `timeoutSeconds` may change; the call may supply a new objective and concise `sharedContext`;
- normal 30–1800 second child deadlines apply;
- the continuation prompt tells the child to reuse relevant context but revalidate mutable repository, diff, and test state;
- successful continuations return the same stable handle and an incremented `continuationIndex`;
- a continuation that times out transitions to the short `resume` workflow; a failed or cancelled child is not reusable;
- distinct read-only continuation handles may run in parallel, but one handle can be claimed only once per call and claims are all-or-nothing;
- successful handles are scoped to the current master runtime, retained for 30 idle minutes, and limited to the 12 most recent lineages; eviction never deletes the inspectable Pi session.

Use the opaque handle rather than a raw `sessionId`: the handle preserves trusted lineage configuration and provides an atomic lease. A master-context fork creates the initial child lineage; `continueFrom` then appends related work to that child's active branch.

## Short continuation after timeout

Each child runs in its own persistent Pi session. Every returned child result includes its `sessionId`; use `pi --session <id>` from the same project to inspect the conversation later. When a child times out, its result also contains a `resumeHandle` and model-visible instructions. The master should resume only when the partial result shows the child is close to useful completion—not automatically after every timeout.

```json
{
  "objective": "Finish the missing refresh-token finding from existing evidence",
  "agents": [
    {
      "id": "risk-finish",
      "resume": "dede_00000000-0000-4000-8000-000000000000",
      "goal": "Return only the remaining replay-risk finding and its exact line evidence, then stop.",
      "timeoutSeconds": 60
    }
  ]
}
```

Resume rules:

- the resume must be the only agent in its call;
- it reuses the exact previous child conversation, profile, system instructions, model, thinking, environment overrides, and tools;
- only `id`, `goal`, and `timeoutSeconds` may change;
- the extension defaults to 60 seconds and allows 30–180 seconds;
- the resume prompt tells the child to reuse existing progress instead of restarting;
- a second timeout returns the same handle for another deliberate short extension;
- success converts the same stable handle into a `continuationHandle` for a later related task;
- a terminal non-timeout failure consumes the handle but preserves the child session for inspection;
- handles expire on master session shutdown, reload, replacement, or fork.

Child sessions use Pi's normal persistent session storage and appear in the session list for the project. Their IDs are shown in collapsed and expanded tool results and in model-visible tool output.

## Profiles and defaults

| Profile | Default tools | Default thinking | Purpose |
|---|---|---:|---|
| `scout` | read-only | `low` | Answer one bounded repository question |
| `reviewer` | read-only | `medium` | Review one named behavior, diff, or risk area |
| `worker` | coding | `medium` | Execute one concrete approved change |
| `custom` | read-only | `low` | Caller-defined narrow specialty |

Per-request `model`, `thinking`, and `timeoutSeconds` override initial-child defaults. `agents[].env` adds environment overrides for that child and wins over profile-configured values by variable name. Initial and successfully continued tasks use 30–1800 second deadlines and default to 180 seconds. Resumed timed-out children keep their old model, thinking, environment overrides, and tools while using the separate 30–180 second completion budget.

Persistent profile model, thinking, and environment overrides—and extra child CLI arguments—may be placed in:

| Location | Scope |
|---|---|
| `~/.pi/agent/pi-dede.json` | Global |
| `.pi/pi-dede.json` | Current trusted project |

```json
{
  "additionalArgs": ["-e", "/absolute/path/to/child-extension.ts"],
  "context": { "forkMinTokens": 4000, "forkMaxContextRatio": 0.7 },
  "profiles": {
    "scout": {
      "model": "anthropic/claude-haiku-4-5",
      "thinking": "low",
      "env": { "CHILD_MODE": "inspect" },
      "additionalArgs": ["-e", "/absolute/path/to/scout-extension.ts"]
    },
    "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
    "worker": { "model": "openai-codex/gpt-5.3-codex", "thinking": "medium" },
    "custom": { "thinking": "low" }
  }
}
```

`context.forkMinTokens` is a non-negative integer. `context.forkMaxContextRatio` is greater than zero and at most one. Global values are merged with trusted-project field overrides.

`additionalArgs` is validated and appended after pi-dede's controlled options; the task is sent only through RPC. Supported options are `-e`/`--extension`, matching `--provider`, `--api-key`, `--skill`, `--no-extensions`, `--no-skills`, and `--no-context-files`. Other options, positional prompts and lifecycle overrides are rejected; use typed agent fields for model/thinking/tools/role changes. The top-level list is shared by all profiles. If `profiles.<profile>.additionalArgs` is present, it replaces the shared list for that profile, including when it is an empty array. A trusted project's top-level `additionalArgs` array replaces the global array; profile fields override the corresponding global profile fields.

Project values override global model/thinking fields and merge environment values by variable name. Per-agent values then override configured environment values. For model selection, `auto` and `fork` retain the master model unless `agents[].model` is explicit; profile model defaults apply to explicit `isolated` children. The complete child environment precedence is inherited master process environment, global profile environment, trusted-project profile environment, per-agent environment, then pi-dede's internal control variables.

Configuration is read on every delegation. Project configuration is ignored unless Pi trusts the project. Environment names must be portable identifiers; session/delegation variables and process-startup controls such as `PATH`, `NODE_OPTIONS`, loader variables, and `BASH_ENV` cannot be overridden. The final merged override map may contain at most 64 variables and 16 KiB total, with an 8 KiB limit per value.

`agents[].env` values are stored in the master session transcript. Values in `pi-dede.json` are not added to prompts or results, but they remain plaintext on disk; protect the config file appropriately.

### Extension-provided master models

Children are separate Pi processes, but retain Pi's normal extension discovery. An extension-registered provider is therefore available when the extension is installed in the child's normal project/global package set—for example, an installed `pi-multi-codex` provider. If the extension is loaded only in the master, load it explicitly with `additionalArgs`, such as `["-e", "/absolute/path/to/provider-extension.ts"]`. Do not pass `--no-extensions` unless the provider is explicitly loaded in the same arguments; validation rejects that conflicting setup.

## Limits

| Field/output | Limit |
|---|---:|
| `objective` | 4 KiB UTF-8 |
| `sharedContext` | 16 KiB UTF-8 |
| `agent.goal` | 4 KiB UTF-8 |
| `agent.systemPrompt` | 8 KiB UTF-8 |
| Final merged environment overrides | 64 variables / 16 KiB UTF-8 |
| Environment value | 8 KiB UTF-8 |
| Agents per run | 1–3 |
| Initial child timeout | 30–1800 seconds; default 180 |
| Resumed child extension | 30–180 seconds; default 60 |
| Child response instruction | 400 words |
| Model-visible child result | 4 KiB / 160 lines |
| Aggregate model-visible result | 12 KiB / 500 lines |
| Structured child text | 32 KiB; larger text goes to a session artifact |

## Security and isolation

Children run as separate `pi --mode rpc` processes driven over a stdin/stdout JSON channel. The task assignment is delivered as an RPC `prompt` over stdin rather than as a command-line argument, so no user-controlled text appears in `argv`. They retain Pi's normal extension, skill, and context-file discovery, while prompt-template and theme discovery remain disabled by pi-dede's built-in flags; configured shared or profile `additionalArgs` can explicitly alter this setup. Each uses an exact session ID in Pi's normal project session directory so timed-out work can be continued briefly and users can inspect it later with `pi --session <id>`. Private mode-`0600` prompt files hold system/task content. An explicitly loaded internal child bootstrap enforces tool policy, restores the exact inherited system prompt after normal child prompt assembly, blocks recursion, and rewrites supported provider cache-affinity fields.

Child processes still have the user's OS permissions and inherit the master's process environment before configured overrides are applied. Tool blocking reduces model capabilities; it is not an OS sandbox. Read-only children can read any path available to the user. A fork sends the selected master conversation prefix to the same configured model and therefore inherits any sensitive text in that prefix; use `isolated` when minimal disclosure or clean-room review matters. Discovered context files and skills may affect isolated children, so use `sharedContext` and `additionalArgs` to control that configuration explicitly.

See [SPEC.md](./SPEC.md) for the complete current contract.

## Current continuation changes

- Successful children now return a stable `continuationHandle` for directly related bounded follow-up tasks through `continueFrom`.
- Continued children reuse the same Pi session and immutable role/capabilities while receiving a current-state revalidation prompt and normal deadline.
- Successful lineage handles are atomically claimed, bounded by an in-memory LRU/TTL, and transition to timeout resume when interrupted.
- A runtime-wide mutation lease serializes writers across concurrent tool calls.

## v0.3 changes

- Children now run as headless `pi --mode rpc` processes driven over a stdin/stdout JSON channel, replacing the one-way `--mode json --print` transport. The task is delivered as an RPC `prompt` over stdin rather than as an `@file` argument.
- A **steer-then-kill soft deadline** replaces the old immediate hard kill: about 30 seconds before the deadline the child is steered to finalize; only children that do not settle are hard-terminated. A child that heeds the steer is recorded as `succeeded`.
- The Herdr terminal-multiplexer integration was removed. Children are always direct processes; there are no pane supervisors or file-based polling.
- Extension UI dialogs emitted by a child are auto-cancelled, so an autonomous child can never block waiting for a human.

## v0.2 breaking changes

- Removed the `planner` profile.
- Removed in-run `dependsOn` workflows and dependency-result forwarding.
- Reduced the per-run and global process ceiling from five to three.
- Reduced default/maximum timeouts and context/output budgets.
- Child thinking now uses bounded profile defaults instead of inheriting the master's reasoning level.
- Structured result details use version `2`.
- Timed-out results can expose a session-scoped handle for a deliberate 30–180 second continuation.

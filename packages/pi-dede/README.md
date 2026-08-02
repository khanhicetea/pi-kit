# Đệ Đệ (`pi-dede`)

A deliberately narrow Pi extension for short, isolated delegation. It helps a master fan out bounded evidence questions after local inspection, or hand one approved implementation to a solo worker.

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

## Features

- One LLM-callable tool: `dede_delegate`
- One to three isolated, ephemeral children per call
- Global three-process FIFO limit across concurrent calls
- Parallel read-only evidence collection
- One explicitly authorized coding worker per mutation run
- Built-in `scout`, `reviewer`, `worker`, and `custom` profiles
- Packaged `pi-dede` orchestration skill with bounded recipes and anti-pattern repairs
- 180-second default and 1800-second maximum child deadline
- Compact 400-word response contract
- 4 KiB model-visible limit per child and 12 KiB aggregate limit
- Persistent child session IDs for later inspection with `pi --session <id>`
- Session-scoped continuation handles for timed-out children
- Throttled TUI progress with elapsed/deadline display
- Nested usage accounting and process-tree cancellation
- Per-turn settled summary of subagent count and cost grouped by model ID
- Automatic live child tabs when the master runs inside Herdr
- Child resource discovery disabled

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

## Herdr tabs

When the master Pi process has `HERDR_ENV=1` and a `HERDR_PANE_ID`, `pi-dede` automatically opens each running child in a sibling [Herdr](https://herdr.dev/docs/agent-automation/) tab. The tab shows concise tool activity and the final answer while the normal structured JSON protocol continues to feed the master. It closes when the child finishes or is cancelled.

No configuration is required. If Herdr is unavailable or tab setup fails before the child command is accepted, `pi-dede` safely falls back to its normal direct child process. It never retries directly after Herdr has accepted a command, avoiding duplicate mutation work.

The integration uses `herdr tab create` and `herdr pane run`, rather than `herdr agent start`, because delegated Pi children remain non-interactive `--mode json --print` processes. Timeouts, Esc cancellation, usage accounting, persistent child sessions, and short resume behavior are unchanged.

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

## Solo worker

Use a separate call after the master has synthesized evidence and approved a concrete plan:

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

Any child with `bash`, `edit`, or `write` is mutation-capable and must run alone.

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
- the continuation prompt tells the child to reuse existing progress instead of restarting;
- a second timeout returns the same handle for another deliberate short extension;
- success or a terminal non-timeout failure consumes the handle but preserves the child session for inspection;
- handles expire on master session shutdown, reload, replacement, or fork.

Child sessions use Pi's normal persistent session storage and appear in the session list for the project. Their IDs are shown in collapsed and expanded tool results and in model-visible tool output.

## Profiles and defaults

| Profile | Default tools | Default thinking | Purpose |
|---|---|---:|---|
| `scout` | read-only | `low` | Answer one bounded repository question |
| `reviewer` | read-only | `medium` | Review one named behavior, diff, or risk area |
| `worker` | coding | `medium` | Execute one concrete approved change |
| `custom` | read-only | `low` | Caller-defined narrow specialty |

Per-request `model`, `thinking`, and `timeoutSeconds` override initial-child defaults. `agents[].env` adds environment overrides for that child and wins over profile-configured values by variable name. Initial timeouts range from 30 to 1800 seconds and default to 180 seconds; resumed children keep their old model, thinking, environment overrides, and tools while using the separate 30–180 second continuation budget.

Persistent profile model, thinking, and environment overrides—and extra child CLI arguments—may be placed in:

| Location | Scope |
|---|---|
| `~/.pi/agent/pi-dede.json` | Global |
| `.pi/pi-dede.json` | Current trusted project |

```json
{
  "additionalArgs": ["-e", "/absolute/path/to/child-extension.ts"],
  "profiles": {
    "scout": {
      "model": "anthropic/claude-haiku-4-5",
      "thinking": "low",
      "env": { "CHILD_MODE": "inspect" }
    },
    "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
    "worker": { "model": "openai-codex/gpt-5.3-codex", "thinking": "medium" },
    "custom": { "thinking": "low" }
  }
}
```

`additionalArgs` is inserted into every child command after pi-dede's built-in options and before the task prompt. This permits options such as `-e /absolute/path/to/child-extension.ts`; because arguments are appended after `--no-extensions`, an explicit extension can be loaded while normal extension discovery remains disabled. A trusted project's `additionalArgs` array replaces the global array.

Project values override global model/thinking fields and merge environment values by variable name. Per-agent values then override configured environment values. The complete child environment precedence is inherited master process environment, global profile environment, trusted-project profile environment, per-agent environment, then pi-dede's internal control variables.

Configuration is read on every delegation. Project configuration is ignored unless Pi trusts the project. Environment names must be portable identifiers; session/delegation variables and process-startup controls such as `PATH`, `NODE_OPTIONS`, loader variables, and `BASH_ENV` cannot be overridden. The final merged override map may contain at most 64 variables and 16 KiB total, with an 8 KiB limit per value.

`agents[].env` values are stored in the master session transcript. Values in `pi-dede.json` are not added to prompts or results, but they remain plaintext on disk; protect the config file appropriately.

### Extension-provided master models

Children do not inherit the master's loaded extensions. To use an extension-registered provider in children, load the provider extension explicitly with `additionalArgs`, for example `["-e", "/absolute/path/to/provider-extension.ts"]`. Otherwise, configure a built-in child-compatible model in `pi-dede.json` or set `agents[].model`. Validation rejects extension-only providers when no child extension is configured and includes bounded catalog candidates in the error.

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

Children run as separate `pi --mode json --print` processes with extension, skill, template, theme, and context-file discovery disabled unless explicitly changed through configured `additionalArgs`. Inside Herdr, a private supervisor launches the same command in a temporary sibling tab and spools its exact JSON output back to the extension; outside Herdr, the command is spawned directly. Each uses an exact session ID in Pi's normal project session directory so timed-out work can be continued briefly and users can inspect it later with `pi --session <id>`. Prompts and Herdr launch manifests are mode-`0600` temporary files rather than command-line text.

Child processes still have the user's OS permissions and inherit the master's process environment before configured overrides are applied. Tool allowlists reduce model capabilities; they are not an OS sandbox. Read-only children can read any path available to the user. `AGENTS.md`, skills, and project instructions are not inherited, so pass only the relevant trusted rules in `sharedContext`.

See [SPEC.md](./SPEC.md) for the complete v0.2 contract.

## v0.2 breaking changes

- Removed the `planner` profile.
- Removed in-run `dependsOn` workflows and dependency-result forwarding.
- Reduced the per-run and global process ceiling from five to three.
- Reduced default/maximum timeouts and context/output budgets.
- Child thinking now uses bounded profile defaults instead of inheriting the master's reasoning level.
- Structured result details use version `2`.
- Timed-out results can expose a session-scoped handle for a deliberate 30–180 second continuation.

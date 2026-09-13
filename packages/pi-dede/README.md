# Đệ Đệ (`pi-dede`)

Give the main Pi agent a small team, not another orchestration problem.

`delegate_to_subagents` runs **one to three bounded tasks** in parallel. The main agent owns the plan and final decision. Children return evidence or an approved change, with cost, timing, evidence status, and recovery information.

## Start with a quick scout

```json
{
  "objective": "Find the token-expiry invariant needed for the fix",
  "sharedContext": "Start in src/auth. Preserve TokenStore's public interface.",
  "agents": [{
    "id": "expiry",
    "profile": "scout",
    "effort": "quick",
    "goal": "Trace token expiry in src/auth and its direct tests. Return the invariant and up to three exact path/symbol/line excerpts. No edits. Stop when the behavior is established."
  }]
}
```

`quick` selects isolated context, low thinking, and a 60-second execution deadline. It uses the configured profile model, or the main model when no profile model is configured. **It does not guess which provider is cheaper.**

Use direct tools for a known read or command. Delegate when a bounded multi-step task saves main-agent work, context, or waiting time. A project map can be enough to define an early scout; reading the implementation first is not required.

## Effort

| `agents[].effort` | Default context | Thinking fallback | Execution deadline |
|---|---|---|---:|
| `quick` | isolated | low | 120s |
| `standard` or omitted | auto | profile default | 180s |
| `deep` | auto | high | 300s |

Explicit context, model, thinking, and timeout fields override preset defaults. Configured profile thinking overrides the preset thinking fallback. Forked children keep the main model for cache compatibility. Isolated children, including `auto` fallbacks, use the configured profile model unless `model` is explicit.

No routing-model call, automatic model escalation, or extension-level retry is added. Pi/provider retry and compaction behavior remain host-controlled. Queue, setup, and cleanup time are additional to the execution deadline. Any run with an available UI can ask the user to extend its deadline.

## Useful handoffs, small context

Each child receives a bounded contract: outcome, scope, required evidence, constraints, and stop condition. Read-only children report `answered`, `partial`, or `blocked` under an opening `## Status`.

Results distinguish **runtime success** from **child-reported evidence completeness**. Missing or malformed status is `unreported`, not an inferred success. The main agent still verifies important claims and worker diffs.

Model-facing output includes model, turns, elapsed time, reported cost, recovery handles, and a full-output retrieval route. Exact per-section allocation keeps every child's metadata inside 4 KiB / 160 lines and the run inside 12 KiB / 500 lines. An artifact does not mean the displayed answer was truncated. Full answers and persistent JSONL sessions remain available through the stated routes; temporary artifacts expire at main-session shutdown.

## Profiles and capabilities

| Profile | Default tools | Standard thinking | Assignment |
|---|---|---|---|
| scout | read-only | low | Locate and extract decisive code evidence |
| reviewer | read-only | medium | Check one contract or risk |
| debugger | read-only | medium | Establish one root cause; do not fix it |
| security | read-only | medium | Trace one trust boundary |
| tester | coding | medium | Run checks or write approved tests |
| documenter | coding | low | Update approved documentation |
| worker | coding | medium | Implement an approved plan |
| custom | read-only | low | One caller-defined specialty |

Read-only tools: `read`, `grep`, `find`, `ls`. Coding adds `bash`, `edit`, `write`. `toolPreset` can be `read-only`, `coding`, `none`, or `custom`; an explicit `tools` array selects the exact custom set.

Any `bash`, `edit`, or `write` capability consumes the **sole writer slot**, including command-only validation. Writers serialize across concurrent calls. Read-only siblings must not depend on unfinished edits. The lease coordinates pi-dede children, not the main agent or external editors. Recursive delegation is blocked.

## Context and reuse

- **isolated:** new conversation, selected tools, concise supplied context. Quick's default. Pass relevant trusted rules in `sharedContext`.
- **auto:** reuse a safe main-session prefix when model, ordered tool metadata, and context economics permit; otherwise report the reason for isolation. No transcript scan is needed for explicitly isolated or continued children.
- **fork:** require a compatible prefix; fail before launch if unavailable. Exclude the unresolved delegation tool call.

Auto defaults to a 4,000-token minimum and a 70% context-window ceiling. Forks preserve visible tool metadata while enforcing the allowed executable subset. Provider/context hooks are not fully observable, so cache reuse is best-effort, not guaranteed. No inherited in-memory extension state is assumed.

A successful child returns `continuationHandle`. For directly related work:

```json
{
  "objective": "Check the related caller using established evidence",
  "sharedContext": "The main agent verified the previous finding. Current change: ...",
  "agents": [{
    "id": "caller",
    "continueFrom": "<continuationHandle>",
    "goal": "Re-read the affected caller and establish whether it preserves the invariant. Return exact evidence and stop."
  }]
}
```

A timeout may return `resumeHandle`. Use `resume` in a solo call only when partial evidence shows little remains; default 60s, allowed 30–180s. Do not resume blindly.

Both workflows retain the same persistent session and immutable profile, model, thinking, tools, environment, and effort. Only id, goal, and timeout change. A continuation uses its original effort's timeout default. Raw session IDs are not capabilities.

Handles are atomically claimed. Successful handles expire after 30 idle minutes and only the 12 most recent successful lineages remain available. Shutdown, reload, or session replacement clears all handles, not the persistent conversations.

## Configuration

Configure a cheaper model you have access to in `~/.pi/agent/pi-dede.json`, or `.pi/pi-dede.json` in a trusted project:

```json
{
  "profiles": {
    "scout": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
    "worker": { "thinking": "medium" }
  },
  "context": { "forkMinTokens": 4000, "forkMaxContextRatio": 0.7 }
}
```

Configuration is read on each delegation. Project fields override global profile fields; environment maps merge by name. Per-agent fields override configuration. Profile models apply whenever a child runs isolated, including quick's default and `auto` fallbacks. A successful `auto`/`fork` keeps the main model.

Trusted `additionalArgs` is a flag/value object, for example `{ "-e": "/absolute/provider-extension.ts", "--fast": true }`. A profile-level object replaces the shared object, including `{}`. `true` emits a flag, `false` omits it, and a non-empty string emits a flag/value pair. Any extra arguments force auto isolation because their effect on fork fidelity is unknown. Conflicting lifecycle flags are the configuration owner's responsibility.

Profile and per-agent `env` overrides accept portable names and string values. The merged map is limited to 64 variables / 16 KiB, with 8 KiB per value. Startup, session, and delegation controls are protected. Per-agent values are stored in the main transcript; do not pass secrets there.

## Install and check

```sh
pi install npm:@khanhicetea/pi-dede
# Local checkout:
pi install /absolute/path/to/pi-kit/packages/pi-dede
# From this repository:
npm run check --workspace @khanhicetea/pi-dede
```

Reload Pi after updating. Load `/skill:subagents` for orchestration rules and examples.

## Safety and limits

Children use headless `pi --mode rpc`, private prompt files, and task delivery over stdin. They retain OS permissions and inherited environment: **this is not a sandbox**. Normal global resources can affect isolated children. Project trust follows Pi and the built-in `--no-approve` flag unless trusted extra arguments override it. Forks disclose the selected main conversation to the model.

At a soft deadline, the child receives a finalize warning. Hard timeout and cancellation clear queued steering, abort, then clean up the process tree. Failed cleanup quarantines the runtime. Prompts use private temporary directories; child sessions remain in Pi's session storage. Cancellation evidence is persisted, but thrown cancellation cannot contribute nested usage to Pi's normal tool totals.

Input UTF-8 limits: objective 4 KiB; shared context 16 KiB; system prompt 8 KiB. Normal deadlines accept 30–1800 seconds. Structured child text is capped at 32 KiB; larger output uses artifacts.

Existing calls retain standard defaults. Structured details remain version 2, with optional evidence fields. See [SPEC.md](SPEC.md) and [IMPLEMENTATION-NOTES.md](IMPLEMENTATION-NOTES.md). Local tests do not establish real-provider speed or cost savings, or a supported-version/platform matrix.

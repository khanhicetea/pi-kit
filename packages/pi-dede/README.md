# Đệ Đệ (`pi-dede`)

A Pi extension that delegates focused work to up to five isolated, ephemeral Pi sub-agents.

## Features

- One LLM-callable tool: `dede_delegate`
- Up to five concurrent read-only agents
- Dependency workflows within one call (`dependsOn`)
- A single explicitly authorized coding worker
- Per-agent profile, goal, model, thinking level, timeout, dependency-context budget, and built-in tool allowlist
- Child resource discovery disabled (extensions, skills, templates, themes, context files)
- Global five-process FIFO limit across concurrent tool calls
- Streaming TUI progress, nested usage accounting, timeout and process-tree cancellation
- Bounded output with session-scoped artifacts for exceptionally large responses

## Install

```sh
pi install npm:pi-dede
# Local checkout:
pi install /absolute/path/to/pi-dede
```

For development:

```sh
npm install
npm test
pi -e ./src/index.ts
```

## Tool example

```json
{
  "objective": "Assess the authentication refactor",
  "sharedContext": "Focus on src/auth. Project rules must be passed explicitly here.",
  "agents": [
    { "id": "scout", "profile": "scout", "goal": "Map the auth flow" },
    { "id": "test-scout", "profile": "scout", "goal": "Assess existing test coverage" },
    {
      "id": "planner",
      "profile": "planner",
      "goal": "Turn the combined findings into an implementation plan",
      "dependsOn": ["scout", "test-scout"],
      "timeoutSeconds": 900,
      "dependencyContext": { "mode": "summary", "maxBytes": 32768 }
    }
  ]
}
```

Agents without dependencies start as soon as a global slot is available. `dependsOn` names other agent IDs in the same call; forward references are allowed. A dependent waits for every direct dependency to finish, then receives each dependency's status, error (if any), and final text as explicitly untrusted task context. Cycles, unknown IDs, self-dependencies, and duplicate dependencies are rejected. Returned results always preserve request order.

A dependent can set `dependencyContext` to bound all direct dependency bodies together (`maxBytes`: 4096–262144). `mode: "full"` fairly shares the budget across full bodies. `mode: "summary"` selects an exact case-insensitive `## Summary` section through the next H2, ignoring heading-like lines inside fenced code; when absent, it uses a clearly labeled result-head fallback. Every dependency remains represented in declared order, status/error/untrusted wrappers stay intact, truncation preserves UTF-8 boundaries, and each body discloses kept/original bytes. Omitting `dependencyContext` preserves the original unbudgeted prompt format.

The top-level `timeoutSeconds` remains a run default from 1800–3600 seconds (default 1800). An agent may override it with `agents[].timeoutSeconds` from 30–3600 seconds; precedence is agent, then top-level, then 1800.

Read-only presets contain only `read`, `grep`, `find`, and `ls`. `bash` is always treated as mutation-capable. Any agent with `bash`, `edit`, or `write` must run alone, so multi-agent dependency workflows are read-only. A common flow is `scout` agents feeding a dependent `planner`, followed by a separate solo `worker` delegation after the master approves the plan.

Profiles:

| Profile | Default tools | Focus |
|---|---|---|
| `scout` | read-only | Reconnaissance and exact evidence |
| `planner` | read-only | Implementation-ready plans with affected files, ordered steps, and verification |
| `reviewer` | read-only | Severity-ranked review findings |
| `worker` | coding | Focused implementation and verification |
| `custom` | read-only | Caller-defined specialist |

Tool presets are `read-only`, `coding`, `none`, and `custom`. With `custom`, supply an explicit `tools` array (which may be empty).

## Profile defaults

Set persistent model and thinking defaults in either of these optional files:

| Location | Scope |
|---|---|
| `~/.pi/agent/pi-dede.json` | Global, all projects |
| `.pi/pi-dede.json` | Current trusted project |

```json
{
  "profiles": {
    "scout": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" },
    "planner": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high" },
    "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high" },
    "worker": { "model": "openai-codex/gpt-5.3-codex", "thinking": "xhigh" },
    "custom": { "thinking": "medium" }
  }
}
```

Project values override global values field by field. Effective precedence is: explicit `agents[].model`/`agents[].thinking`, project profile default, global profile default, then the master's current model/thinking. Configuration is read on every delegation, so manual edits apply without `/reload`. Project configuration is ignored unless Pi trusts the project.

Model values use the same exact, glob, or partial matching accepted by the tool's `model` field. Models supplied only by provider extensions remain unsupported in isolated children.

## Security and isolation

Children run as separate `pi --mode json --print --no-session` processes with extension and project-resource discovery disabled. Prompts are mode-`0600` temporary files, not command-line text. Child processes still have the user's OS permissions: tool allowlists are capability reduction, **not an OS sandbox**. A read-only child can read any path the user can read.

`AGENTS.md`, skills, and other project instructions are not inherited. Include relevant trusted rules in `sharedContext`. Models supplied only by provider extensions are unsupported because extensions are disabled in children.

See [SPEC.md](./SPEC.md) for the complete contract and limitations.

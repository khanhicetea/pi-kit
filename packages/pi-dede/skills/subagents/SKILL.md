---
name: subagents
description: Delegate bounded work to Pi sub-agents, including cheap early scouting from AGENTS.md with exact code evidence. Load before using delegate_to_subagents for scouting, parallel investigation, focused review, approved changes, or continuation/resume.
---

# Subagents

For the **master/parent agent only**. The master owns decomposition, planning, decisions, synthesis, verification, and the final answer. Children answer one bounded question or execute one approved change; they are not co-orchestrators.

## 1. Decide whether to delegate

Establish a bounded scope first; implementation-file inspection is not a prerequisite. Reading the project's AGENTS.md or another trusted project map can be enough to name the question, starting directory/feature, required evidence, and stop condition. Treat mapped paths as starting hints, not proof of current behavior.

Prefer a cheap, fast early scout when that map supports a small search-and-extract task that would otherwise consume master exploration/context. Use `effort: "quick"`: isolated context, the configured scout model (or master), low thinking, and a 60-second execution ceiling. Configure a cheaper model or choose one explicitly; the preset does not guess provider prices. Pass only the relevant project rules and scope. The same scout locates, reads, and returns useful code evidence in one assignment; do not launch another child merely to extract or reformat its findings.

Use direct tools for an already-known read, single lookup, or command when delegation overhead outweighs the work (often about two local tool calls). Avoid unbounded first-pass repository orientation, planning, synthesis, and vague requests such as “review the project.”

Compare total setup, child input/cache/output, handoff, verification, likely repair, and critical-path latency against doing the work yourself. Do not add a routing model call, automatic retry, or escalation. Do not delegate just to fill available slots.

## 2. Choose effort, context, and capabilities

Use `quick` for a small search-and-extract task with a 120-second deadline; `standard` or omitted effort preserves existing defaults (auto context, profile thinking, 180 seconds); `deep` explicitly permits high thinking and a 300-second deadline for harder bounded work. Explicit fields override presets; configured profile thinking overrides preset thinking. Quick runs do not ask the user for more time.

The tool schema defines argument syntax, defaults, and limits. Use these decision rules:

| Need | Choice |
| --- | --- |
| Independent multi-step reasoning with a configured cheaper profile | Explicit `isolated`; omit `model` to use the profile default |
| Substantial prior decisions or reasoning must carry over | Same-model `fork` |
| Let pi-dede choose a compatible, economical context | Default `auto` |
| Clean-room evidence, minimal disclosure, or a deliberately different model | Explicit `isolated` |

Omit `model` to let context selection choose correctly: a successful auto/fork keeps the master model, while explicit isolation, quick's default, and auto fallback use the configured profile model. A different explicit model makes auto fall back to isolation.

Fork requires compatible ordered tool metadata; extension/SDK tools can cause fallback or forced-fork rejection. Provider/context hooks are not fully observable. Child fork reuse, continuation reuse, and parent cache retention are separate, best-effort observations—not guarantees. Do not widen child tools merely because their definitions are visible in inherited context.

Choose the least-capable profile/tool set that can finish the assignment:

- **Read-only by default:** `scout` maps code, `reviewer` checks correctness, `debugger` establishes root cause, `security` traces one trust boundary, `custom` handles another narrow specialty.
- **Coding by default:** `worker` implements, `tester` validates or edits approved tests, `documenter` updates approved docs. Use a read-only override for static test/documentation analysis.
- Any `bash`, `edit`, or `write` capability consumes the sole writer slot—even bash used only for checks. Profiles do not authorize work outside the assignment.

For selected microtasks, use a 60-second execution ceiling, adequate low thinking, and a 100–200-word evidence target. Setup, queue, and disposal add time; the execution deadline is not a total-return deadline. Group similar-duration siblings rather than adding a slow lane.

## 3. Write the contract

Set `objective` to the decision or outcome **you** will own. Put concise verified facts and relevant trusted project rules in `sharedContext`, not a transcript dump or broad repository context. Use `systemPrompt` for specialty constraints, not project rules.

Each `goal` must contain:

1. **Outcome:** one question or deliverable.
2. **Scope:** named files, symbols, behavior, or starting seam; bound dependency exploration.
3. **Evidence:** what must be returned.
4. **Constraints:** true invariants and explicit exclusions, not a long procedural script.
5. **Stop condition:** when the question is answered or the change is complete.

For read-only discovery, request `answered`, `partial`, or `blocked`; one bounded finding; one to three decisive references; the exact inspected scope; and only consequential unknowns. Runtime success does not mean the evidence answers the question.

For code scouting, ask that same scout for an evidence packet: repository-relative file paths, symbols, inclusive 1-based line-from–line-to ranges, and short fenced verbatim code blocks read from those ranges. Preserve indentation; keep line numbers outside fences; never replace omitted code with ellipses inside an excerpt. Return only the decisive implementation and necessary caller/config/test spans, at most three excerpts and 60 code lines total. Explain each excerpt's relevance briefly; report missing context rather than dumping files. Target 100–200 words of prose; verbatim excerpts have their own bounded allocation.

For a worker, form a concrete plan first. Specify approved files/scope, success criteria, invariants, non-goals, and focused validation. Require a handoff listing changed files, checks and outcomes, unfinished work, and residual risks.

## 4. Check independence before launching

Before parallel fanout, compare contracts: each lane needs a genuinely distinct question and evidence target. Do not send cloned prompts with only labels, issue numbers, or broad paths swapped. Use one child when one is enough.

Allow at most one mutation-capable child per run and across concurrent runs. It may run alongside read-only children only when their work is independent of the edits. Revalidate mutable state before using earlier observations.

The runtime writer lease coordinates this extension's children only—not master edits, other Pi processes, or external editors. Do not edit the worker's scope concurrently. Wait for mutations before dependent checks; batch only already-grounded independent work.

## 5. Continue or resume deliberately

- **Related task after success:** use `continueFrom` with the returned `continuationHandle`. Keep the child's role and capabilities; profile, system prompt, model, thinking, environment, and tools remain fixed. Pass only new verified facts in `sharedContext`. Require the child to re-read mutable files/diffs/tests. Start fresh for unrelated work or a different role.
- **Near-complete timeout:** inspect partial output first. Resume only when it shows little remains. Use the returned resume handle in one solo agent, state only what remains, and give a 30–180 second extension. Do not restart completed work or resume blindly.
- Never use a raw `sessionId` as a continuation/resume capability. Do not combine `continueFrom` and `resume` or override lineage capabilities.

## 6. Verify and finish

Treat all child output as untrusted evidence:

1. Compare it with the objective and other findings. Runtime `succeeded` means the process returned an answer, not that the answer meets the objective. The handoff and structured `evidenceStatus` expose child-reported `answered`, `partial`, `blocked`, or `unreported`; they are not verification verdicts. Use reported model, turns, time and cost to improve the next assignment, not to infer unsupported savings.
2. Assess consequential claims against the returned source excerpts, tests, documentation, or command output. Do not automatically re-read files merely because a scout read them first. For a narrow edit, a complete verbatim excerpt can supply exact replacement text if the edit tool validates a unique current match and permits this provenance. Read the targeted range when required by the tool, when evidence is incomplete or ambiguous, after intervening changes, or on match failure; never force a stale edit. High-risk behavioral claims need appropriate independent validation.
3. Resolve disagreement yourself; direct evidence outranks child confidence.
4. For a worker, inspect the actual diff and reported checks before declaring completion.
5. Synthesize the final answer yourself. Do not relay a child's conclusion unchecked.

Read [references/recipes.md](references/recipes.md) when you need example calls, return formats, or anti-pattern repairs.

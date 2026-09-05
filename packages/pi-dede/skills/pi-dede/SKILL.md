---
name: pi-dede
description: Orchestrate short Pi sub-agents with dede_delegate using automatic master-context forks or isolated starts. Use when a parent agent needs bounded parallel evidence, one focused review, one approved implementation worker, a related continuation of a successful child, or a deliberate short resume after timeout.
---

# Pi Đệ Đệ

This skill is for the **master/parent agent only**. The master owns scope, decisions, synthesis, verification, and the final answer. Children return untrusted evidence or execute one approved change; they do not become co-orchestrators.

## Delegation gate

Delegate only when all are true:

1. You personally inspected enough source material to identify the exact uncertainty or approved change.
2. A child can receive one bounded contract with a clear completion boundary.
3. Delegation adds leverage beyond roughly two local tool calls.
4. Parallel lanes are genuinely independent: at most one approved writer, with any read-only lanes using disjoint scopes and revalidating mutable state.

Do not delegate first-pass orientation, one symbol lookup, planning, synthesis, or vague work such as “review the project.”

## Choose the economical route

- Known file read, grep, or one authorized command: direct tools; batch already-grounded independent calls.
- Bounded multi-step failure classification or contract checking: explicit `contextMode: "isolated"` with a user-configured cheaper profile model.
- Evidence requiring substantial prior reasoning/history: same-model `auto`/`fork`, when compatibility can be established.
- Architecture, high-risk ambiguity, and synthesis: master-owned; delegate only separable evidence.

Compare total expected setup + child input/cache/output + handoff/verification + likely repair against direct master work, and compare critical-path latency. A tiny isolated task can cost less than a large cached fork. No model-powered routing step, hard-coded price rankings, automatic retries, or escalation.

Omitting `model` in auto/fork retains the master model even after auto falls back to isolation. Profile model defaults apply only to explicit isolation. Use 60-second execution ceilings for selected microtasks, adequate low thinking, and 100–200-word evidence targets within the 400-word cap. Setup, queue, and disposal add time. Group similar-duration children; the slowest sibling holds the synchronous result. Emit independent master tool work as siblings only where the host actually supports concurrency.

Returning quickly may help parent cache retention, but providers control eviction and keys. Child fork cache reuse, child continuation reuse, and parent-next-request reuse are separate observations, not guarantees. Start fresh for unrelated work.

## Build a compact contract

For each child, provide:

- **Outcome:** one question or deliverable.
- **Scope/seam:** named files, symbols, diff, behavior, or starting point.
- **Evidence:** what the child must return, such as line references, failure modes, or command outcomes.
- **Constraints:** only true invariants; avoid long procedural scripts.
- **Stop condition:** when enough evidence exists or the bounded change is complete.

Set `objective` to the decision or outcome the master will own. Put only verified facts and relevant trusted repository rules in `sharedContext`.

For each new child, choose `contextMode` deliberately when the default `auto` is not enough:

- use `fork` when decisions, discoveries, terminology, or constraints already established in the master conversation materially help the lane;
- use `isolated` for clean-room evidence, minimal conversation disclosure, a deliberately different model, or a tiny independent task;
- omit it or use `auto` when pi-dede should select a cache-compatible fork only when its context economics permit one.

Forks require locally verifiable ordered tool metadata; extension/SDK tools can cause auto fallback or forced-fork rejection. Prefix compatibility is best-effort: host context/provider hooks are not reproduced or fully observable. Pi-dede blocks execution outside the profile/tool subset. Do not widen `tools` merely because the definitions are already visible.

Before parallel fanout, compare the contracts. Do not send clone prompts with only labels, issue numbers, or broad paths swapped. Every lane must remain distinct without its id.

## Choose the run shape

| Need | Shape |
| --- | --- |
| Two or three independent questions | Parallel read-only `scout`, `reviewer`, or `custom` children |
| One bounded second opinion | One read-only `reviewer` or `custom` child |
| One approved code change | One `worker` (optionally alongside read-only scouts); writers are serialized across concurrent runs |
| New task directly related to a finished child | `continueFrom` its handle; keep its role/capabilities and provide only new facts |
| Finish near-complete timed-out work | One solo `resume` with only what remains and a 30–180 second deadline |

A run allows at most one mutation-capable child; it may run alongside read-only agents, while a runtime-wide lease serializes writers from concurrent calls. Do not create extra lanes merely to use all three slots. The writer lease coordinates only children in this extension runtime, not master edits, other Pi processes, or external editors. A check using bash still takes the sole writer lease; never pair a tester with another writer.

## Reuse an existing child lineage

A successful result may include `continuationHandle`. Use it only when the new bounded task directly benefits from that child's existing context. This is the same logical child even when the new invocation uses another display `id`: its profile, system prompt, model, thinking, environment, and tools remain fixed. Put only new verified facts in `sharedContext`, and require workers or scouts to re-read mutable files, diffs, or tests before relying on earlier observations.

`continueFrom` is not a handoff to a different role and not a substitute for a fresh independent lane. It uses the normal 30–1800 second budget and may run with other independent children. If it times out, inspect the partial result before using the returned short `resume` handle. Never pass a raw `sessionId` as a capability.

## After children return

1. Compare results against each other and the master-owned objective.
2. Verify consequential claims directly in source, tests, docs, or command output.
3. Resolve disagreement yourself; source evidence outranks child confidence.
4. Synthesize the answer or approve one concrete worker plan.
5. For worker results, inspect the diff and check reported validation before declaring completion.

Read [references/recipes.md](references/recipes.md) for call patterns, lane design, and anti-pattern repairs.

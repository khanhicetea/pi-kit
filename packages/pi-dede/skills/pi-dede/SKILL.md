---
name: pi-dede
description: Orchestrate short, isolated Pi sub-agents with dede_delegate. Use when a parent agent has already inspected the relevant area and needs bounded parallel evidence, one focused review, one approved implementation worker, or a deliberate short continuation after timeout.
---

# Pi Đệ Đệ

This skill is for the **master/parent agent only**. The master owns scope, decisions, synthesis, verification, and the final answer. Children return untrusted evidence or execute one approved change; they do not become co-orchestrators.

## Delegation gate

Delegate only when all are true:

1. You personally inspected enough source material to identify the exact uncertainty or approved change.
2. A child can receive one bounded contract with a clear completion boundary.
3. Delegation adds leverage beyond roughly two local tool calls.
4. Parallel lanes, if any, are independent and read-only.

Do not delegate first-pass orientation, one symbol lookup, planning, synthesis, or vague work such as “review the project.”

## Build a compact contract

For each child, provide:

- **Outcome:** one question or deliverable.
- **Scope/seam:** named files, symbols, diff, behavior, or starting point.
- **Evidence:** what the child must return, such as line references, failure modes, or command outcomes.
- **Constraints:** only true invariants; avoid long procedural scripts.
- **Stop condition:** when enough evidence exists or the bounded change is complete.

Set `objective` to the decision or outcome the master will own. Put only verified facts and relevant trusted repository rules in `sharedContext`.

Before parallel fanout, compare the contracts. Do not send clone prompts with only labels, issue numbers, or broad paths swapped. Every lane must remain distinct without its id.

## Choose the run shape

| Need | Shape |
| --- | --- |
| Two or three independent questions | Parallel read-only `scout`, `reviewer`, or `custom` children |
| One bounded second opinion | One read-only `reviewer` or `custom` child |
| One approved code change | One `worker` (optionally alongside read-only scouts); at most one mutation-capable child per run |
| Finish near-complete timed-out work | One solo resume with only what remains and a 30–180 second deadline |

A run allows at most one mutation-capable child; it may run alongside read-only agents, but never pair two writers (they can clobber one another's edits). Do not create extra lanes merely to use all three slots.

## After children return

1. Compare results against each other and the master-owned objective.
2. Verify consequential claims directly in source, tests, docs, or command output.
3. Resolve disagreement yourself; source evidence outranks child confidence.
4. Synthesize the answer or approve one concrete worker plan.
5. For worker results, inspect the diff and check reported validation before declaring completion.

Read [references/recipes.md](references/recipes.md) for call patterns, lane design, and anti-pattern repairs.

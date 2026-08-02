# Pi Đệ Đệ Recipes

Use these as shapes, not scripts. Replace every placeholder with evidence from the master's own inspection.

## Parallel evidence

Use two lanes by default; add a third only for a genuinely separate decision input.

```json
{
  "objective": "Decide whether the named change is safe and what invariant the implementation must preserve",
  "sharedContext": "Verified facts, named source scope, and relevant trusted project rules only.",
  "agents": [
    {
      "id": "flow",
      "profile": "scout",
      "goal": "Trace <one behavior> from <starting symbol> through <named scope>. Return exact symbols and line evidence for <required invariant>; do not review policy or propose changes; stop once the flow and invariant are established."
    },
    {
      "id": "risk",
      "profile": "reviewer",
      "goal": "Review <one risk class> in <named behavior/files>. Return at most five evidence-backed failure modes with line references and triggering conditions; do not trace unrelated flows or edit; stop after the risk decision is supported."
    }
  ]
}
```

Good lane boundaries use different questions, evidence, and decisions—not merely different directories.

## Focused second opinion

Use one child when the question requires judgment but is still bounded. Do not use it for a lookup the master can do directly.

```json
{
  "objective": "Decide whether the current patch preserves <contract>",
  "sharedContext": "The master inspected <files/diff> and verified <facts>.",
  "agents": [{
    "id": "contract-review",
    "profile": "reviewer",
    "goal": "Review only <contract> in <named diff/files>. Return ranked findings with exact evidence and a concrete failure mode; explicitly say when no actionable issue is established; stop after at most five findings."
  }]
}
```

## Solo implementation worker

The worker receives an approved direction, not an open-ended design problem.

```json
{
  "objective": "Apply the approved <change>",
  "sharedContext": "Approved plan; allowed files; invariants; non-goals; relevant repository rules; validation command and expected behavior.",
  "agents": [{
    "id": "worker",
    "profile": "worker",
    "goal": "Implement only <approved change> in <allowed scope>. Success means <observable criteria>. Run <focused checks>. Do not make unapproved product/architecture/scope decisions. Return changed files, command outcomes, failures, and residual risk; stop after the change and checks."
  }],
  "timeoutSeconds": 300
}
```

Afterward, the master inspects the actual diff and validation evidence.

## Short resume

Resume only when partial output proves that a small amount remains. Never use a handle as an automatic retry.

```json
{
  "objective": "Finish the one missing evidence item",
  "agents": [{
    "id": "finish-risk",
    "resume": "<handle>",
    "goal": "Return only <specific missing item> with <required evidence>, then stop.",
    "timeoutSeconds": 60
  }]
}
```

## Repair common anti-patterns

| Weak request | Repair |
| --- | --- |
| “Explore the codebase” | Inspect locally first, then ask one exact flow or risk question. |
| Three reviewers all asked to “review the diff” | Give each a distinct failure class, source seam, and decision input—or use fewer children. |
| “Plan and implement the feature” | The master plans and approves; one worker executes the concrete plan. |
| Entire conversation pasted into `sharedContext` | Pass verified facts, relevant rules, and named artifacts only. |
| Child result copied directly to the user | Compare, verify consequential claims, and synthesize in the master. |
| Timed-out child immediately resumed | Inspect partial output; resume only if close, otherwise narrow or finish locally. |

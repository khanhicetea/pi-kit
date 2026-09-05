# Pi Đệ Đệ Recipes

Use these as shapes, not scripts. Replace every placeholder with evidence from the master's own inspection.

## Direct tools versus short reasoning tasks

A known read, grep, or single authorized command belongs in the master's direct tools. Batch grounded independent calls; do not hire a child merely to relay an exit code.

For bounded multi-step interpretation, explicitly isolate a configured cheaper profile. Omit `model` to use that profile default. A 60-second execution ceiling is illustrative, not a total-return or cache-retention guarantee.

### Failure classification (read-only)

```json
{
  "objective": "Identify the owner of one existing failure family",
  "sharedContext": "Verified log: <log path>; relevant source/test paths: <paths>; trusted constraints: <rules>.",
  "agents": [{
    "id": "classify",
    "profile": "scout",
    "contextMode": "isolated",
    "thinking": "low",
    "timeoutSeconds": 60,
    "goal": "Classify only <failure family> in the named existing log and paths. Return 100–200 words: verdict, decisive line citations, likely owning symbol, material uncertainty and unfinished work. Inconclusive is valid. No reruns, edits or broad exploration; stop when this classification is supported."
  }]
}
```

### Focused validation (sole writer lease)

Use this only when interpretation or several bounded steps save master reasoning rounds. Wait for the approved mutation to finish first. The command must be explicitly authorized by the user; never use this recipe when tests/scripts are forbidden.

```json
{
  "objective": "Determine whether the completed approved patch satisfies one check",
  "sharedContext": "Completed patch scope: <paths>; exact authorized command: <command>; no installs, fixes, reruns or suite expansion.",
  "agents": [{
    "id": "validate",
    "profile": "custom",
    "contextMode": "isolated",
    "tools": ["bash"],
    "thinking": "low",
    "timeoutSeconds": 60,
    "goal": "Execute the supplied exact command once against the completed patch, interpret the result, and stop. Return 100–200 words with command, exit status, decisive evidence, uncertainty and unfinished work. Keep full logs in an authorized retrievable artifact. No fixes, installs or automatic reruns."
  }]
}
```

Bash is mutation-capable even for validation. Never put this child alongside another writer. For evidence needing substantial prior history, use compatible same-model auto/fork instead; compare total expected cost, latency and repair risk rather than cache percentage.

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
      "contextMode": "auto",
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

## Implementation worker

The worker receives an approved direction, not an open-ended design problem. Run it solo for a clean change, or alongside read-only scouts when investigation and the approved fix can proceed together—but keep it to one mutation-capable child per run.

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

When the worker's scope is disjoint from a read-only lane, they may share one call (still only one writer):

```json
{
  "objective": "Apply the approved <change> while confirming <one invariant> holds",
  "sharedContext": "Approved plan; disjoint scopes; invariants; validation command.",
  "agents": [
    {
      "id": "worker",
      "profile": "worker",
      "goal": "Implement only <approved change> in <allowed scope>. Run <focused checks>. Return changed files, outcomes, and residual risk; stop when complete."
    },
    {
      "id": "verify",
      "profile": "reviewer",
      "goal": "Read-only check of <one invariant> in <untouched scope>. Return pass/fail with line evidence; do not edit; stop after the decision."
    }
  ]
}
```

Afterward, the master inspects the actual diff and validation evidence.

## Related continuation after success

Continue a successful child only when the new bounded task benefits directly from its existing context. The continued child keeps its original role and capabilities; use `sharedContext` for verified deltas and require current-state validation.

```json
{
  "objective": "Apply the verified review correction",
  "sharedContext": "The master inspected the current diff and verified <specific finding>.",
  "agents": [{
    "id": "worker-fix",
    "continueFrom": "<continuationHandle>",
    "goal": "Re-read <affected files>, fix only <finding>, run <focused check>, and stop with changed files, outcomes, and residual risk.",
    "timeoutSeconds": 300
  }]
}
```

Do not continue a scout as a worker, change its tools/model, or use old observations without revalidation. Start a fresh child when the task is independent.

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
| A lane needs decisions already established by the master | Use `contextMode: "fork"`; do not duplicate the conversation in `sharedContext`. |
| A clean-room or minimal-disclosure review is required | Use `contextMode: "isolated"` explicitly. |
| Child result copied directly to the user | Compare, verify consequential claims, and synthesize in the master. |
| Successful child continued for unrelated work | Start a fresh child; preserve continuation for semantically adjacent work. |
| Continued worker trusts its old diff | Require it to re-read current files/diff/tests before editing. |
| Timed-out child immediately resumed | Inspect partial output; resume only if close, otherwise narrow or finish locally. |

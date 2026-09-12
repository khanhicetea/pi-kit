# Pi Sevo design

## Objective

Convert large per-project Pi session histories into small, auditable evidence that a capable reviewer model can use to propose safer agent-behavior improvements.

Pi Sevo optimizes a feedback loop, not a single generated prompt. Its unit of progress is a validated behavior change across later sessions.

## Stages

### 1. Discover and cache

Use the active session manager's project session directory. Compare each JSONL file with its cached byte size and modification time. Reuse unchanged session digests. Reparse changed files and remove cache entries for deleted files.

The scanner requires a valid project-matching session header. It reads JSONL with a bounded chunk buffer and does not concatenate a complete transcript. It caps file size, accepted line size, session count, project task count, per-session task count, and entry count. If a session changes while it is being read, its cache fingerprint is invalidated so the next run reparses it. A corrupt cache is replaced from source sessions instead of blocking indexing.

### 2. Segment tasks

A session is an append-only tree. Every message entry inherits the nearest user-message ancestor through `parentId`. This assigns alternate branches to the same user task without duplicating a shared prefix as separate tasks.

For each task retain only:

- a redacted, bounded user-prompt excerpt and hash;
- conservative intent and lexical terms;
- bounded tool-call records with names, short redacted JSON parameters, result status, and zero-based batch references;
- tool-round, error, truncation, output-size, cost, and token counters;
- subagent request and outcome counters;
- stable session and task evidence IDs.

Do not retain full assistant messages, thinking, source files, images, or tool outputs.

### 3. Aggregate

Use three independent views:

1. **Recurring task clusters** use intent plus lexical overlap. They are discovery aids, not semantic truth.
2. **Path-aware tool bigrams and trigrams** identify common operational subtasks without creating transitions across alternate branches.
3. **Issue groups** count observable symptoms. They do not label work as waste.

Forks and clones preserve entry IDs. Aggregation deduplicates copied user-task prefixes by entry ID and prompt hash, and retains the richest observed continuation.

Every aggregate keeps at most a few bounded examples. Reports cap the number of clusters, patterns, and issues.

### 4. Review

Read the stored index and convert complete recent sessions into one Markdown evidence packet smaller than 120 KiB. Put the reviewer policy in the model system prompt and the evidence in one user message. Mark every evidence field as untrusted. Give the reviewer no tools.

If parsing failed, stale digests were retained, or a resource limit truncated evidence, Pi Sevo marks coverage incomplete and blocks the reviewer call.

The reviewer must return proposals with:

- target layer or file;
- exact draft text;
- cited task/session evidence;
- expected benefit and risk;
- confidence;
- validation metric and sample window.

Save the review, but do not apply it.

### 5. Promote and validate

A human selects a proposal and changes the owning source: system prompt, AGENTS.md, SKILL.md, extension guidance, or subagent profile. Record the change outside the historical evidence packet. Compare a later holdout window against the proposal's metric and inspect regressions before keeping it.

Automatic promotion is intentionally out of scope for version 1.

## Small-model preprocessing

Do not begin with a model for parsing or counting. Deterministic extraction is cheaper, repeatable, and easier to test.

A future optional labeler can add semantic names when lexical clustering is insufficient. It should:

- process only new or changed task/cluster representatives;
- use a small configured model;
- receive bounded excerpts, never transcripts;
- return a strict schema;
- cache output by extractor version, model ID, prompt hash, and label-prompt version;
- keep deterministic metrics authoritative;
- allow label deletion and complete local rebuilds.

This makes model enrichment replaceable rather than foundational.

## Storage

The index is a versioned JSON snapshot under the Pi agent directory, keyed by a SHA-256 hash of the resolved project path. It is an accelerator, not the source of truth. Session JSONL remains authoritative and can rebuild the index.

Atomic temp-file replacement prevents partial snapshots. Storage permissions are private by default. Persisted JSON is normalized when loaded because local files and session content are untrusted inputs.

A future high-volume implementation can replace JSON with SQLite while preserving these logical tables:

- `sessions(source_fingerprint, extractor_version, diagnostics)`
- `tasks(task_id, session_id, prompt_hash, excerpt, intent, terms, metrics)`
- `tool_patterns(pattern, task_id, count)`
- `reviews(review_id, model, index_version, output, usage)`
- `experiments(change_id, baseline_window, holdout_window, metric, outcome)`

Use SQLite only when index size or query latency proves that JSON snapshots are insufficient.

## Trust boundaries

- Session prompts and tool outputs can contain prompt injection. Treat them as data.
- The index can contain secrets even after heuristic redaction. Keep it local and private.
- A reviewer provider receives the bounded packet only after an explicit command.
- Reviewer output is advice, not executable policy.
- Generated rules can overfit, conflict, or weaken safety. Require human promotion and later measurement.
- Never let the same evidence both generate and certify a rule. Use later sessions or a holdout set for validation.

## Non-goals

Version 1 does not:

- send complete history to any model;
- infer causation or correctness from tool counts;
- inspect current source files while analyzing old sessions;
- automatically modify prompts, skills, rules, or extension code;
- rank agents with one composite score;
- use embeddings or a vector database before evidence requires them.

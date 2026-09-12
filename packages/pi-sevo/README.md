# pi-sevo

`pi-sevo` means **self evolving**. It helps Pi learn from project session history without putting complete JSONL transcripts into an expensive model context.

The extension is deliberately evidence-gated. It analyzes history and proposes changes, but it never rewrites system prompts, skills, project rules, or tools automatically.

## Pipeline

```text
project JSONL sessions
  → deterministic, incremental task digests
  → compact project index
  → recurring-task / issue / tool-pattern report
  → bounded Markdown evidence packet
  → user-selected reviewer model
  → review proposal for human promotion
```

### Why this structure

- **No full-history model call:** parsing, task segmentation, counters, lexical clustering, and tool n-grams run locally.
- **Find common work:** user-task terms and intent form conservative recurring-task clusters. Tool-call bigrams and trigrams expose repeated operational subtasks.
- **Find common problems:** the index counts tool errors, truncation, repeated exact calls, sequential read-only rounds, split mutation rounds, assistant errors, large outputs, and subagent failures/timeouts.
- **Cheap preprocessing first:** version 1 is deterministic and costs no model tokens. A future small-model labeler can process only new cluster representatives and cache labels by prompt hash.
- **Compact storage:** Pi Sevo stores bounded prompt excerpts, terms, tool calls, short redacted JSON parameters, success/failure status, zero-based batch references, counters, and source IDs. It does not duplicate complete assistant text or tool output.
- **Teach the reviewer:** the strong model receives top recurring clusters, patterns, issues, metrics, and bounded evidence references under a prompt-injection-resistant reviewer contract.

See [SPEC.md](SPEC.md) for the data model, trust boundaries, and extension plan.

## Commands

Index all sessions for the current project:

```text
/sevo-index
```

Show the latest stored aggregate without reparsing sessions:

```text
/sevo-status
```

Read the stored index, convert complete recent sessions to bounded Markdown, and ask the current model to review it:

```text
/sevo-review
```

Select another configured model:

```text
/sevo-review anthropic/claude-opus-4-6
```

The converted evidence packet is saved as Markdown before the model call, so it remains available when a reviewer request fails. The completed review links to that evidence file. The command prints local paths and adds a TUI-only session entry. Reviewer calls are explicit and never happen in the background.

## Storage

Project indexes and reviews are stored outside the repository:

```text
~/.pi/agent/pi-sevo/<project-path-hash>/
├── index.json
└── reviews/
    ├── <timestamp>.<uuid>.evidence.md
    └── <timestamp>.md
```

Directories use mode `0700`; files use mode `0600`. The index cache uses session file size, modification time, and an enrichment schema version. Unchanged sessions are reused. Changed sessions are streamed and re-enriched. A corrupt cache is rebuilt from source sessions. The scanner bounds line memory, file size, project session/task counts, entry count, and tasks per session. It deduplicates copied task prefixes from forked or cloned sessions by stable entry ID and prompt hash.

Prompt excerpts and short tool parameters are redacted for common credential assignment forms and capped. They can still contain sensitive project information. `/sevo-review` reads the existing index and sends a Markdown evidence packet smaller than 120 KiB to the selected model provider, so run `/sevo-index` first and inspect provider data policy before use.

## Interpretation

A signal is not automatically a defect:

- separate search and read calls can have an information dependency;
- a failed edit can require a repair round;
- a large tool result can be necessary;
- a subagent timeout can still produce useful evidence;
- repeated tasks can differ in hidden constraints.

The reviewer must cite multiple tasks or sessions, propose narrow draft text, state risk, and define a measurable next cycle. A human then edits the relevant prompt, skill, or rule and compares later sessions. Pi Sevo blocks review when parsing failed, stale data was retained, or a configured resource limit made coverage incomplete.

## Install

```bash
pi install npm:@khanhicetea/pi-sevo
```

For local development:

```bash
pi install /absolute/path/to/pi-kit/packages/pi-sevo
```

## Development

```bash
npm run check
```

## License

MIT

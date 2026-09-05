# pi-tactician

A lightweight extension for the [Pi coding agent](https://pi.dev) that guides capable models to finish work in fewer inference rounds without encouraging speculative tool fan-out.

## Why

Pi executes sibling tool calls from one assistant response concurrently by default, but models often still wait for acknowledgements between calls they can already specify. In historical coding sessions this appeared most often as:

```text
edit file A → model request → edit file B → model request → edit file C
```

Each request reprocesses an increasingly large conversation prefix. `pi-tactician` teaches the model to use **information dependencies**, rather than habitual chronology, as its reason to wait.

## Behavior

The extension adds stable system guidance before each agent run:

- avoid tools when the task does not require repository or external evidence
- batch known, independent searches and reads
- form a complete patch wave after investigation
- emit independent edits to different files as sibling tool calls
- combine same-file replacements in one `edit` call
- batch independent validation after mutations
- wait only when a result changes the next action
- bound combined tool-result volume and avoid speculative calls

It deliberately registers **no model-callable tool**. A wrapper tool would add schema/context overhead and Pi already supports native sibling tool calls.

## Install

```bash
pi install npm:@khanhicetea/pi-tactician
```

For local development:

```bash
pi install /absolute/path/to/pi-kit/packages/pi-tactician
```

## Report command

Inspect the latest user task:

```text
/tactician-report
/tactician-report task
```

Inspect the complete active session branch:

```text
/tactician-report session
```

The command creates a themed, TUI-only report; it is not sent to the model. The compact view shows calls per tool request, singleton rate, and finding count, wrapping on narrow terminals. Use Pi's tool-output expand key (Ctrl+O by default) for activity, observations, tools, diagnostics, costs, and evidence-backed findings.

### Observations, not a score

A high singleton rate is not an error. Search → read, failed edit → repair, and other information dependencies can legitimately require separate requests. Sequential Bash/read-only chains remain neutral observations; the analyzer does not infer independence from tool names or parse shell commands.

The analyzer reports:

- tool calls, assistant requests, calls per round, and singleton rate
- successful consecutive singleton edits, split by known same/different paths
- repeated successful exact calls and identical read ranges, not pagination
- same-path sibling mutations (an ordering concern, not proof of a write race)
- edit calls and blocks, including historical single-replacement arguments
- tool errors and truncation (structured metadata preferred, banner fallback)
- UTF-8 text-result bytes and maximum input context including cache reads/writes
- recorded parent request cost, pricing coverage, component costs, nested tool costs, and compaction/branch-summary costs separately

Repeat tracking resets at user/instruction, compaction, and text-only assistant boundaries. File mutations invalidate matching paths; opaque tools such as Bash invalidate all repeat tracking conservatively. Path comparison is lexical, resolved against the session cwd, without inspecting today's filesystem or resolving historical symlinks. External changes can still justify an identical read.

### Evidence-backed findings

The report includes up to 20 findings with request numbers, available entry/tool-call IDs, paths, and explanations:

- **Possible cross-file batching:** consecutive edits both succeeded, but dependency remains unknown.
- **Possible repeated read:** an identical range succeeded twice without a known intervening mutation.
- **Observed same-path mutations:** sibling calls target the same normalized path; Pi may serialize them.

Calls without matched results do not establish successful edits or repeated reads. Findings are deterministic: no extra model calls or filesystem reads. Additional findings are counted rather than retained indefinitely.

### Cost interpretation and saved reports

The expanded **equal-cost split scenario** sums `batch cost × (calls − 1)`. It assumes each hypothetical split request costs as much as the original batch. It is **not measured savings** and is intentionally absent from the compact view. Sequential-edit request cost is an observed amount, not a savings ceiling. Missing costs/components are not inferred; recorded zero pricing is distinct from absent pricing.

New reports use schema version 2. Older reports remain renderable with a legacy notice and retain character units rather than incorrectly converting them to bytes. Rerun the command to compute corrected metrics. Text and TUI views share metric definitions; `formatReport()` remains available programmatically.

## Development

```bash
npm run check
```

## License

MIT

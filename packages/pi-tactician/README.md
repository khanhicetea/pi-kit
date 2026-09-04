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

The command creates a themed, TUI-only report; it is not sent to the model. The default view is a single high-signal line showing tool calls per tool request, singleton rate, and edit/bash/read barriers. It wraps only when the terminal is narrow. Use Pi's tool-output expand key (Ctrl+O by default) to reveal the full tables for tools, diagnostics, context, and cost.

It reports:

- tool calls and inference rounds
- calls per round and singleton rate
- consecutive singleton edit/bash/read-only barriers
- different-file versus same-file edit chains
- repeated exact calls and repeated read paths
- edit calls versus edit blocks
- errors, truncation, and tool-result volume
- recorded request cost and maximum observed context
- an upper-bound cost associated with sequential edit requests

The upper bound is diagnostic, not guaranteed savings: later edits can genuinely depend on earlier results.

## Development

```bash
npm run check
```

## License

MIT

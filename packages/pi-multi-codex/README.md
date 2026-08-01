# pi-multi-codex

A [pi](https://pi.dev) extension for using multiple OpenAI Codex accounts. It creates independent provider slots while leaving pi's built-in `openai-codex` provider unchanged.

It reuses pi's native OpenAI Codex provider, including its OAuth, model catalog, and streaming implementation.

## Requirements

- pi 0.81.0 or newer (native provider registration)

## Install

```bash
pi install git:github.com/khanhicetea/pi-multi-codex@main
```

For a one-off test:

```bash
pi -e ./index.ts
```

## Usage

Three slots are registered by default:

```text
openai-codex-1
openai-codex-2
openai-codex-3
```

Log into each account separately:

```text
/login openai-codex-1
/login openai-codex-2
/login openai-codex-3
```

Then use pi's built-in `/model` command to select an account. Slot models are labeled `[Codex 1] …`, `[Codex 2] …`, and so on.

Use pi's built-in `/logout` command to remove a slot's credentials.

### Usage checks

Run this command to fetch rate-limit usage for the account behind the currently selected Codex provider:

```text
/codex-usage
```

The result appears as a single-line compact widget, right-aligned below the editor beside the footer. It shows only the Codex slot name followed by each session or weekly window; account identifiers are omitted. Every window uses a color-highlighted remaining-quota bar with only the percentage left on the right. Model-specific limits are selected when the API exposes one for the active model.

The widget is displayed only when:

- `/codex-usage` is run manually, regardless of the remaining quota
- a background check after the agent's final settled turn finds any usage window below 20% remaining

Automatic checks are limited to once every five minutes per provider/model. Opening a session and switching models do not call the usage API and clear any previous widget. Automatic request failures stay silent; manual failures are reported. Usage credentials are resolved through pi's active provider, so each slot checks its own logged-in account.

## Configuration

Set `PI_CODEX_NUM_PROVIDER` to create between 1 and 100 slots (default: `3`):

```bash
PI_CODEX_NUM_PROVIDER=5 pi
```

Pi stores each slot's OAuth credentials under its provider ID. Browser and headless device-code login are supported.

# pi-kit

A monorepo containing reusable [Pi](https://pi.dev) extension packages.

## Packages

- [`pi-multi-codex`](./packages/pi-multi-codex) — multiple OpenAI Codex account slots
- [`pi-dede`](./packages/pi-dede) — isolated Pi sub-agent delegation with a parent orchestration skill
- [`pi-wui`](./packages/pi-wui) — browser-based Web UI portal and MCP server
- [`web-access-kit`](./packages/web-access-kit) — webpage reading and Google Search tools

Each directory under `packages/` is an independently installable Pi package with its own `package.json` and Pi resource manifest.

## Development

```bash
npm install
npm run check
```

Run a package directly with its workspace name:

```bash
npm run check --workspace=pi-dede
npm test --workspace=pi-wui
npm run build --workspace=pi-wui
```

Try an extension from the checkout:

```bash
pi -e ./packages/pi-multi-codex
pi -e ./packages/pi-dede
pi -e ./packages/pi-wui
pi -e ./packages/web-access-kit
```

Install one package persistently from the checkout with `pi install` and its package path, for example:

```bash
pi install /absolute/path/to/pi-kit/packages/pi-wui
```

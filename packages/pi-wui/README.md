# pi-wui

WUI is a session-scoped browser portal for coding agents. It lets an agent present interfaces that are better suited to a browser than a terminal: dashboards, tables, charts, formatted reports, prototypes, and structured forms.

The project has a native [Pi](https://github.com/earendil-works/pi-mono) extension and a portable stdio [MCP](https://modelcontextprotocol.io/) server for Codex, Claude Code, and other MCP-capable agents. Both adapters use the same browser server, tool schemas, and `wui-design` skill.

WUI uses [json-render](https://github.com/vercel-labs/json-render) with the official [`@json-render/shadcn`](https://json-render.dev/docs/api/shadcn) catalog plus a small set of rich-content components. Agent output is validated data rather than generated React. For prototypes that need a complete document, the explicit `HtmlPreview` escape hatch renders raw HTML in a separate, opaque-origin sandbox instead of the portal document.

## Features

- Random port from `10000-20000` for each agent session
- Friendly six-letter nip.io hostname such as `violet-7f000001.nip.io`
- Clickable Pi TUI footer status
- TUI confirmation box offering to open the portal when the first view is ready
- Local-only listener bound to `127.0.0.1`, with an opt-in free Cloudflare Quick Tunnel for remote access
- Capability-authenticated WebSocket connection
- Live updates, reconnects, view history, refresh-safe form state, and instant tab-state restoration for views used in the last 15 minutes
- Full json-render state binding, repeats, visibility, watchers, and built-in state actions
- Shared tools for asset staging, catalog-composed UI, targeted component discovery, required feedback forms, sandboxed HTML previews, and live state
- Accessible bar, line, area, donut, and sparkline charts with responsive SVG rendering and tabular screen-reader data
- File-based responsive, desktop, tablet, and mobile prototypes
- `wui_read_state` and `wui_update_state` for live view state
- Graceful session shutdown and browser notification

## Install for Pi

Install the latest version directly from GitHub:

```bash
pi install git:github.com/khanhicetea/pi-wui
```

For a reproducible install, pin a release tag:

```bash
pi install git:github.com/khanhicetea/pi-wui@v0.1.0
```

Pi clones the repository and installs its runtime dependencies automatically. Start `pi` normally after installation. To update an unpinned install later, run `pi update --extensions`; pinned tags stay pinned until you install a different ref.

To try a checkout during development instead:

```bash
npm install
npm run build
pi -e .
```

Or install that local checkout persistently:

```bash
pi install /absolute/path/to/pi-wui
```

## Install for Codex

Build a checkout, then register its stdio MCP executable:

```bash
npm install
npm run build
codex mcp add pi-wui --env WUI_AGENT_NAME=Codex -- node /absolute/path/to/pi-wui/dist/mcp.js
```

Restart Codex after adding the server. The ChatGPT desktop app, Codex CLI, and Codex IDE extension share this MCP configuration. This repository also contains a Codex plugin manifest at `.codex-plugin/plugin.json`; a marketplace install bundles the MCP server and the `wui-design` skill together.

## Other MCP coding agents

Run `node /absolute/path/to/pi-wui/dist/mcp.js` as a local stdio MCP server. The root `.mcp.json` is also suitable for plugin hosts that support `${PLUGIN_ROOT}`. Set `WUI_AGENT_NAME` to the host label you want displayed in the portal.

When the first view is presented, the adapter starts the server and returns a URL like:

```text
http://violet-7f000001.nip.io:14321/#token=...
```

In TUI mode, pi shows a confirmation box when the first Web UI view becomes ready, rather than at session startup. It offers to open the URL in the default browser when the host has a graphical session. When `CMUX_SHELL_INTEGRATION=1`, it instead opens the URL in a cmux browser split with `cmux browser open-split`. On a headless Linux server, VM, or remote macOS/Windows session, it offers to copy the URL instead. The prompt is skipped if an authenticated browser is already connected.

If nip.io is blocked by DNS rebinding protection, use the fallback shown by `/wui status`:

```text
http://127.0.0.1:14321/#token=...
```

### Cloudflare Quick Tunnel

When the agent is running on a private network and the portal must be reachable from the Internet, set `PI_WUI_CF_TUNNEL` for Pi or `WUI_CF_TUNNEL` for MCP to any value other than `0`:

```bash
PI_WUI_CF_TUNNEL=1 pi -e .
# MCP
WUI_CF_TUNNEL=1 node dist/mcp.js
```

WUI starts `cloudflared tunnel --url http://localhost:<random-port>` as a session-scoped child process and uses the generated `https://*.trycloudflare.com` capability URL as the primary URL. Quick Tunnels are free and require no Cloudflare account. The process is stopped with the WUI server. If `cloudflared` is unavailable, WUI warns and continues with the local URL; install it using Cloudflare's [official instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

Quick Tunnels are intended for testing and development and have [documented limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Setting the applicable tunnel variable to `0`, or leaving it unset, disables the tunnel.

## Pi commands

| Command | Description |
| --- | --- |
| `/wui` or `/wui status` | Show the primary and fallback URLs |
| `/wui open` | Open the portal in a cmux browser split when integrated, otherwise use the default browser or copy its URL on a headless host |
| `/wui restart` | Restart it with a new port, word, and token |
| `/wui stop` | Stop it for the current session |

The server starts lazily when `wui` creates the first view, so sessions that do not use Web UI incur no server startup cost. Using `/wui` starts it explicitly; pass `--wui` to opt into eager session startup.

## Agent tools

Pi keeps its full tool schemas inactive in ordinary sessions. The small `wui_load` tool enables them additively when a browser UI is relevant. MCP exposes the tools through normal MCP discovery and does not need `wui_load`. The detailed design and common-component reference remain in the progressively disclosed `wui-design` skill instead of every system prompt; exact schemas for less-common components are available through targeted discovery.

### `wui_load`

Enables `wui`, `wui_get_component_docs`, `wui_upload_assets`, `wui_read_state`, and `wui_update_state` for the current session. The agent normally calls this automatically when a dashboard, report, structured form, or web/mobile prototype would benefit from a browser UI. Surveys, intake/discovery questionnaires, explicit form requests, and any turn that asks three or more questions should use a `wui` feedback form instead of listing the questions in chat.

### `wui_get_component_docs`

Returns the exact JSON prop schema, events, slots, description, and example for 1–12 selected components. Common dashboard, report, form, chart, and prototype components stay documented in the `wui-design` guide. Use this tool only when a view needs a less-common component such as an overlay, navigation control, carousel, menu, toggle, or button group.

### `wui_upload_assets`

Snapshots 1–24 local images or fonts in one call and returns an opaque `asset://...` ID for each filename. Use the returned ID as the complete `src` in a later `wui` catalog spec; no URL construction or top-level `assets` declaration is needed. The source files are never changed or removed. Only passive browser-safe extensions are accepted: `.avif`, `.gif`, `.ico`, `.jpeg`, `.jpg`, `.png`, `.webp`, `.woff`, and `.woff2`.

### `wui`

Creates a view from a json-render `spec`, logical local `assets`, staged `html` files, or any combination. Without `feedback` it is non-blocking. Add `feedback` to request submit/cancel input; the complete json-render state is returned on submit. Pi waits inside the `wui` call. MCP returns the portal URL immediately with `status: "waiting"` and the agent then calls `wui_wait_for_feedback`. Each call creates a history entry by default. Pass a stable `viewId` to update one view, or set `mode` to `replace` to update the active view.

For HTML-only views, pass 1–12 files in `html` and optionally set `columns`; WUI generates the preview Grid. For a mixed catalog/HTML view, include `HtmlPreview` placeholders in `spec` and target each one with `html[].elementId`. The placeholder may use empty `props`; preview options on the `html` item take precedence. Create generated source files in the system temporary directory rather than the coding-agent workspace and set `cleanupSource: true`; never enable cleanup for a user-owned file. WUI copies each source into a session-owned temporary directory and serves it from a random `/sandbox/:id` URL. Set `html[].webRoot` when relative files such as CSS and images must be staged with the entry document.

### MCP lifecycle tools

- `wui_get_design_guide` returns the bundled authoring workflow and common-component catalog.
- `wui_get_component_docs` returns exact documentation for selected less-common catalog components.
- `wui_wait_for_feedback` waits for a form previously presented with `feedback`.
- `wui_read_events` reads passive button submissions that were not part of a feedback request.
- `wui_status` returns the current primary/fallback URLs and connection state.
- `wui_stop` stops the MCP session's portal.

### `wui_read_state`

Reads the complete live state of a view, or one value using an RFC 6901 JSON Pointer. This includes browser-side changes that have been synchronized to the session server.

### `wui_update_state`

Applies `set` and `remove` operations to an existing view's state and updates the browser immediately. This is useful for live progress, status, filters, and data updates without regenerating the full spec.

### Required feedback

Add `feedback` to `wui` when the agent must wait for the form, for example `{"title":"Profile","feedback":{},"spec":{...}}`. On MCP, follow the returned instruction with `wui_wait_for_feedback`. This is the required path for surveys, structured intake/discovery, explicit form requests, and three or more questions in one turn. A minimal value for `spec` looks like this:

```json
{
  "root": "card",
  "state": {
    "profile": {
      "name": ""
    }
  },
  "elements": {
    "card": {
      "type": "Card",
      "props": {
        "title": "Profile",
        "description": "Tell us about yourself",
        "maxWidth": "md",
        "centered": true
      },
      "children": ["fields"]
    },
    "fields": {
      "type": "Stack",
      "props": {
        "direction": "vertical",
        "gap": "md"
      },
      "children": ["name", "submit"]
    },
    "name": {
      "type": "Input",
      "props": {
        "label": "Name",
        "name": "name",
        "type": "text",
        "value": {
          "$bindState": "/profile/name"
        },
        "checks": [
          {
            "type": "required",
            "message": "Name is required"
          }
        ]
      },
      "children": []
    },
    "submit": {
      "type": "Button",
      "props": {
        "label": "Save",
        "variant": "primary"
      },
      "on": {
        "press": {
          "action": "submit",
          "params": {
            "intent": "save-profile"
          }
        }
      },
      "children": []
    }
  }
}
```

## Data binding and local interaction

The portal supports json-render's state model directly:

- `{"$state":"/path"}` for one-way reads
- `{"$bindState":"/path"}` and `{"$bindItem":"field"}` for two-way input binding
- `repeat` with `$item` and `$index` for dynamic arrays
- `$cond`, `$template`, and `visible` for derived and conditional UI
- `setState`, `pushState`, `removeState`, and `validateForm` actions
- top-level `watch` bindings for dependent local state

State paths use [JSON Pointer](https://datatracker.ietf.org/doc/html/rfc6901), not JavaScript dot notation. See the [json-render data-binding guide](https://json-render.dev/docs/data-binding).

## Component catalog

The browser ships all 36 official shadcn components:

- Layout: `Card`, `Stack`, `Grid`, `Separator`
- Navigation: `Tabs`, `Accordion`, `Collapsible`, `Pagination`
- Overlays: `Dialog`, `Drawer`, `Tooltip`, `Popover`, `DropdownMenu`
- Content: `Heading`, `Text`, `Image`, `Avatar`, `Badge`, `Alert`, `Carousel`, `Table`
- Feedback: `Progress`, `Skeleton`, `Spinner`
- Inputs and actions: `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider`, `Button`, `Link`, `Toggle`, `ToggleGroup`, `ButtonGroup`
- WUI additions: `Markdown`, `Code`, `HtmlPreview`, `Metric`, `KeyValue`, `BarChart`, `LineChart`, `AreaChart`, `DonutChart`, `Sparkline`
- Actions: `submit`, `cancel`, plus json-render's built-in state and validation actions

The bundled `wui-design` guide documents common components directly. Agents can call `wui_get_component_docs` for exact schemas and examples when a view needs one of the less-common navigation, overlay, carousel, menu, toggle, or button-group components. See the [shadcn API reference](https://json-render.dev/docs/api/shadcn) for upstream details.

### Logical file assets

The simplest catalog-asset workflow is to upload local files first:

```text
wui_upload_assets {"paths":["/tmp/generated-image.png","/tmp/thumbnail.webp"]}
```

The result pairs every preserved filename with a random ID, for example `generated-image.png → asset://8Ad3kLm9Qp2`. Use that returned ID as the complete value of an `Image` or `Avatar` `src` in a later `wui` spec. WUI resolves it to a random same-origin URL and retains the snapshot while its view is in history. Uploads accept 1–24 files per call, never modify source files, and allow only `.avif`, `.gif`, `.ico`, `.jpeg`, `.jpg`, `.png`, `.webp`, `.woff`, and `.woff2`.

The existing one-call atomic form remains available when cleanup or a hand-authored logical ID is useful:

```json
{
  "title": "Generated image",
  "assets": [
    { "id": "generated-image", "path": "/tmp/generated-image.png", "cleanupSource": true }
  ],
  "spec": {
    "root": "image",
    "state": {},
    "elements": {
      "image": {
        "type": "Image",
        "props": { "src": "asset://generated-image", "alt": "Generated image" },
        "children": []
      }
    }
  }
}
```

Direct asset IDs use letters, numbers, dashes, and underscores. A view accepts up to 24 files, with limits of 25MB per file and 100MB total. Both upload modes accept only the passive web extensions listed above. `cleanupSource` is accepted only for direct asset sources under the system temporary directory. Resolved URLs are returned in `wui` result details for debugging; agents should keep authoring with logical IDs rather than copying those URLs into later calls.

### Raw HTML previews

When a complete web or mobile prototype is more natural than composing catalog components, create files and pass them to `wui`:

```text
write /tmp/editorial.html
write /tmp/minimal.html
wui {
  "title": "Checkout mobile concepts",
  "columns": 2,
  "html": [
    { "title": "Editorial", "path": "/tmp/editorial.html", "viewport": "mobile", "height": 844, "cleanupSource": true },
    { "title": "Minimal", "path": "/tmp/minimal.html", "viewport": "mobile", "height": 844, "cleanupSource": true }
  ]
}
```

Each resulting `HtmlPreview` receives only a random `/sandbox/:id` source URL. `viewport` supports `responsive`, `mobile` (390px), `tablet` (768px), and `desktop` (1280px).

For a generated site with relative assets, stage its web root as one bounded snapshot:

```text
write /tmp/pi-wui-site/index.html
write /tmp/pi-wui-site/assets/site.css
wui {
  "title": "Generated site",
  "html": [
    {
      "path": "/tmp/pi-wui-site/index.html",
      "webRoot": "/tmp/pi-wui-site",
      "allowScripts": false,
      "cleanupSource": true
    }
  ]
}
```

WUI copies non-hidden regular files from `webRoot` (maximum 500 files and 50MB total), rejects symlinks, and preserves relative paths. When `cleanupSource` is enabled for a bundle, the complete web root must be inside the system temporary directory and is removed after staging. To place one beside catalog content or a feedback form, add `{"type":"HtmlPreview","props":{},"children":[]}` to the spec and set that element's key as `elementId` on the corresponding `html` item.

For complicated bespoke styling, use raw CSS in an inline `<style>`. For simple utility styling, Tailwind CSS 3 Play CDN is available with `<script src="https://cdn.tailwindcss.com"></script>`. For simple local interaction and state mapping, Alpine.js 3 is available with `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js"></script>` and directives such as `x-data`, `x-model`, `x-show`, and `@click`. Both libraries require `allowScripts: true`; explicit user preferences take priority. Other external assets, fetch, WebSocket, form submission, popups, and portal access are blocked. Embed remaining resources in a single-file preview, or stage local relative resources with `webRoot`. Staged documents are deleted when replaced, pruned from view history, or when the session ends.

## Built-in layout guidance

The package also ships the `wui-design` agent skill. Pi discovers it automatically, and the Codex plugin bundles the same skill. It gives the agent concrete composition rules for full-width roots, dashboard grids, responsive columns, card sizing, visual hierarchy, form UX, and mixed HTML previews. Its catalog reference contains the exact component, binding, event, action, and sandbox API and is loaded only when a catalog `spec` is needed.

Tool descriptions intentionally stay compact to reduce recurring prompt usage. The `wui_load` result directs the agent to load the skill before composing a view. As a runtime safety net, an omitted alignment on a vertical root `Stack` is normalized to `stretch`, preventing the common narrow-left-column layout.

For consistent results, dashboard/report specs should generally use:

```text
vertical root Stack (align: stretch)
├── KPI Grid (3–4 columns)
├── alerts/context
├── panel Grid (2 columns)
└── full-width table/details
```

Use horizontal `Stack` only for compact controls or actions, not as the primary page-column layout.

## Security model

The six-letter hostname is a label, not a secret. Every runtime also creates a random capability token. The token is delivered in the URL fragment, saved in browser session storage, removed from the visible address, and sent only as the first WebSocket message.

Additional controls include:

- Binding only to `127.0.0.1` (Cloudflare reaches it through the local `cloudflared` child process when explicitly enabled)
- Strict `Host` and `Origin` validation, including only the generated Quick Tunnel hostname when enabled
- No permissive CORS on portal or catalog-resource endpoints; random sandbox bundles selectively allow their opaque `null` origin so relative files can load
- CSP, no-referrer, frame, MIME-sniffing, and permissions headers
- Catalog and structural validation for every spec
- Payload, state, view, and element limits
- No generic filesystem endpoint; `wui_upload_assets` and catalog assets expose only explicitly staged passive web files behind random IDs
- Safe Markdown with raw HTML disabled
- Raw HTML confined to opaque-origin iframes, with scripts opt-in and network/form/popup access blocked
- External resources blocked except the explicitly allowlisted Tailwind CSS 3 Play CDN and Alpine.js 3 CDN script
- Random asset and sandbox IDs, atomic staging rollback, and session-owned temporary files removed on replacement, pruning, or shutdown
- URL and image protocol restrictions

The capability URL can still appear in terminal logs or screen recordings. It expires when the coding-agent session or Web UI server ends.

## Development

```bash
npm run quality
npm run typecheck
npm test
npm run test:coverage
npm run build
# or run lint, formatting, release consistency, types, tests, and build
npm run check
```

Built browser assets are written to `dist/web`; the bundled stdio server is written to `dist/mcp.js`. The Pi extension entrypoint remains TypeScript at `src/index.ts`, as supported by Pi packages.

`npm install` configures the repository's tracked pre-commit hook automatically. Before each commit, the hook runs the complete check, rebuilds the distributable bundles, and stages generated changes. CI tests Node 20 and 24, checks coverage thresholds, audits production dependencies, verifies committed bundles, and dry-runs the package.

Release manifests share the version from `package.json`; the MCP bundle imports it directly. To prepare a release from a clean worktree, run `npm run release -- <semver>`. The script updates `package.json`, `package-lock.json`, and `.codex-plugin/plugin.json`, runs the complete check, and leaves the reviewed commit and `v<semver>` tag creation explicit. To configure the hook manually, run `npm run setup-hooks`.

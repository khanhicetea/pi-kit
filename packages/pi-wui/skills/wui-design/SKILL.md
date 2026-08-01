---
name: wui-design
description: Designs polished, responsive coding-agent Web UI views with the unified wui tool. Use for dashboards, reports, tables, charts, cards, multi-column layouts, and HTML previews. MUST use for surveys, intake/discovery questionnaires, explicit browser-form requests, or whenever asking the user three or more questions at once.
---

# WUI Design

Use this workflow before calling `wui`. This skill is the authoritative composition guide because the lazily loaded tool descriptions are intentionally compact.

When creating or revising a json-render `spec`, first read [references/catalog.md](references/catalog.md) completely for the common components, props, bindings, events, actions, and sandbox constraints. For an HTML-only view, this extra reference is unnecessary. If the common catalog does not cover a component you need, call `wui_get_component_docs` with only the selected less-common component names; do not load schemas speculatively.

## Mandatory interaction rule

Do not print a questionnaire in chat when any of these applies:

- You need to ask **three or more questions** in the same turn.
- You are conducting a survey, intake, requirements interview, planning questionnaire, or design discovery.
- The user asks to be questioned "using a form", in the browser, or with structured controls.

Instead, call `wui_load` if that loader is available and `wui` is not currently active, then call `wui` with a catalog form and `feedback` in the same turn. Group related questions into clear sections, initialize and bind every field, provide useful choice controls where possible, and include an explicit submit Button. Do not first duplicate the questions as a numbered chat message. Use ordinary conversation only for one or two simple questions.

Pi waits for feedback inside the `wui` call. MCP adapters return the portal URL immediately with `status: "waiting"`; give that URL to the user and call `wui_wait_for_feedback` to wait for the result.

## 1. Plan the information hierarchy

Write a short layout plan before the JSON:

1. **Purpose** — what decision or task should the view support?
2. **Priority** — what must be understood first?
3. **Sections** — group related content instead of treating every component as a separate row.
4. **Desktop columns** — decide which siblings belong in the same `Grid`.
5. **Interaction** — omit `feedback` for browsing; add `feedback` only when the agent must wait for a submission.

A common dashboard plan is:

- title/summary
- KPI grid
- alert or important context
- two-column comparison/chart grid
- full-width detail table

## 2. Start with a full-width page shell

Use this root for dashboards and reports:

```json
{
  "root": "page",
  "state": {},
  "elements": {
    "page": {
      "type": "Stack",
      "props": { "direction": "vertical", "gap": "lg", "align": "stretch" },
      "children": ["heading", "metrics", "panels", "details"]
    }
  }
}
```

`Stack` is flexbox. Its upstream default is `align: "start"`, which can shrink-wrap child grids, cards, and tables into a narrow left column. Always set `align: "stretch"` on a dashboard/report root. WUI also repairs an omitted alignment on a vertical root Stack, but author it explicitly.

For a focused compact form, use a full-width root Stack and put a centered Card inside it, or make a Card the root:

```json
{
  "type": "Card",
  "props": {
    "title": "Profile",
    "description": "Confirm your details",
    "maxWidth": "lg",
    "centered": true
  },
  "children": ["fields"]
}
```

Use compact `maxWidth: "sm" | "md" | "lg"` only when narrowness is intentional. Dashboard Cards should omit `maxWidth` or use `"full"`.

## 3. Use Grid for columns

`Grid` is the primary page-column primitive. Components that should share a row must be **direct children of the same Grid**.

```json
"metrics": {
  "type": "Grid",
  "props": { "columns": 4, "gap": "md" },
  "children": ["revenue", "orders", "conversion", "refunds"]
},
"panels": {
  "type": "Grid",
  "props": { "columns": 2, "gap": "lg" },
  "children": ["trendCard", "channelCard"]
}
```

Rules:

- Match `columns` to the intended desktop columns and usually to the number of direct children.
- Use 4 columns for four compact KPIs, 3 for three peer summaries, 2 for paired charts/forms, and 1/full-width for dense content.
- Never set 6 columns for four items unless two empty tracks are intentional.
- Do not use a horizontal Stack for dashboard columns. It wraps children at intrinsic widths and commonly creates narrow cards plus large blank areas.
- Use horizontal Stack only for compact actions, badges, filters, or inline metadata.
- Do not fake columns by alternating Cards directly under the root Stack.

Responsiveness is already supplied by the portal:

- At widths below 1100px, desktop Grids with 3–6 columns become 2 columns.
- At widths below 760px, every multi-column Grid becomes 1 column.

Do not duplicate mobile variants or attempt breakpoint-specific props.

## 4. Compose sections, not isolated widgets

Prefer a shallow tree:

```text
root Stack (stretch)
├── heading/lead
├── KPI Grid (4)
│   ├── Metric
│   ├── Metric
│   ├── Metric
│   └── Metric
├── Alert
├── analysis Grid (2)
│   ├── Card -> BarChart
│   └── Card -> KeyValue/BarChart
└── Card -> Table
```

Quality rules:

- Put comparable values in one visual group.
- Keep chart scales and labels easy to compare.
- Use `Metric` for headline values, `Sparkline` for a compact trend, `BarChart` for category comparisons, `LineChart` or `AreaChart` for ordered trends, `DonutChart` for parts of a whole, and `Table` for exact multi-column data.
- When the result is naturally a complete web page, responsive prototype, or mobile UI that catalog composition would constrain, first create `.html` files with native file tools, then pass them in `wui.html`. Store generated files under the system temporary directory, never in the coding-agent workspace, and set `cleanupSource: true`. Do not embed large `HtmlPreview.html` strings in `spec`. For a multi-file site, put the entry and its relative assets under one temporary directory and set `html[].webRoot` to that directory.
- An HTML-only `wui` view may contain 1–12 independent sandboxes. Use `html` with one path, label, viewport, height, and `cleanupSource: true` per generated concept; set `columns` to the intended desktop comparison Grid. For a mixed catalog/HTML view, put each `HtmlPreview` where it belongs in `spec` and target it with the matching `html[].elementId`.
- Styling has two supported paths. For complicated, bespoke visual systems, prefer raw CSS in an inline `<style>` block. For simple utility-based styling, Tailwind CSS 3 Play CDN may be used with `<script src="https://cdn.tailwindcss.com"></script>` and `allowScripts: true`. These are options, not mandates: always follow an explicit user choice; otherwise select the better fit.
- For simple local interaction and state mapping, Alpine.js 3 is available with `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js"></script>` and `allowScripts: true`. Prefer concise Alpine directives such as `x-data`, `x-model`, `x-show`, `x-bind`, and `@click` over hand-written state plumbing when they fit. Keep all state inside the sandbox; fetch and WebSocket remain blocked.
- A single-file preview should embed its CSS, SVG, JavaScript, and data URLs. A multi-file preview may set `webRoot` so local relative CSS, images, fonts, and scripts are staged together; hidden files are skipped, symlinks are rejected, and bundle limits apply. Only Tailwind Play CDN and Alpine.js 3 are allowlisted externally. Scripts are disabled by default; enable them only for local interaction, local bundled scripts, or an allowlisted CDN library. Generated sandbox sources are disposable temporary files and must use `cleanupSource: true`; do not enable it for a user-owned file.
- To show local images or fonts in a catalog view, prefer `wui_upload_assets` with all host file paths in one call. It returns a random `assetId` beside each preserved filename; use that exact `asset://...` value as the complete `Image` or `Avatar` `src` in the later `wui` spec. Do not invent an ID, redeclare the uploaded file in `wui.assets`, discover the WUI URL, construct server paths, use capability tokens, or copy files into a public directory. Uploads accept only the passive web extensions listed by the tool and never remove their source files. The direct top-level `wui.assets` form remains available when one-call atomic staging or `cleanupSource` for a generated temporary file is specifically useful.
- Use `Card` to define meaningful sections, not around every tiny Text or Badge.
- Avoid Card-inside-Card unless the inner card is independently meaningful.
- Use one clear page heading. Use Card titles or lower-level Headings for section labels.
- Put the most actionable warning near the content it affects.
- Prefer concise labels; move explanation into muted Text, Card description, Alert, or Markdown.
- Do not rely on generated `className`/Tailwind utilities for layout. Use catalog props so the result remains validated and responsive.

### Generated image example

First upload every image together:

```json
{
  "paths": ["/tmp/generated-image.png", "/tmp/thumbnail.webp"]
}
```

Then copy the exact `assetId` returned for `generated-image.png` into the view; do not shorten or regenerate it:

```json
{
  "title": "Generated image",
  "spec": {
    "root": "image",
    "state": {},
    "elements": {
      "image": {
        "type": "Image",
        "props": { "src": "asset://RETURNED_RANDOM_ID", "alt": "Generated image" },
        "children": []
      }
    }
  }
}
```

### Multi-file HTML bundle example

Create the entry and assets under one generated temporary root, then stage that root atomically:

```json
{
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

References such as `./assets/hero.png` and `./assets/site.css` continue to work inside the opaque-origin sandbox. Do not use a project root or user-owned directory with `cleanupSource`.

## 5. Form UX

For `wui` with `feedback`:

- Surveys, requirement gathering, design discovery, and other multi-question intake belong in one browser form, not a numbered chat questionnaire.
- Ask only for information needed to continue the task.
- Use one column for long or unfamiliar fields.
- Use a 2-column Grid only for short, closely related fields such as first/last name or start/end date.
- Bind every control to initialized state with `$bindState` (or `$bindItem` in a repeat).
- Use meaningful defaults and placeholders; never use placeholder text as the only label.
- Add validation checks and set `validateOn` appropriately.
- Put Submit and Cancel together in a horizontal Stack. Make the primary action first and label it with the outcome (`Save profile`, `Run report`), not a vague `OK`.
- Bind submit explicitly with `on.press` and the `submit` action. Use the `cancel` action for cancellation.
- Keep destructive actions visually and semantically distinct.
- Use ordinary conversation instead of a browser form only for one or two simple questions, unless the user explicitly requests a form.

Suggested form structure:

```text
Card (compact + centered, or full width for long forms)
└── vertical Stack (stretch)
    ├── field or related-field Grid (2)
    ├── full-width long field
    ├── validation/status Alert (conditional if needed)
    └── horizontal Stack of actions
```

## 6. Final preflight

Before sending the tool call, verify:

- Root and every child key exist; every element has `type`, `props`, and `children`.
- Dashboard/report root is stretched.
- Every intended row has a Grid parent with the right column count.
- No compact Card width was accidentally used for a dashboard panel.
- Dense tables and long text are full width.
- Complete web/mobile prototypes use `wui.html` with the right viewport; multi-file sites set `webRoot`, and comparisons use one multi-preview view rather than separate history entries.
- Local catalog images/fonts were first passed together to `wui_upload_assets`, and each later `src` is the exact returned `assetId`. If the direct `wui.assets` form is intentionally used instead, every `asset://<id>` reference has one matching unique declaration.
- Raw CSS versus Tailwind 3 follows the user's preference; Alpine.js 3 is a concise option for simple local state and interaction. Scripts are enabled only when interaction or an allowlisted CDN library needs them.
- The layout remains logical when Grids collapse to one column.
- State paths are RFC 6901 JSON Pointers and initialized in `spec.state`.
- Controls are bound; submit/cancel actions are wired.
- No component, prop, event, action, or CSS behavior was invented. If a less-common component was needed, its exact schema was loaded with `wui_get_component_docs`.
- The normal assistant response still summarizes the result in case the browser is unavailable.

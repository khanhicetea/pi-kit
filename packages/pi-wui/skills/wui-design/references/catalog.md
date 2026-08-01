# WUI Catalog and API Reference

Use a flat json-render spec:

```json
{"root":"root","state":{},"elements":{"root":{"type":"Stack","props":{"direction":"vertical","gap":"lg","align":"stretch"},"children":[]}}}
```

Every element needs `type`, `props`, and `children`; every child key must exist. Nullable shadcn props may be omitted.

## Layout and width

- For a dashboard/report root, use a vertical `Stack` with `align: "stretch"`. Stack is flexbox and otherwise defaults to `align: "start"`, which can shrink-wrap children into a narrow left column.
- `Grid` is the page-column primitive. Put items that should share a row directly under one Grid. Use columns equal to the intended number of desktop columns, and usually no more than the number of direct children: 4 for four KPIs, 2 for two charts/panels, and 1 for a full-width section.
- Do not use a horizontal Stack for primary page columns. Use it only for compact controls, badges, or action buttons.
- Cards are full width by default. Use `maxWidth: "full"`, or omit `maxWidth`, for dashboard panels. `maxWidth: "sm" | "md" | "lg"` deliberately creates a compact Card; pair it with `centered: true` only for focused forms or detail panels.
- Group comparable content: KPIs in one Grid, side-by-side charts in one Grid, then a full-width table/details section.
- Responsiveness is automatic: desktop Grids with 3–6 columns become 2 columns below 1100px, and every multi-column Grid becomes 1 column below 760px. Do not duplicate mobile elements.
- Keep hierarchy shallow: root Stack → section Grid/Card → content. Avoid nested Cards unless the inner Card is an independently meaningful panel.

## Common components

These components cover normal reports, dashboards, forms, and prototypes and are kept in this guide so no discovery call is needed:

- Layout: `Card(title,description,maxWidth sm|md|lg|full,centered)`, `Stack(direction horizontal|vertical,gap none|sm|md|lg|xl,align,justify)`, `Grid(columns 1-6,gap)`, `Separator(orientation)`
- Content: `Heading(text,level h1-h4)`, `Text(text,variant body|caption|muted|lead|code)`, `Markdown(content)`, `Code(code,language,filename)`, `Image(src,alt,width,height)`, `Badge(text,variant default|secondary|destructive|outline)`, `Alert(title,message,type info|success|warning|error)`, `Table(columns[string],rows[string[]],caption)`, `Metric(label,value,detail,trend up|down|neutral)`, `KeyValue(items[{label,value}])`
- Charts: `BarChart(title,items[{label,value,color?}])`, `LineChart(title,labels[string],series[{name,values[number],color?}],showLegend?)`, `AreaChart(title,labels[string],series[{name,values[number],color?}],showLegend?)`, `DonutChart(title,centerLabel,items[{label,value,color?}])`, `Sparkline(label,value,values[number],color?)`. Custom colors must be hexadecimal. Every line/area series must have exactly one value per label; donut values are non-negative.
- Feedback: `Progress(value,max,label)`, `Spinner(size,label)`
- Inputs: `Input(label,name,type,placeholder,value,checks,validateOn)`, `Textarea(label,name,placeholder,rows,value,checks,validateOn)`, `Select(label,name,options[string],placeholder,value,checks,validateOn)`, `Checkbox(label,name,checked,checks,validateOn)`, `Radio(label,name,options,value,checks,validateOn)`, `Switch(label,name,checked,checks,validateOn)`, `Slider(label,min,max,step,value)`
- Actions: `Button(label,variant primary|secondary|danger,disabled)`, `Link(label,href)`
- Prototype: `HtmlPreview(html|src,title,height 200-2000,viewport responsive|mobile|tablet|desktop,allowScripts)`

## Targeted discovery for less-common components

The catalog also contains `Accordion`, `Avatar`, `ButtonGroup`, `Carousel`, `Collapsible`, `Dialog`, `Drawer`, `DropdownMenu`, `Pagination`, `Popover`, `Skeleton`, `Tabs`, `Toggle`, `ToggleGroup`, and `Tooltip`. Before using any of these, call `wui_get_component_docs` with only the exact names needed. It returns the authoritative JSON prop schema, events, slots, description, and example. Do not guess their API and do not call discovery for common components already documented above.

Never invent component or prop names.

## HTML previews

- For complete web/mobile UIs, create `.html` files with native `write`/`edit`, then pass them in `wui.html`. Single-file previews may be self-contained; multi-file previews set `html[].webRoot`.
- An HTML-only `wui` call automatically composes 1–12 previews in a Grid.
- A mixed view uses `HtmlPreview` placeholders in `spec` plus matching `html[].elementId` values.
- Use inline `HtmlPreview.html` only for short snippets. Staged `HtmlPreview.src` values are created by WUI and must not be invented.
- Preview modes render at 100%, 390px, 768px, or 1280px for responsive, mobile, tablet, or desktop.
- For complicated bespoke styling, prefer raw CSS in an inline `<style>`. For simple utility styling, Tailwind CSS 3 Play CDN is available through `<script src="https://cdn.tailwindcss.com"></script>` with `allowScripts: true`.
- For simple local interaction, Alpine.js 3 is available through `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js"></script>` with `allowScripts: true`. Prefer concise `x-data`, `x-model`, `x-show`, `x-bind`, and `@click` directives when appropriate.
- Scripts are disabled by default. The sandbox cannot access the portal, submit forms, open popups, or make fetch/WebSocket requests. Other external assets are blocked. Embed resources for a single-file preview, or keep local CSS, images, fonts, and scripts under `webRoot` and reference them with normal relative URLs.
- A staged `webRoot` is a bounded snapshot: hidden files are skipped, symlinks are rejected, and the entry must be inside the root. Use generated temporary roots with `cleanupSource: true`; never clean up user-owned directories.

## Logical catalog assets

- Declare up to 24 explicit files in top-level `wui.assets` as `{id,path,cleanupSource?}`.
- Use the complete string `asset://<id>` in a URL-bearing catalog prop such as `Image.src` or `Avatar.src`.
- IDs contain only letters, numbers, dashes, and underscores and must be unique in the call.
- WUI stages every file, resolves references, and validates the view atomically. An unknown ID fails with `Unknown asset id “<id>”` and rolls back staged copies.
- Do not construct `/_wui/resource/...` URLs. Resolved URLs in tool result details are for debugging only.
- Generated files should live under the system temporary directory and use `cleanupSource: true`. Cleanup is rejected outside that directory.

## State and data binding

All paths are RFC 6901 JSON Pointers such as `/form/name`, never dot notation.

- `spec.state` is the single source of truth. Initialize every referenced path.
- Read state in any prop with `{"$state":"/path"}`.
- Bind controls two-way on their natural prop: `value` for Input/Textarea/Select/Radio/Slider/Tabs/ToggleGroup/DropdownMenu/Pagination, `checked` for Checkbox/Switch, `pressed` for Toggle, and `selected` for ButtonGroup.
- Example binding: `{"value":{"$bindState":"/form/name"}}`.
- Derive a prop with `{"$cond":{"$state":"/status","eq":"done"},"$then":"Complete","$else":"Pending"}`.
- Interpolate strings with `{"$template":"Hello ${/user/name}"}`. Missing paths become empty strings.
- Show/hide with top-level `visible`, for example `{"$state":"/enabled"}`, `{"$state":"/role","eq":"admin"}`, `{"$state":"/count","gte":1}`, or `{"$or":[...]}`. An array of conditions means AND.

## Dynamic arrays

- Put top-level `repeat` on a container: `"repeat":{"statePath":"/todos","key":"id"}`. Its children render once per item.
- In repeated children, read fields with `{"$item":"title"}`, the whole item with `{"$item":""}`, and the zero-based index with `{"$index":true}`.
- Bind an item field two-way with `{"$bindItem":"completed"}`.
- A repeated child can use `visible:{"$item":"status","eq":"open"}`.
- Always use repeat for state-backed lists; do not hardcode one element per item.

## Local actions and watchers

Put `on` at the element top level, never inside `props`.

- Button event: `on.press`. Inputs emit change/focus/blur and supported submit/select events.
- Set: `{"action":"setState","params":{"statePath":"/activeTab","value":"details"}}`
- Append and clear input: `{"action":"pushState","params":{"statePath":"/todos","value":{"id":"$id","title":{"$state":"/draft"},"completed":false},"clearStatePath":"/draft"}}`
- Remove repeated item: `{"action":"removeState","params":{"statePath":"/todos","index":{"$index":true}}}`
- `validateForm` writes `{valid,errors}` to `/formValidation` or `params.statePath`.
- An event may contain an action array, executed in order. Params may read `$state`; inside repeat they may use `$index`, while `$item` resolves to the current item's absolute path for `statePath` params.
- Use top-level `watch` for reactions after changes, not initial render. Example: `"watch":{"/form/country":{"action":"setState","params":{"statePath":"/form/city","value":""}}}`.
- Validation checks include `required`, `email`, `minLength`, `maxLength`, `pattern`, `min`, `max`, `numeric`, `url`, `matches`, `equalTo`, `lessThan`, `greaterThan`, and `requiredIf`. Bind the field and set `validateOn` to `change`, `blur`, or `submit`.
- For Dialog/Drawer, `openPath` is a literal state path such as `/dialogOpen`; toggle it with `setState`.

## Feedback

For required feedback, add `wui.feedback` and bind a Button's `on.press` to `{"action":"submit","params":{"intent":"save"}}`; cancellation uses the `cancel` action. The complete state is returned.

Without `feedback`, WUI is non-blocking. Pi delivers passive submissions as follow-ups; MCP clients can inspect them with `wui_read_events`.

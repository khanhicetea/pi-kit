import { defineCatalog, getByPath, setByPath } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

const nullableString = z.string().nullish();
const chartColor = z
  .string()
  .regex(/^#[0-9a-f]{3,8}$/i, "Use a hexadecimal color such as #7c3aed.")
  .nullish();
const chartSeries = z.object({
  name: z.string(),
  values: z.array(z.number()).min(1).max(100),
  color: chartColor,
});
const seriesChartProps = z
  .object({
    title: nullableString,
    labels: z.array(z.string()).min(1).max(100),
    series: z.array(chartSeries).min(1).max(8),
    showLegend: z.boolean().nullish(),
  })
  .superRefine((props, context) => {
    props.series.forEach((series, index) => {
      if (series.values.length !== props.labels.length) {
        context.addIssue({
          code: "custom",
          path: ["series", index, "values"],
          message: `Expected ${props.labels.length} values to match labels.`,
        });
      }
    });
  });

const NATURAL_BINDING_PROPS: Record<string, string> = {
  Input: "value",
  Textarea: "value",
  Select: "value",
  Checkbox: "checked",
  Radio: "value",
  Switch: "checked",
  Slider: "value",
  Tabs: "value",
  DropdownMenu: "value",
  Toggle: "pressed",
  ToggleGroup: "value",
  ButtonGroup: "selected",
  Pagination: "page",
};

function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function safeBindingKey(value: string, elementKey: string): string {
  return ["__proto__", "prototype", "constructor"].includes(value) ? `field-${elementKey}` : value;
}

function defaultBindingValue(type: string, props: Record<string, unknown>): unknown {
  if (["Checkbox", "Switch", "Toggle"].includes(type)) return false;
  if (type === "Slider") return typeof props.min === "number" ? props.min : 0;
  if (type === "Pagination") return 1;
  if (type === "Tabs" && Array.isArray(props.tabs)) {
    const first = props.tabs[0];
    if (first && typeof first === "object" && "value" in first) return (first as { value: unknown }).value;
  }
  return "";
}

export const wuiCatalog = defineCatalog(schema, {
  components: {
    ...shadcnComponentDefinitions,
    Markdown: {
      props: z.object({ content: z.string() }),
      description: "Safe GitHub-flavored Markdown without raw HTML.",
    },
    Code: {
      props: z.object({
        code: z.string(),
        language: nullableString,
        filename: nullableString,
      }),
      description: "A scrollable code block with an optional language and filename.",
    },
    HtmlPreview: {
      props: z
        .object({
          html: z.string().optional(),
          src: z
            .string()
            .regex(/^\/sandbox\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@% -]+)*$/)
            .optional(),
          title: nullableString,
          height: z.number().int().min(200).max(2_000).nullish(),
          viewport: z.enum(["responsive", "mobile", "tablet", "desktop"]).nullish(),
          allowScripts: z.boolean().nullish(),
        })
        .refine((props) => Boolean(props.html) !== Boolean(props.src), {
          message: "Provide exactly one of html or src.",
        }),
      description: "Render staged or inline self-contained HTML in an isolated sandbox iframe.",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        detail: nullableString,
        trend: z.enum(["up", "down", "neutral"]).nullish(),
      }),
      description: "A prominent KPI metric with optional detail and trend.",
    },
    KeyValue: {
      props: z.object({
        items: z.array(
          z.object({
            label: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
          }),
        ),
      }),
      description: "A compact list of labeled values.",
    },
    BarChart: {
      props: z.object({
        title: nullableString,
        items: z.array(
          z.object({
            label: z.string(),
            value: z.number(),
            color: chartColor,
          }),
        ),
      }),
      description: "A simple accessible horizontal bar chart.",
      example: { title: "Requests", items: [{ label: "API", value: 128, color: "#7c3aed" }] },
    },
    LineChart: {
      props: seriesChartProps,
      description: "An accessible multi-series line chart for trends over an ordered set of labels.",
      example: {
        title: "Weekly traffic",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "Visits", values: [120, 180, 160], color: "#7c3aed" }],
      },
    },
    AreaChart: {
      props: seriesChartProps,
      description: "An accessible multi-series area chart for trends where magnitude should be emphasized.",
      example: {
        title: "Token usage",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "Tokens", values: [42, 68, 57], color: "#2563eb" }],
      },
    },
    DonutChart: {
      props: z.object({
        title: nullableString,
        centerLabel: nullableString,
        items: z
          .array(
            z.object({
              label: z.string(),
              value: z.number().nonnegative(),
              color: chartColor,
            }),
          )
          .min(1)
          .max(24),
      }),
      description: "An accessible donut chart for showing parts of a non-negative whole.",
      example: {
        title: "Build time",
        centerLabel: "12 min",
        items: [
          { label: "Compile", value: 7, color: "#7c3aed" },
          { label: "Tests", value: 5, color: "#2563eb" },
        ],
      },
    },
    Sparkline: {
      props: z.object({
        label: nullableString,
        value: z.union([z.string(), z.number()]).nullish(),
        values: z.array(z.number()).min(2).max(100),
        color: chartColor,
      }),
      description: "A compact accessible trend line with an optional label and headline value.",
      example: { label: "Latency", value: "84 ms", values: [110, 96, 102, 84], color: "#16a34a" },
    },
  },
  actions: {
    submit: {
      params: z.object({
        intent: z.string().nullish(),
        data: z.record(z.string(), z.unknown()).nullish(),
      }),
      description: "Submit the current complete UI state to the connected coding agent.",
    },
    cancel: {
      params: z.object({ reason: z.string().nullish() }),
      description: "Cancel the current interactive request.",
    },
  },
});

// @json-render/react models visibility as required while the authoring format
// treats it as optional. The shadcn catalog also uses nullable fields for
// optional props; fill omitted nullable props so generated specs stay concise.
export function normalizeWuiSpec(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const spec = structuredClone(value) as Record<string, unknown>;
  if (!spec.elements || typeof spec.elements !== "object" || Array.isArray(spec.elements)) return spec;

  const elements = spec.elements as Record<string, unknown>;
  const rootKey = typeof spec.root === "string" ? spec.root : undefined;
  const state =
    spec.state && typeof spec.state === "object" && !Array.isArray(spec.state)
      ? (spec.state as Record<string, unknown>)
      : {};
  spec.state = state;

  // Descendants of repeat containers share the current item scope. Knowing
  // this lets us repair literal/unbound generated controls with $bindItem
  // instead of accidentally sharing one global value across every row.
  const repeatScoped = new Set<string>();
  const markRepeatChildren = (key: string) => {
    if (repeatScoped.has(key)) return;
    repeatScoped.add(key);
    const child = elements[key];
    if (!child || typeof child !== "object" || Array.isArray(child)) return;
    const children = (child as Record<string, unknown>).children;
    if (Array.isArray(children)) {
      for (const nested of children) if (typeof nested === "string") markRepeatChildren(nested);
    }
  };
  for (const element of Object.values(elements)) {
    if (!element || typeof element !== "object" || Array.isArray(element)) continue;
    const record = element as Record<string, unknown>;
    if (!record.repeat || !Array.isArray(record.children)) continue;
    for (const child of record.children) if (typeof child === "string") markRepeatChildren(child);
  }

  for (const [elementKey, element] of Object.entries(elements)) {
    if (!element || typeof element !== "object" || Array.isArray(element)) continue;
    const record = element as Record<string, unknown>;
    if (!("visible" in record)) record.visible = true;

    const type = typeof record.type === "string" ? record.type : undefined;
    const definition = type ? shadcnComponentDefinitions[type as keyof typeof shadcnComponentDefinitions] : undefined;
    if (!type || !definition || !record.props || typeof record.props !== "object" || Array.isArray(record.props))
      continue;

    const props = record.props as Record<string, unknown>;
    const shape = definition.props.shape as Record<string, z.ZodType>;
    for (const [name, field] of Object.entries(shape)) {
      if (!(name in props) && field.safeParse(null).success) props[name] = null;
    }

    // The official Stack defaults to items-start. That is useful for small
    // inline groups, but a generated page whose root is a vertical Stack then
    // shrink-wraps grids and cards into a narrow left column. Make the page
    // root stretch by default while preserving an explicit author choice.
    if (elementKey === rootKey && type === "Stack" && props.direction !== "horizontal" && props.align === null) {
      props.align = "stretch";
    }

    // Generated controls with literal values look interactive but cannot write
    // back because shadcn's useBoundProp setter has no path. Infer a stable
    // binding while preserving explicit $bindState/$bindItem expressions.
    const bindingProp = NATURAL_BINDING_PROPS[type];
    if (bindingProp !== undefined) {
      const current = props[bindingProp];
      const expression =
        current && typeof current === "object" && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : undefined;
      if (!(expression && ("$bindState" in expression || "$bindItem" in expression))) {
        if (repeatScoped.has(elementKey)) {
          const requestedItemPath =
            expression && typeof expression.$item === "string"
              ? expression.$item
              : typeof props.name === "string" && props.name
                ? props.name
                : elementKey;
          props[bindingProp] = { $bindItem: safeBindingKey(requestedItemPath, elementKey) };
        } else {
          const explicitPath = expression && typeof expression.$state === "string" ? expression.$state : undefined;
          const requestedStateKey = typeof props.name === "string" && props.name ? props.name : elementKey;
          const stateKey = safeBindingKey(requestedStateKey, elementKey);
          const candidates = explicitPath
            ? [explicitPath]
            : [`/form/${pointerToken(stateKey)}`, `/${pointerToken(stateKey)}`];
          const statePath = candidates.find((path) => getByPath(state, path) !== undefined) ?? candidates[0]!;
          if (getByPath(state, statePath) === undefined) {
            const initial =
              current !== null && current !== undefined && !expression ? current : defaultBindingValue(type, props);
            setByPath(state, statePath, initial);
          }
          props[bindingProp] = { $bindState: statePath };
        }
      }
    }

    // Models often render a correctly labelled form button but omit its event
    // binding. Make conventional Submit/Cancel buttons functional rather than
    // adding a second set of controls outside the generated form.
    if (type === "Button") {
      const label = typeof props.label === "string" ? props.label.trim().toLowerCase() : "";
      const on =
        record.on && typeof record.on === "object" && !Array.isArray(record.on)
          ? (record.on as Record<string, unknown>)
          : {};
      if (!("press" in on) && ["submit", "save", "confirm"].includes(label)) {
        on.press = { action: "submit", params: { intent: label } };
        record.on = on;
      } else if (!("press" in on) && ["cancel", "close"].includes(label)) {
        on.press = { action: "cancel", params: { reason: "user cancelled" } };
        record.on = on;
      }
    }
  }
  return spec;
}

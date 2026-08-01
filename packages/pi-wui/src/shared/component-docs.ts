import { z } from "zod";
import { wuiCatalog } from "./catalog";

export const COMMON_COMPONENT_NAMES = [
  "Card",
  "Stack",
  "Grid",
  "Separator",
  "Heading",
  "Text",
  "Markdown",
  "Code",
  "Image",
  "Badge",
  "Alert",
  "Table",
  "Metric",
  "KeyValue",
  "BarChart",
  "LineChart",
  "AreaChart",
  "DonutChart",
  "Sparkline",
  "Progress",
  "Spinner",
  "Input",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Slider",
  "Button",
  "Link",
  "HtmlPreview",
] as const;

const commonComponentNames = new Set<string>(COMMON_COMPONENT_NAMES);

export interface ComponentDocumentation {
  name: string;
  common: boolean;
  description?: string;
  props: z.core.JSONSchema.JSONSchema;
  events: string[];
  slots: string[];
  example?: unknown;
}

export function listCatalogComponents(): { common: string[]; lessCommon: string[] } {
  const names = Object.keys(wuiCatalog.data.components).sort();
  return {
    common: names.filter((name) => commonComponentNames.has(name)),
    lessCommon: names.filter((name) => !commonComponentNames.has(name)),
  };
}

export function getComponentDocumentation(names: string[]): ComponentDocumentation[] {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) throw new Error("Provide at least one component name.");

  const components = wuiCatalog.data.components as Record<
    string,
    {
      props: z.ZodType;
      description?: string;
      events?: readonly string[];
      slots?: readonly string[];
      example?: unknown;
    }
  >;
  const unknown = uniqueNames.filter((name) => !components[name]);
  if (unknown.length > 0) {
    const available = Object.keys(components).sort().join(", ");
    throw new Error(
      `Unknown WUI component${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Available: ${available}`,
    );
  }

  return uniqueNames.map((name) => {
    const definition = components[name]!;
    return {
      name,
      common: commonComponentNames.has(name),
      ...(definition.description ? { description: definition.description } : {}),
      props: z.toJSONSchema(definition.props),
      events: [...(definition.events ?? [])],
      slots: [...(definition.slots ?? [])],
      ...(definition.example !== undefined ? { example: structuredClone(definition.example) } : {}),
    };
  });
}

import { type Static, Type } from "typebox";
import { WUI_SAFE_WEB_ASSET_EXTENSIONS } from "./server";

const JsonRenderElementSchema = Type.Object(
  {
    type: Type.String(),
    props: Type.Record(Type.String(), Type.Unknown()),
    children: Type.Array(Type.String()),
    visible: Type.Optional(Type.Unknown()),
    on: Type.Optional(Type.Unknown()),
    repeat: Type.Optional(Type.Unknown()),
    watch: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const JsonRenderSpecSchema = Type.Object(
  {
    root: Type.String(),
    state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    elements: Type.Record(Type.String(), JsonRenderElementSchema),
  },
  { additionalProperties: false },
);

const HtmlFileAttachmentParameters = Type.Object(
  {
    path: Type.String({
      description:
        "Path to a local .html/.htm entry file. Create generated previews in the system temp directory, not the coding-agent workspace.",
    }),
    webRoot: Type.Optional(
      Type.String({
        description:
          "Optional directory staged with the HTML entry so relative CSS, image, font, and script URLs work. Hidden files and symlinks are excluded.",
      }),
    ),
    elementId: Type.Optional(
      Type.String({
        description:
          "HtmlPreview element to populate. Required when spec is also provided; omit for an HTML-only view.",
      }),
    ),
    title: Type.Optional(Type.String({ description: "Preview label. Defaults to the element ID or view title." })),
    viewport: Type.Optional(
      Type.Union(
        [Type.Literal("responsive"), Type.Literal("mobile"), Type.Literal("tablet"), Type.Literal("desktop")],
        { description: "responsive=100%, mobile=390px, tablet=768px, desktop=1280px." },
      ),
    ),
    height: Type.Optional(Type.Integer({ minimum: 200, maximum: 2000 })),
    allowScripts: Type.Optional(
      Type.Boolean({ description: "Required for local interaction, Tailwind, or Alpine. Default: false." }),
    ),
    cleanupSource: Type.Optional(
      Type.Boolean({
        description: "Delete the source after staging. Set true for generated files in the system temp directory.",
      }),
    ),
  },
  { additionalProperties: false },
);

const AssetFileParameters = Type.Object(
  {
    id: Type.String({
      description: "Logical ID referenced in the catalog spec as asset://<id>.",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z0-9_-]+$",
    }),
    path: Type.String({
      description: `Path to one local file to snapshot into session-owned storage. Allowed extensions: ${WUI_SAFE_WEB_ASSET_EXTENSIONS.join(", ")}.`,
    }),
    cleanupSource: Type.Optional(
      Type.Boolean({
        description:
          "Delete the source after staging. Allowed only for generated files under the system temp directory.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const WuiParameters = Type.Object(
  {
    title: Type.String({ description: "Short title shown in the Web UI history." }),
    spec: Type.Optional(JsonRenderSpecSchema),
    assets: Type.Optional(
      Type.Array(AssetFileParameters, {
        description:
          "Files staged atomically with the view. Reference each from spec as asset://<id>; WUI resolves it before validation.",
        minItems: 1,
        maxItems: 24,
      }),
    ),
    html: Type.Optional(
      Type.Array(HtmlFileAttachmentParameters, {
        description:
          "Local HTML previews to stage. Put generated files in the system temp directory and set cleanupSource=true. With spec, each item targets an HtmlPreview via elementId; without spec, WUI builds a preview Grid.",
        minItems: 1,
        maxItems: 12,
      }),
    ),
    columns: Type.Optional(
      Type.Integer({
        description: "Columns for an HTML-only generated Grid. Compose mixed layouts inside spec instead.",
        minimum: 1,
        maximum: 6,
      }),
    ),
    feedback: Type.Optional(
      Type.Object(
        {
          timeoutSeconds: Type.Optional(
            Type.Integer({
              description: "Seconds to wait for submit or cancel. Default: 600.",
              minimum: 5,
              maximum: 3600,
            }),
          ),
        },
        {
          additionalProperties: false,
          description:
            "When present, require user feedback and wait. Put bound catalog form controls and submit/cancel Buttons in spec.",
        },
      ),
    ),
    viewId: Type.Optional(
      Type.String({
        description: "Stable ID for updating a view. Letters, numbers, dashes, and underscores only.",
        minLength: 1,
        maxLength: 64,
      }),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("append")], {
        description: "append creates a history entry; replace updates the active view. Default: append.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const UploadAssetsParameters = Type.Object(
  {
    paths: Type.Array(
      Type.String({
        description:
          "Absolute host path, or a path relative to the coding-agent working directory, to a passive web asset.",
        minLength: 1,
        maxLength: 1024,
      }),
      {
        description: `Local files to snapshot. Allowed extensions: ${WUI_SAFE_WEB_ASSET_EXTENSIONS.join(", ")}.`,
        minItems: 1,
        maxItems: 24,
      },
    ),
  },
  { additionalProperties: false },
);

export const ReadStateParameters = Type.Object({
  viewId: Type.Optional(
    Type.String({
      description: "View to inspect. Omit to use the active view.",
      minLength: 1,
      maxLength: 64,
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Optional RFC 6901 JSON Pointer to read, such as /form/name. Omit for complete state.",
    }),
  ),
});

export const UpdateStateParameters = Type.Object({
  viewId: Type.Optional(
    Type.String({
      description: "View to update. Omit to use the active view.",
      minLength: 1,
      maxLength: 64,
    }),
  ),
  operations: Type.Array(
    Type.Object({
      op: Type.Union([Type.Literal("set"), Type.Literal("remove")]),
      path: Type.String({ description: "RFC 6901 JSON Pointer, such as /progress/value." }),
      value: Type.Optional(Type.Unknown({ description: "Required for set; ignored for remove." })),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});

export const EmptyParameters = Type.Object({}, { additionalProperties: false });

export const ComponentDocsParameters = Type.Object(
  {
    components: Type.Array(
      Type.String({
        description: "Exact catalog component name, such as Dialog, Accordion, ToggleGroup, or Carousel.",
        minLength: 1,
        maxLength: 64,
      }),
      {
        description: "One or more components whose exact prop schemas, events, slots, and examples are needed.",
        minItems: 1,
        maxItems: 12,
      },
    ),
  },
  { additionalProperties: false },
);

export const ReadEventsParameters = Type.Object(
  {
    clear: Type.Optional(Type.Boolean({ description: "Remove returned events from the queue. Default: true." })),
  },
  { additionalProperties: false },
);

export const WaitForFeedbackParameters = Type.Object(
  {
    viewId: Type.Optional(
      Type.String({
        description: "Interactive view to wait for. Omit when only one feedback request is pending.",
        minLength: 1,
        maxLength: 64,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WuiParams = Static<typeof WuiParameters>;
export type ComponentDocsParams = Static<typeof ComponentDocsParameters>;
export type UploadAssetsParams = Static<typeof UploadAssetsParameters>;
export type ReadStateParams = Static<typeof ReadStateParameters>;
export type UpdateStateParams = Static<typeof UpdateStateParameters>;
export type ReadEventsParams = Static<typeof ReadEventsParameters>;
export type WaitForFeedbackParams = Static<typeof WaitForFeedbackParameters>;

export const WUI_COMPONENT_DOCS_DESCRIPTION =
  "Return exact JSON prop schemas, events, slots, descriptions, and examples for selected WUI catalog components. Common components are documented in the wui-design guide; use this targeted lookup before using less-common components such as overlays, navigation, carousels, menus, toggles, and button groups.";

export const WUI_TOOL_DESCRIPTION =
  "Create or update one Web UI view from a validated json-render spec, logical asset:// IDs, staged local HTML previews, or any combination. For local images or fonts, prefer wui_upload_assets and use its returned assetId as the exact src in this spec. Assets supplied directly here are copied and resolved atomically before validation. You MUST use a feedback form instead of chat for surveys, intake/discovery questionnaires, explicit form requests, or three or more questions at once. Read the wui-design skill and its catalog reference before composing a catalog view. In mixed views, each html item must target an HtmlPreview elementId.";

export const WUI_UPLOAD_ASSETS_DESCRIPTION = `Snapshot multiple local images or fonts for a later wui call. Returns one opaque assetId per filename; use that assetId as the complete Image or Avatar src in the spec. Sources are never modified. Only passive web formats are accepted: ${WUI_SAFE_WEB_ASSET_EXTENSIONS.join(", ")}.`;

export const WUI_READ_STATE_DESCRIPTION =
  "Read the live json-render state of the active Web UI view, or a value at one JSON Pointer path. Use this only when current browser-side state is needed; wui with feedback is preferred for explicitly requesting user input.";

export const WUI_UPDATE_STATE_DESCRIPTION =
  "Apply set/remove operations to a Web UI view's live json-render state using RFC 6901 JSON Pointer paths. Use this for data, progress, filters, or status updates without resending the full spec; the browser updates immediately.";

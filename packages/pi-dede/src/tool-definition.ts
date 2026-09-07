import { DedeDelegateSchema } from "./schema.ts";

export const DEDE_TOOL_DESCRIPTION = "Run one to three Pi sub-agents. Successful children return a continuation handle; timed-out children may return a resume handle. At most one child per run may have bash/edit/write; writers are serialized across concurrent runs.";

export const DEDE_TOOL_PROMPT_SNIPPET = "Delegate tasks to Pi sub-agents, continue a related finished child, or resume a timed-out child";

// Keep orchestration policy in the on-demand skill, not every system prompt.
// Argument semantics belong in DedeDelegateSchema.
export const DEDE_TOOL_GUIDELINES = [
  "Read the subagents skill before using delegate_to_subagents.",
] as const;

export const DEDE_TOOL_METADATA = {
  name: "delegate_to_subagents",
  label: "Đệ Đệ",
  description: DEDE_TOOL_DESCRIPTION,
  promptSnippet: DEDE_TOOL_PROMPT_SNIPPET,
  promptGuidelines: [...DEDE_TOOL_GUIDELINES],
  parameters: DedeDelegateSchema,
};

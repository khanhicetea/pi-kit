import { DedeDelegateSchema } from "./schema.ts";

export const DEDE_TOOL_DESCRIPTION = "Run one to three bounded Pi sub-agents. Use effort: quick for small isolated tasks. Results include evidence status, usage and a continuation handle on success or resume handle on timeout. Output: 4KiB/child, 12KiB/run. At most one child may have bash/edit/write; writers serialize across calls.";

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

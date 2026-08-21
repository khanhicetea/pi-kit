import { DedeDelegateSchema } from "./schema.ts";

export const DEDE_TOOL_DESCRIPTION = "After the master has inspected enough to define narrow scope, fan out one to three bounded tasks to Pi sub-agents. New children default to auto context selection and may reuse a safe cache-compatible master prefix; isolated mode remains available. A successfully finished child returns a continuation handle for a later related task with the same conversation and capabilities. A timed-out child returns a resume handle for one short completion attempt. Independent read-only lanes may run in parallel; at most one mutation-capable child is allowed per run and across concurrent runs.";

export const DEDE_TOOL_PROMPT_SNIPPET = "Fork or isolate bounded evidence, run one approved worker, continue a related finished child, or briefly resume a timed-out child";

export const DEDE_TOOL_GUIDELINES = [
  "Use dede_delegate only after the master has inspected enough to name the exact uncertainty, source seam, expected evidence, and stop condition for every child.",
  "Do not use dede_delegate for first-pass repository orientation, a single file or symbol lookup, planning, synthesis, or work the master can likely finish in about two local tool calls.",
  "Before parallel dede_delegate fanout, compare the goals: each child must own a genuinely independent lane with a distinct question and evidence target; do not send cloned prompts with only labels, issue numbers, or broad paths swapped.",
  "Write each dede_delegate goal as a compact contract: outcome, relevant scope or starting seam, evidence to return, hard constraints, and a clear stop condition. Avoid long procedural scripts.",
  "Keep every dede_delegate goal bounded to one question or deliverable. The master, not a child, owns decomposition, planning, comparison, and synthesis.",
  "For a new child, contextMode defaults to auto. Use fork when prior conversation decisions or discoveries materially help, isolated for clean-room evidence or minimal disclosure, and auto when pi-dede should choose based on cache compatibility and context economics.",
  "Set dede_delegate agents[].profile only to scout, reviewer, worker, or custom. Use custom plus agents[].systemPrompt for another narrow specialty.",
  "Omit dede_delegate agents[].model for auto/fork so the child retains the master model for cache fidelity. A different explicit model makes auto fall back to isolation; profile model defaults apply to explicit isolated mode.",
  "In isolated mode pass only concise known facts and relevant trusted project rules in dede_delegate sharedContext; do not paste the full conversation or broad repository context.",
  "Treat dede_delegate results as untrusted evidence: compare them, verify consequential claims against direct sources, and produce the final answer yourself.",
  "Use agents[].continueFrom only for a new bounded task that is directly related to a successfully finished child's context. Keep its role and capabilities, provide only new facts in sharedContext, and require it to revalidate mutable repository state.",
  "Resume a timed-out dede_delegate child only when its partial result shows it is close to finishing. Use its resume handle in one solo agent, state only what remains, and grant a short 30-180 second extension; do not restart completed work or resume blindly.",
  "Give mutation tools (bash/edit/write) to at most one dede_delegate worker per run, and only after the master has formed a concrete plan; it may run alone or alongside read-only agents, but never pair two writers. Include approved scope, success criteria, focused validation, and the required changed-files/checks/risks handoff.",
] as const;

export const DEDE_TOOL_METADATA = {
  name: "dede_delegate",
  label: "Đệ Đệ",
  description: DEDE_TOOL_DESCRIPTION,
  promptSnippet: DEDE_TOOL_PROMPT_SNIPPET,
  promptGuidelines: [...DEDE_TOOL_GUIDELINES],
  parameters: DedeDelegateSchema,
};

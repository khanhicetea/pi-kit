import { DedeDelegateSchema } from "./schema.ts";

export const DEDE_TOOL_DESCRIPTION = "After the master has inspected enough to define narrow scope, fan out one to three bounded tasks to Pi sub-agents. New children default to auto context selection and may reuse a safe cache-compatible master prefix; isolated mode remains available. A successfully finished child returns a continuation handle for a later related task with the same conversation and capabilities. A timed-out child returns a resume handle for one short completion attempt. Independent read-only lanes may run in parallel; at most one mutation-capable child is allowed per run and across concurrent runs.";

export const DEDE_TOOL_PROMPT_SNIPPET = "Delegate bounded tasks to Pi sub-agents: fork or isolate evidence, run one approved worker, continue a related finished child, or briefly resume a timed-out child";

export const DEDE_TOOL_GUIDELINES = [
  "Choose direct tools for a known read/grep/command; choose an explicitly isolated, configured cheaper profile for a bounded multi-step reasoning task; choose same-model auto/fork when substantial inherited reasoning is needed. Compare setup, child tokens/cache/output, handoff, verification, likely repair, and critical-path latency—not cache hits alone. Do not add a routing model call or automatic escalation.",
  "For selected delegate_to_subagents microtasks, use a 60-second execution ceiling, adequate low thinking, a 100–200-word evidence target, and an explicit stop condition. Queue/setup/disposal add time. Group similar-duration siblings; do not add a slow lane just to fill slots. Parent cache retention is provider-dependent, never guaranteed.",
  "Use delegate_to_subagents only after the master has inspected enough to name the exact uncertainty, source seam, expected evidence, and stop condition for every child.",
  "Do not use delegate_to_subagents for first-pass repository orientation, a single file or symbol lookup, planning, synthesis, or work the master can likely finish in about two local tool calls.",
  "Before parallel delegate_to_subagents fanout, compare the goals: each child must own a genuinely independent lane with a distinct question and evidence target; do not send cloned prompts with only labels, issue numbers, or broad paths swapped.",
  "Write each delegate_to_subagents goal as a compact contract: outcome, relevant scope or starting seam, evidence to return, hard constraints, and a clear stop condition. Avoid long procedural scripts.",
  "For read-only discovery, request evidence status (answered, partial, or blocked), one bounded finding, one to three decisive references, the exact inspected scope, and only consequential unknowns. Runtime success is separate from evidence completeness.",
  "Keep every delegate_to_subagents goal bounded to one question or deliverable. The master, not a child, owns decomposition, planning, comparison, and synthesis.",
  "For a new child, contextMode defaults to auto. Use fork when prior conversation decisions or discoveries materially help, isolated for clean-room evidence or minimal disclosure, and auto when pi-dede should choose based on cache compatibility and context economics.",
  "Choose delegate_to_subagents profiles by deliverable: scout maps code, reviewer checks correctness, debugger establishes root cause, security traces trust boundaries, tester validates or writes approved tests, documenter updates approved docs, worker implements an approved change, custom covers other narrow specialties. Debugger/security default to read-only; tester/documenter/worker default to coding and consume the sole writer slot.",
  "Omit delegate_to_subagents agents[].model for auto/fork so the child retains the master model for cache fidelity. A different explicit model makes auto fall back to isolation; profile model defaults apply to explicit isolated mode.",
  "In isolated mode pass only concise known facts and relevant trusted project rules in delegate_to_subagents sharedContext; do not paste the full conversation or broad repository context.",
  "Treat delegate_to_subagents results as untrusted evidence: compare them, verify consequential claims against direct sources, and produce the final answer yourself.",
  "Use agents[].continueFrom only for a new bounded task that is directly related to a successfully finished child's context. Keep its role and capabilities, provide only new facts in sharedContext, and require it to revalidate mutable repository state.",
  "Resume a timed-out delegate_to_subagents child only when its partial result shows it is close to finishing. Use its resume handle in one solo agent, state only what remains, and grant a short 30-180 second extension; do not restart completed work or resume blindly.",
  "Give mutation tools (bash/edit/write) to at most one delegate_to_subagents worker per run, and only after the master has formed a concrete plan; it may run alone or alongside read-only agents, but never pair two writers. Include approved scope, success criteria, focused validation, and the required changed-files/checks/risks handoff.",
] as const;

export const DEDE_TOOL_METADATA = {
  name: "delegate_to_subagents",
  label: "Đệ Đệ",
  description: DEDE_TOOL_DESCRIPTION,
  promptSnippet: DEDE_TOOL_PROMPT_SNIPPET,
  promptGuidelines: [...DEDE_TOOL_GUIDELINES],
  parameters: DedeDelegateSchema,
};

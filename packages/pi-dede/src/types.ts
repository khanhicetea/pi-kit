import type { Usage } from "@earendil-works/pi-ai";

export const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const PROFILES = ["scout", "reviewer", "worker", "custom"] as const;
export const TOOL_PRESETS = ["read-only", "coding", "none", "custom"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CONTEXT_MODES = ["auto", "fork", "isolated"] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export type DedeProfile = (typeof PROFILES)[number];
export type ToolPreset = (typeof TOOL_PRESETS)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ContextMode = (typeof CONTEXT_MODES)[number];
export type ResolvedContextMode = Exclude<ContextMode, "auto">;
export type ChildStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export interface ProfileDefault {
  model?: string;
  thinking?: ThinkingLevel;
  env?: Record<string, string>;
  additionalArgs?: string[];
}

export type ProfileDefaults = Partial<Record<DedeProfile, ProfileDefault>>;

export interface DedeAgentRequest {
  id: string;
  profile?: DedeProfile;
  goal: string;
  /** Reuse a safe master-conversation prefix, remain isolated, or let pi-dede decide. */
  contextMode?: ContextMode;
  /** Continue a successfully finished related child lineage with a new bounded task. */
  continueFrom?: string;
  /** Finish the remaining work of a timed-out child with a short extension. */
  resume?: string;
  systemPrompt?: string;
  toolPreset?: ToolPreset;
  tools?: BuiltinTool[];
  model?: string;
  thinking?: ThinkingLevel;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface DedeDelegateParams {
  objective: string;
  sharedContext?: string;
  agents: DedeAgentRequest[];
  timeoutSeconds?: number;
}

export interface ResumeReference {
  handle: string;
  sessionId: string;
  attempt: number;
  continuationIndex: number;
}

export interface ContinuationReference {
  handle: string;
  sessionId: string;
  continuationIndex: number;
}

export interface ResolvedAgent {
  id: string;
  profile: DedeProfile;
  goal: string;
  contextMode: ContextMode;
  resolvedContextMode: ResolvedContextMode;
  contextFallbackReason?: string;
  /** Exact master-visible tools retained in fork mode for prompt-cache fidelity. */
  visibleTools?: string[];
  /** Exact effective master system prompt retained in fork mode. */
  inheritedSystemPrompt?: string;
  /** Provider cache-affinity key retained across a forked child lineage. */
  cacheAffinityKey?: string;
  forkedFrom?: {
    sessionId: string;
    entryId: string;
    contextTokens?: number;
  };
  continueFrom?: ContinuationReference;
  resume?: ResumeReference;
  systemPrompt?: string;
  toolPreset: ToolPreset;
  tools: BuiltinTool[];
  additionalArgs: string[];
  model: string;
  thinking: ThinkingLevel;
  env: Record<string, string>;
  timeoutSeconds: number;
  mutationCapable: boolean;
}

export interface ChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
  turns: number;
}

export interface DedeActivity {
  type: "tool" | "status";
  text: string;
}

export interface DedeChildResult {
  id: string;
  profile: DedeProfile;
  goal: string;
  contextModeRequested?: ContextMode;
  contextModeResolved?: ResolvedContextMode;
  contextFallbackReason?: string;
  forkedFrom?: {
    sessionId: string;
    entryId: string;
    contextTokens?: number;
  };
  cacheHitRatio?: number;
  timeToFirstEventMs?: number;
  status: ChildStatus;
  model: string;
  thinking: ThinkingLevel;
  tools: BuiltinTool[];
  timeoutSeconds: number;
  /** Persistent Pi session ID; inspect later with `pi --session <id>`. */
  sessionId?: string;
  continuedFrom?: string;
  continuationIndex?: number;
  continuationHandle?: string;
  resumedFrom?: string;
  resumeHandle?: string;
  finalText: string;
  durationMs: number;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  stderrTail?: string;
  artifactPath?: string;
  usage: ChildUsage;
  activity: DedeActivity[];
}

export interface DedeToolDetails {
  version: 2;
  runId: string;
  status: "succeeded" | "partial" | "failed" | "cancelled";
  startedAt: number;
  durationMs: number;
  results: DedeChildResult[];
}

export interface DetailedUsage extends Usage {
  cost: Usage["cost"];
}

export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

export interface ChildLineageSource {
  handle: string;
  sessionId: string;
  attempt: number;
  continuationIndex: number;
  agent: ResolvedAgent;
}

export interface ValidationContext {
  model?: ModelLike;
  models: ModelLike[];
  extensionProviderIds?: readonly string[];
  additionalArgs?: readonly string[];
  profileDefaults?: ProfileDefaults;
  continuationLookup?: (handle: string) => ChildLineageSource | undefined;
  resumeLookup?: (handle: string) => ChildLineageSource | undefined;
}

import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

export const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const PROFILES = ["scout", "planner", "reviewer", "worker", "custom"] as const;
export const TOOL_PRESETS = ["read-only", "coding", "none", "custom"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEPENDENCY_CONTEXT_MODES = ["full", "summary"] as const;

export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export type DedeProfile = (typeof PROFILES)[number];
export type ToolPreset = (typeof TOOL_PRESETS)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type DependencyContextMode = (typeof DEPENDENCY_CONTEXT_MODES)[number];
export type ChildStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export interface DependencyContextPolicy {
  mode: DependencyContextMode;
  maxBytes: number;
}

export interface ProfileDefault {
  model?: string;
  thinking?: ThinkingLevel;
}

export type ProfileDefaults = Partial<Record<DedeProfile, ProfileDefault>>;

export interface DedeAgentRequest {
  id: string;
  profile?: DedeProfile;
  goal: string;
  dependsOn?: string[];
  systemPrompt?: string;
  toolPreset?: ToolPreset;
  tools?: BuiltinTool[];
  model?: string;
  thinking?: ThinkingLevel;
  timeoutSeconds?: number;
  dependencyContext?: DependencyContextPolicy;
}

export interface DedeDelegateParams {
  objective: string;
  sharedContext?: string;
  agents: DedeAgentRequest[];
  timeoutSeconds?: number;
}

export interface ResolvedAgent {
  id: string;
  profile: DedeProfile;
  goal: string;
  dependsOn: string[];
  systemPrompt?: string;
  toolPreset: ToolPreset;
  tools: BuiltinTool[];
  model: string;
  thinking: ThinkingLevel;
  timeoutSeconds: number;
  dependencyContext?: DependencyContextPolicy;
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
  dependsOn: string[];
  status: ChildStatus;
  model: string;
  thinking: ThinkingLevel;
  tools: BuiltinTool[];
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
  version: 1;
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

export interface ValidationContext {
  model?: ModelLike;
  thinkingLevel: ModelThinkingLevel;
  models: ModelLike[];
  extensionProviderIds?: readonly string[];
  profileDefaults?: ProfileDefaults;
}

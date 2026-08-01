import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  BUILTIN_TOOLS,
  DEPENDENCY_CONTEXT_MODES,
  PROFILES,
  THINKING_LEVELS,
  TOOL_PRESETS,
  type BuiltinTool,
  type DedeDelegateParams,
  type ModelLike,
  type ResolvedAgent,
  type ToolPreset,
  type ValidationContext,
} from "./types.ts";

const AgentSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    profile: Type.Optional(StringEnum(PROFILES, {
      description: "Built-in role only: scout, planner, reviewer, worker, or custom. For any other specialist role, use custom and describe it in systemPrompt; never invent a profile name.",
    })),
    goal: Type.String({ minLength: 1 }),
    dependsOn: Type.Optional(Type.Array(
      Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]{0,31}$" }),
      { maxItems: 4 },
    )),
    systemPrompt: Type.Optional(Type.String()),
    toolPreset: Type.Optional(StringEnum(TOOL_PRESETS)),
    tools: Type.Optional(Type.Array(StringEnum(BUILTIN_TOOLS), { maxItems: 7 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600 })),
    dependencyContext: Type.Optional(Type.Object(
      {
        mode: StringEnum(DEPENDENCY_CONTEXT_MODES),
        maxBytes: Type.Integer({ minimum: 4096, maximum: 262144 }),
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

export const DedeDelegateSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1 }),
    sharedContext: Type.Optional(Type.String()),
    agents: Type.Array(AgentSchema, { minItems: 1, maxItems: 5 }),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1800, maximum: 3600 })),
  },
  { additionalProperties: false },
);

export type DedeDelegateInput = Static<typeof DedeDelegateSchema>;

const PRESET_TOOLS: Record<Exclude<ToolPreset, "custom">, BuiltinTool[]> = {
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  none: [],
};

const PROFILE_DEFAULT_PRESET = {
  scout: "read-only",
  planner: "read-only",
  reviewer: "read-only",
  worker: "coding",
  custom: "read-only",
} as const;

const MUTATION_TOOLS = new Set<BuiltinTool>(["bash", "edit", "write"]);
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function assertByteLimit(label: string, value: string | undefined, max: number): void {
  if (value !== undefined && bytes(value) > max) {
    throw new Error(`${label} exceeds ${max} UTF-8 bytes`);
  }
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function preferModel(matches: ModelLike[]): ModelLike | undefined {
  if (matches.length === 0) return undefined;
  return [...matches].sort((a, b) => {
    const aDated = /-\d{8}$/.test(a.id);
    const bDated = /-\d{8}$/.test(b.id);
    if (aDated !== bDated) return aDated ? 1 : -1;
    return b.id.localeCompare(a.id);
  })[0];
}

/** Resolve with Pi CLI-like exact, glob, then partial matching. */
export function resolveModelPattern(pattern: string, models: ModelLike[]): ModelLike | undefined {
  const input = pattern.trim();
  const lower = input.toLowerCase();
  const canonical = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
  if (canonical.length === 1) return canonical[0];

  const providers = new Map(models.map((model) => [model.provider.toLowerCase(), model.provider]));
  const slash = input.indexOf("/");
  let candidates = models;
  let modelPattern = input;
  if (slash > 0) {
    const provider = providers.get(input.slice(0, slash).toLowerCase());
    if (provider) {
      candidates = models.filter((model) => model.provider === provider);
      modelPattern = input.slice(slash + 1);
    }
  }

  const exact = candidates.filter((model) => model.id.toLowerCase() === modelPattern.toLowerCase());
  if (exact.length === 1) return exact[0];

  if (/[*?]/.test(modelPattern)) {
    const regex = wildcardRegex(modelPattern);
    return preferModel(candidates.filter((model) => regex.test(model.id) || regex.test(model.name ?? "")));
  }

  const needle = modelPattern.toLowerCase();
  return preferModel(candidates.filter((model) => model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle)));
}

export function validateAndResolve(input: DedeDelegateParams, context: ValidationContext): ResolvedAgent[] {
  if (Number(process.env.PI_DEDE_DEPTH ?? "0") !== 0) {
    throw new Error("Recursive delegation is disabled (PI_DEDE_DEPTH is non-zero)");
  }

  assertByteLimit("objective", input.objective, 12 * 1024);
  assertByteLimit("sharedContext", input.sharedContext, 48 * 1024);

  if (input.agents.length < 1 || input.agents.length > 5) {
    throw new Error("agents must contain one to five items");
  }
  if (input.timeoutSeconds !== undefined && (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1800 || input.timeoutSeconds > 3600)) {
    throw new Error("timeoutSeconds must be an integer from 1800 to 3600");
  }

  const ids = new Set<string>();
  for (const [index, agent] of input.agents.entries()) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(agent.id)) throw new Error(`agents[${index}].id is invalid`);
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }

  const extensionProviders = new Set(context.extensionProviderIds ?? []);
  const resolved = input.agents.map((agent, index): ResolvedAgent => {
    const label = `agents[${index}]`;
    const dependsOn = [...(agent.dependsOn ?? [])];
    if (dependsOn.length > 4) throw new Error(`${label}.dependsOn must contain at most four items`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`${label}.dependsOn contains duplicates`);
    for (const dependencyId of dependsOn) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(dependencyId)) throw new Error(`${label}.dependsOn contains an invalid agent id`);
      if (dependencyId === agent.id) throw new Error(`${label}.dependsOn cannot include itself`);
      if (!ids.has(dependencyId)) throw new Error(`${label}.dependsOn references unknown agent: ${dependencyId}`);
    }

    assertByteLimit(`${label}.goal`, agent.goal, 12 * 1024);
    assertByteLimit(`${label}.systemPrompt`, agent.systemPrompt, 32 * 1024);
    if (agent.timeoutSeconds !== undefined && (!Number.isInteger(agent.timeoutSeconds) || agent.timeoutSeconds < 30 || agent.timeoutSeconds > 3600)) {
      throw new Error(`${label}.timeoutSeconds must be an integer from 30 to 3600`);
    }
    if (agent.dependencyContext !== undefined) {
      const unknownKeys = Object.keys(agent.dependencyContext).filter((key) => key !== "mode" && key !== "maxBytes");
      if (unknownKeys.length > 0) {
        throw new Error(`${label}.dependencyContext contains unsupported properties: ${unknownKeys.join(", ")}`);
      }
      if (!(DEPENDENCY_CONTEXT_MODES as readonly string[]).includes(agent.dependencyContext.mode)) {
        throw new Error(`${label}.dependencyContext.mode must be full or summary`);
      }
      if (!Number.isInteger(agent.dependencyContext.maxBytes) || agent.dependencyContext.maxBytes < 4096 || agent.dependencyContext.maxBytes > 262144) {
        throw new Error(`${label}.dependencyContext.maxBytes must be an integer from 4096 to 262144`);
      }
    }

    const profile = agent.profile ?? "custom";
    const toolPreset = agent.toolPreset ?? PROFILE_DEFAULT_PRESET[profile];
    if (toolPreset === "custom" && agent.tools === undefined) {
      throw new Error(`${label}.tools is required when toolPreset is custom`);
    }
    if (toolPreset !== "custom" && agent.tools !== undefined) {
      throw new Error(`${label}.tools is allowed only when toolPreset is custom`);
    }
    const tools = toolPreset === "custom" ? [...(agent.tools ?? [])] : [...PRESET_TOOLS[toolPreset]];
    if (new Set(tools).size !== tools.length) throw new Error(`${label}.tools contains duplicates`);
    for (const tool of tools) {
      if (!(BUILTIN_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unsupported child tool: ${tool}`);
    }

    const profileDefaults = context.profileDefaults?.[profile];
    const modelPattern = agent.model ?? profileDefaults?.model;
    const model = modelPattern ? resolveModelPattern(modelPattern, context.models) : context.model;
    if (!model) throw new Error(`Could not resolve model for agent ${agent.id}${modelPattern ? `: ${modelPattern}` : ""}`);
    if (extensionProviders.has(model.provider)) {
      throw new Error(`Model provider ${model.provider} is registered by an extension and is unavailable to isolated children`);
    }

    return {
      id: agent.id,
      profile,
      goal: agent.goal,
      dependsOn,
      systemPrompt: agent.systemPrompt,
      toolPreset,
      tools,
      model: `${model.provider}/${model.id}`,
      thinking: agent.thinking ?? profileDefaults?.thinking ?? context.thinkingLevel,
      timeoutSeconds: agent.timeoutSeconds ?? input.timeoutSeconds ?? 1800,
      ...(agent.dependencyContext ? {
        dependencyContext: {
          mode: agent.dependencyContext.mode,
          maxBytes: agent.dependencyContext.maxBytes,
        },
      } : {}),
      mutationCapable: tools.some((tool) => MUTATION_TOOLS.has(tool)),
    };
  });

  const remainingDependencies = new Map(resolved.map((agent) => [agent.id, agent.dependsOn.length]));
  const dependents = new Map(resolved.map((agent) => [agent.id, [] as string[]]));
  for (const agent of resolved) {
    for (const dependencyId of agent.dependsOn) dependents.get(dependencyId)!.push(agent.id);
  }
  const ready = resolved.filter((agent) => agent.dependsOn.length === 0).map((agent) => agent.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited++;
    for (const dependentId of dependents.get(id)!) {
      const remaining = remainingDependencies.get(dependentId)! - 1;
      remainingDependencies.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }
  if (visited !== resolved.length) throw new Error("Agent dependencies must not contain a cycle");

  if (resolved.length > 1 && resolved.some((agent) => agent.mutationCapable)) {
    throw new Error("Mutation-capable agents must run alone; multi-agent runs must be entirely read-only");
  }
  return resolved;
}

export function isMutationCapable(tools: readonly BuiltinTool[]): boolean {
  return tools.some((tool) => MUTATION_TOOLS.has(tool));
}

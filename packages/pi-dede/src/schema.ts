import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  CHILD_ENV_NAME_PATTERN,
  MAX_CHILD_ENV_VARIABLES,
  MAX_CHILD_ENV_VALUE_BYTES,
  mergeChildEnv,
  validateChildEnv,
} from "./env.ts";
import {
  BUILTIN_TOOLS,
  CONTEXT_MODES,
  PROFILES,
  THINKING_LEVELS,
  TOOL_PRESETS,
  type BuiltinTool,
  type DedeDelegateParams,
  type DedeProfile,
  type ModelLike,
  type ResolvedAgent,
  type ThinkingLevel,
  type ToolPreset,
  type ValidationContext,
} from "./types.ts";

export const DEFAULT_CHILD_TIMEOUT_SECONDS = 180;
export const DEFAULT_RESUME_TIMEOUT_SECONDS = 60;
export const MIN_CHILD_TIMEOUT_SECONDS = 30;
export const MAX_CHILD_TIMEOUT_SECONDS = 1800;
export const MAX_RESUME_TIMEOUT_SECONDS = 180;
export const MAX_AGENTS_PER_RUN = 3;

const AgentSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    profile: Type.Optional(StringEnum(PROFILES, {
      description: "Built-in role only: scout, reviewer, worker, or custom. For another narrow specialty, use custom plus systemPrompt.",
    })),
    goal: Type.String({
      minLength: 1,
      description: "One bounded question or deliverable. For a continuation, give one related new task; for a resume, state only what remains.",
    }),
    contextMode: Type.Optional(StringEnum(CONTEXT_MODES, {
      description: "How a new child gets conversation context: auto (default) lets pi-dede reuse a safe master prefix when cache-compatible, fork requires it, and isolated starts clean. Forbidden on continue/resume.",
    })),
    continueFrom: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 128,
      description: "Continuation handle from a successfully finished child. Reuses its session and immutable capabilities for a related new bounded task.",
    })),
    resume: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 128,
      description: "Resume handle from a timed-out child. Resume calls must contain one agent and may override only id, goal, and timeoutSeconds.",
    })),
    systemPrompt: Type.Optional(Type.String({
      description: "Additional role constraints for a narrow custom specialty; project rules belong in sharedContext.",
    })),
    toolPreset: Type.Optional(StringEnum(TOOL_PRESETS, {
      description: "Named tool set: read-only (default for scout/reviewer/custom), coding (default for worker), or none. Omit and set tools for an exact custom set.",
    })),
    tools: Type.Optional(Type.Array(StringEnum(BUILTIN_TOOLS), {
      maxItems: 7,
      description: "Exact child tool list; selects the custom preset directly, so toolPreset may be omitted.",
    })),
    model: Type.Optional(Type.String({
      minLength: 1,
      description: "Omit to inherit the configured profile default (profiles.<profile>.model), falling back to the master's current model when no profile config is set. Set only to intentionally override with a specific model.",
    })),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    env: Type.Optional(Type.Record(
      Type.String({ pattern: CHILD_ENV_NAME_PATTERN }),
      Type.String({ maxLength: MAX_CHILD_ENV_VALUE_BYTES }),
      {
        maxProperties: MAX_CHILD_ENV_VARIABLES,
        description: "Environment overrides for this child. Values are stored in the master transcript; avoid secrets and prefer inherited environment when possible.",
      },
    )),
    timeoutSeconds: Type.Optional(Type.Integer({
      minimum: MIN_CHILD_TIMEOUT_SECONDS,
      maximum: MAX_CHILD_TIMEOUT_SECONDS,
      description: "Use only when this child needs a deadline different from the run default.",
    })),
  },
  { additionalProperties: false },
);

export const DedeDelegateSchema = Type.Object(
  {
    objective: Type.String({
      minLength: 1,
      description: "The decision or outcome the master will own after comparing the delegated evidence.",
    }),
    sharedContext: Type.Optional(Type.String({
      description: "Concise known facts and relevant trusted project rules. Do not paste the full conversation or broad repository context.",
    })),
    agents: Type.Array(AgentSchema, { minItems: 1, maxItems: MAX_AGENTS_PER_RUN }),
    timeoutSeconds: Type.Optional(Type.Integer({
      minimum: MIN_CHILD_TIMEOUT_SECONDS,
      maximum: MAX_CHILD_TIMEOUT_SECONDS,
      description: `Run default in seconds; defaults to ${DEFAULT_CHILD_TIMEOUT_SECONDS}.`,
    })),
  },
  { additionalProperties: false },
);

export type DedeDelegateInput = Static<typeof DedeDelegateSchema>;

const PRESET_TOOLS: Record<Exclude<ToolPreset, "custom">, BuiltinTool[]> = {
  "read-only": ["read", "grep", "find", "ls"],
  coding: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  none: [],
};

const PROFILE_DEFAULT_PRESET: Record<DedeProfile, Exclude<ToolPreset, "custom">> = {
  scout: "read-only",
  reviewer: "read-only",
  worker: "coding",
  custom: "read-only",
};

const PROFILE_DEFAULT_THINKING: Record<DedeProfile, ThinkingLevel> = {
  scout: "low",
  reviewer: "medium",
  worker: "medium",
  custom: "low",
};

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

/**
 * Resolve with Pi CLI-like matching. A bare name allows exact, glob, then partial
 * fallback for convenience. A provider-scoped `provider/id` must match exactly (or
 * via an explicit glob) so the model handed to a subagent is exactly the one requested.
 */
export function resolveModelPattern(pattern: string, models: ModelLike[]): ModelLike | undefined {
  const input = pattern.trim();
  const lower = input.toLowerCase();
  const canonical = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === lower);
  if (canonical.length === 1) return canonical[0];

  const providers = new Map(models.map((model) => [model.provider.toLowerCase(), model.provider]));
  const slash = input.indexOf("/");
  let candidates = models;
  let modelPattern = input;
  let providerScoped = false;
  if (slash > 0) {
    const provider = providers.get(input.slice(0, slash).toLowerCase());
    if (provider) {
      candidates = models.filter((model) => model.provider === provider);
      modelPattern = input.slice(slash + 1);
      providerScoped = true;
    }
  }

  const exact = candidates.filter((model) => model.id.toLowerCase() === modelPattern.toLowerCase());
  if (exact.length === 1) return exact[0];

  if (/[*?]/.test(modelPattern)) {
    const regex = wildcardRegex(modelPattern);
    return preferModel(candidates.filter((model) => regex.test(model.id) || regex.test(model.name ?? "")));
  }

  // A named provider pins the catalog entry; do not fall back to a partial substring
  // match, which could pass a different model to the subagent than the one requested.
  if (providerScoped) return undefined;

  const needle = modelPattern.toLowerCase();
  return preferModel(candidates.filter((model) => model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle)));
}

function explicitlyLoadsChildExtension(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="));
}

function disablesChildExtensionDiscovery(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--no-extensions");
}

function compatibleModelHint(models: readonly ModelLike[], extensionProviders: ReadonlySet<string>): string {
  const candidates = models
    .filter((model) => !extensionProviders.has(model.provider))
    .slice(0, 5)
    .map((model) => `${model.provider}/${model.id}`);
  return candidates.length > 0 ? ` Catalog candidates include: ${candidates.join(", ")}.` : "";
}

export function validateAndResolve(input: DedeDelegateParams, context: ValidationContext): ResolvedAgent[] {
  if (Number(process.env.PI_DEDE_DEPTH ?? "0") !== 0) {
    throw new Error("Recursive delegation is disabled (PI_DEDE_DEPTH is non-zero)");
  }

  assertByteLimit("objective", input.objective, 4 * 1024);
  assertByteLimit("sharedContext", input.sharedContext, 16 * 1024);

  if (input.agents.length < 1 || input.agents.length > MAX_AGENTS_PER_RUN) {
    throw new Error(`agents must contain one to ${MAX_AGENTS_PER_RUN} items`);
  }
  if (input.timeoutSeconds !== undefined && (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < MIN_CHILD_TIMEOUT_SECONDS ||
    input.timeoutSeconds > MAX_CHILD_TIMEOUT_SECONDS
  )) {
    throw new Error(`timeoutSeconds must be an integer from ${MIN_CHILD_TIMEOUT_SECONDS} to ${MAX_CHILD_TIMEOUT_SECONDS}`);
  }

  const resumeRequests = input.agents.filter((agent) => agent.resume !== undefined);
  if (resumeRequests.length > 0 && input.agents.length !== 1) {
    throw new Error("A timed-out child resume must run alone");
  }

  const lineageHandles = new Set<string>();
  for (const [index, agent] of input.agents.entries()) {
    if (agent.resume !== undefined && agent.continueFrom !== undefined) {
      throw new Error(`agents[${index}] cannot set both resume and continueFrom`);
    }
    const handle = agent.resume ?? agent.continueFrom;
    if (handle !== undefined) {
      if (lineageHandles.has(handle)) throw new Error(`Child lineage handle may appear only once per delegation: ${handle}`);
      lineageHandles.add(handle);
    }
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
    assertByteLimit(`${label}.goal`, agent.goal, 4 * 1024);
    assertByteLimit(`${label}.systemPrompt`, agent.systemPrompt, 8 * 1024);
    if (agent.timeoutSeconds !== undefined && (
      !Number.isInteger(agent.timeoutSeconds) ||
      agent.timeoutSeconds < MIN_CHILD_TIMEOUT_SECONDS ||
      agent.timeoutSeconds > MAX_CHILD_TIMEOUT_SECONDS
    )) {
      throw new Error(`${label}.timeoutSeconds must be an integer from ${MIN_CHILD_TIMEOUT_SECONDS} to ${MAX_CHILD_TIMEOUT_SECONDS}`);
    }

    if (agent.resume !== undefined || agent.continueFrom !== undefined) {
      const mode = agent.resume !== undefined ? "resume" : "continue";
      const handle = agent.resume ?? agent.continueFrom!;
      const unsupported = ["profile", "contextMode", "systemPrompt", "toolPreset", "tools", "model", "thinking", "env"]
        .filter((key) => agent[key as keyof typeof agent] !== undefined);
      if (unsupported.length > 0) {
        throw new Error(`${label} cannot override ${unsupported.join(", ")} when ${mode === "resume" ? "resuming" : "continuing"}; the old child keeps its profile, system instructions, model, thinking, environment overrides, and tools`);
      }
      const source = mode === "resume"
        ? context.resumeLookup?.(handle)
        : context.continuationLookup?.(handle);
      if (!source) {
        throw new Error(`${mode === "resume" ? "Resume" : "Continuation"} handle is unavailable, expired, or already in use: ${handle}`);
      }
      const timeoutSeconds = agent.timeoutSeconds ?? input.timeoutSeconds
        ?? (mode === "resume" ? DEFAULT_RESUME_TIMEOUT_SECONDS : DEFAULT_CHILD_TIMEOUT_SECONDS);
      if (mode === "resume" && timeoutSeconds > MAX_RESUME_TIMEOUT_SECONDS) {
        throw new Error(`Resumed children are short extensions and timeoutSeconds must not exceed ${MAX_RESUME_TIMEOUT_SECONDS}`);
      }
      return {
        ...source.agent,
        id: agent.id,
        goal: agent.goal,
        tools: [...source.agent.tools],
        visibleTools: source.agent.visibleTools ? [...source.agent.visibleTools] : undefined,
        env: { ...source.agent.env },
        timeoutSeconds,
        continueFrom: mode === "continue" ? {
          handle: source.handle,
          sessionId: source.sessionId,
          continuationIndex: source.continuationIndex + 1,
        } : undefined,
        resume: mode === "resume" ? {
          handle: source.handle,
          sessionId: source.sessionId,
          attempt: source.attempt,
          continuationIndex: source.continuationIndex,
        } : undefined,
      };
    }

    const profile = agent.profile ?? "custom";
    // Providing an explicit `tools` list selects the custom preset directly; no
    // separate toolPreset is required. Omitting `tools` uses the named preset.
    const toolPreset: ToolPreset = agent.tools !== undefined
      ? "custom"
      : (agent.toolPreset ?? PROFILE_DEFAULT_PRESET[profile]);
    if (toolPreset === "custom" && agent.tools === undefined) {
      throw new Error(`${label}.tools is required when toolPreset is custom`);
    }
    const tools = toolPreset === "custom" ? [...(agent.tools ?? [])] : [...PRESET_TOOLS[toolPreset]];
    if (new Set(tools).size !== tools.length) throw new Error(`${label}.tools contains duplicates`);
    for (const tool of tools) {
      if (!(BUILTIN_TOOLS as readonly string[]).includes(tool)) throw new Error(`Unsupported child tool: ${tool}`);
    }

    const profileDefaults = context.profileDefaults?.[profile];
    const additionalArgs = profileDefaults?.additionalArgs ?? context.additionalArgs ?? [];
    const configuredEnv = profileDefaults?.env === undefined
      ? {}
      : validateChildEnv(profileDefaults.env, `profiles.${profile}.env`);
    const requestEnv = agent.env === undefined ? {} : validateChildEnv(agent.env, `${label}.env`);
    const env = validateChildEnv(mergeChildEnv([configuredEnv, requestEnv]), `${label}.effectiveEnv`);
    // Auto/fork are cache-first: unless the caller explicitly selects a model,
    // retain the master's exact model. Profile model defaults apply to an
    // explicitly isolated child, where cache-prefix fidelity is not expected.
    const modelPattern = agent.model ?? (agent.contextMode === "isolated" ? profileDefaults?.model : undefined);
    const model = modelPattern ? resolveModelPattern(modelPattern, context.models) : context.model;
    if (!model) throw new Error(`Could not resolve model for agent ${agent.id}${modelPattern ? `: ${modelPattern}` : ""}`);
    if (
      extensionProviders.has(model.provider) &&
      disablesChildExtensionDiscovery(additionalArgs) &&
      !explicitlyLoadsChildExtension(additionalArgs)
    ) {
      throw new Error(
        `Model provider ${model.provider} is registered by an extension, but child extension discovery is disabled. ` +
        `Remove "--no-extensions" or explicitly load the provider with additionalArgs: ["-e", "/absolute/path/to/extension.ts"].` +
        compatibleModelHint(context.models, extensionProviders),
      );
    }

    return {
      id: agent.id,
      profile,
      goal: agent.goal,
      contextMode: agent.contextMode ?? "auto",
      resolvedContextMode: "isolated",
      systemPrompt: agent.systemPrompt,
      toolPreset,
      tools,
      additionalArgs: [...additionalArgs],
      model: `${model.provider}/${model.id}`,
      thinking: agent.thinking ?? profileDefaults?.thinking ?? PROFILE_DEFAULT_THINKING[profile],
      env,
      timeoutSeconds: agent.timeoutSeconds ?? input.timeoutSeconds ?? DEFAULT_CHILD_TIMEOUT_SECONDS,
      mutationCapable: tools.some((tool) => MUTATION_TOOLS.has(tool)),
    };
  });

  // A single mutation-capable worker may run alongside read-only agents, but two
  // concurrent writers can clobber one another's edits, so cap it at one per run.
  const mutationCount = resolved.filter((agent) => agent.mutationCapable).length;
  if (mutationCount > 1) {
    throw new Error("At most one mutation-capable agent per run; the others must be read-only");
  }
  return resolved;
}

export function isMutationCapable(tools: readonly BuiltinTool[]): boolean {
  return tools.some((tool) => MUTATION_TOOLS.has(tool));
}

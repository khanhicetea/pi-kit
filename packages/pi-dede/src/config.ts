import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { mergeChildEnv, validateChildEnv } from "./env.ts";
import { PROFILES, THINKING_LEVELS, type ProfileDefaults, type ThinkingLevel } from "./types.ts";

const CONFIG_FILE_NAME = "pi-dede.json";
const MAX_CONFIG_BYTES = 64 * 1024;

export interface DedeConfig {
  profiles: ProfileDefaults;
  additionalArgs: string[];
}

interface DedeConfigFile {
  profiles?: ProfileDefaults;
  additionalArgs?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function parseConfig(content: string, path: string): DedeConfigFile {
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`${path} exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Could not parse ${path}: invalid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  assertKnownKeys(parsed, ["profiles", "additionalArgs"], path);
  if (parsed.additionalArgs !== undefined) {
    if (!Array.isArray(parsed.additionalArgs)) throw new Error(`${path}.additionalArgs must be an array`);
    for (const [index, arg] of parsed.additionalArgs.entries()) {
      if (typeof arg !== "string") throw new Error(`${path}.additionalArgs[${index}] must be a string`);
    }
  }
  if (parsed.profiles === undefined) {
    return { ...(parsed.additionalArgs !== undefined ? { additionalArgs: [...parsed.additionalArgs] } : {}) };
  }
  if (!isRecord(parsed.profiles)) throw new Error(`${path}.profiles must be an object`);
  assertKnownKeys(parsed.profiles, PROFILES, `${path}.profiles`);

  const profiles: ProfileDefaults = {};
  for (const profile of PROFILES) {
    const value = parsed.profiles[profile];
    if (value === undefined) continue;
    if (!isRecord(value)) throw new Error(`${path}.profiles.${profile} must be an object`);
    assertKnownKeys(value, ["model", "thinking", "env"], `${path}.profiles.${profile}`);

    if (value.model !== undefined && (typeof value.model !== "string" || value.model.trim().length === 0)) {
      throw new Error(`${path}.profiles.${profile}.model must be a non-empty string`);
    }
    if (value.thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) {
      throw new Error(`${path}.profiles.${profile}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }

    const env = value.env === undefined
      ? undefined
      : validateChildEnv(value.env, `${path}.profiles.${profile}.env`);
    profiles[profile] = {
      ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
      ...(value.thinking !== undefined ? { thinking: value.thinking as ThinkingLevel } : {}),
      ...(env !== undefined ? { env } : {}),
    };
  }
  return {
    profiles,
    ...(parsed.additionalArgs !== undefined ? { additionalArgs: [...parsed.additionalArgs] } : {}),
  };
}

async function readConfig(path: string): Promise<DedeConfigFile> {
  try {
    return parseConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function mergeProfileDefaults(globalDefaults: ProfileDefaults = {}, projectDefaults: ProfileDefaults = {}): ProfileDefaults {
  const merged: ProfileDefaults = {};
  for (const profile of PROFILES) {
    const globalValue = globalDefaults[profile];
    const projectValue = projectDefaults[profile];
    const env = mergeChildEnv([globalValue?.env, projectValue?.env]);
    const value = {
      ...globalValue,
      ...projectValue,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    if (value.model !== undefined || value.thinking !== undefined || value.env !== undefined) merged[profile] = value;
  }
  return merged;
}

export function getDedeConfigPaths(cwd: string): { global: string; project: string } {
  return {
    global: join(getAgentDir(), CONFIG_FILE_NAME),
    project: join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
  };
}

/** Load global configuration and, for trusted projects only, field-level project overrides. */
export async function loadDedeConfig(cwd: string, projectTrusted: boolean): Promise<DedeConfig> {
  const paths = getDedeConfigPaths(cwd);
  const globalConfig = await readConfig(paths.global);
  const projectConfig = projectTrusted ? await readConfig(paths.project) : {};
  return {
    profiles: mergeProfileDefaults(globalConfig.profiles, projectConfig.profiles),
    additionalArgs: [...(projectConfig.additionalArgs ?? globalConfig.additionalArgs ?? [])],
  };
}

export async function loadProfileDefaults(cwd: string, projectTrusted: boolean): Promise<ProfileDefaults> {
  return (await loadDedeConfig(cwd, projectTrusted)).profiles;
}

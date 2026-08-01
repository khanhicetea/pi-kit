import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROFILES, THINKING_LEVELS, type DedeProfile, type ProfileDefaults, type ThinkingLevel } from "./types.ts";

const CONFIG_FILE_NAME = "pi-dede.json";
const MAX_CONFIG_BYTES = 64 * 1024;

interface DedeConfigFile {
  profiles?: ProfileDefaults;
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
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  assertKnownKeys(parsed, ["profiles"], path);
  if (parsed.profiles === undefined) return {};
  if (!isRecord(parsed.profiles)) throw new Error(`${path}.profiles must be an object`);
  assertKnownKeys(parsed.profiles, PROFILES, `${path}.profiles`);

  const profiles: ProfileDefaults = {};
  for (const profile of PROFILES) {
    const value = parsed.profiles[profile];
    if (value === undefined) continue;
    if (!isRecord(value)) throw new Error(`${path}.profiles.${profile} must be an object`);
    assertKnownKeys(value, ["model", "thinking"], `${path}.profiles.${profile}`);

    if (value.model !== undefined && (typeof value.model !== "string" || value.model.trim().length === 0)) {
      throw new Error(`${path}.profiles.${profile}.model must be a non-empty string`);
    }
    if (value.thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(value.thinking)) {
      throw new Error(`${path}.profiles.${profile}.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }

    profiles[profile] = {
      ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
      ...(value.thinking !== undefined ? { thinking: value.thinking as ThinkingLevel } : {}),
    };
  }
  return { profiles };
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
    const value = { ...globalDefaults[profile], ...projectDefaults[profile] };
    if (value.model !== undefined || value.thinking !== undefined) merged[profile] = value;
  }
  return merged;
}

export function getDedeConfigPaths(cwd: string): { global: string; project: string } {
  return {
    global: join(getAgentDir(), CONFIG_FILE_NAME),
    project: join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
  };
}

/** Load global defaults and, for trusted projects only, field-level project overrides. */
export async function loadProfileDefaults(cwd: string, projectTrusted: boolean): Promise<ProfileDefaults> {
  const paths = getDedeConfigPaths(cwd);
  const globalConfig = await readConfig(paths.global);
  const projectConfig = projectTrusted ? await readConfig(paths.project) : {};
  return mergeProfileDefaults(globalConfig.profiles, projectConfig.profiles);
}

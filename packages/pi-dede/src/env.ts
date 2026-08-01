export const MAX_CHILD_ENV_VARIABLES = 64;
export const MAX_CHILD_ENV_BYTES = 16 * 1024;
export const MAX_CHILD_ENV_VALUE_BYTES = 8 * 1024;
export const CHILD_ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,127}$";

const CHILD_ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BLOCKED_ENV_NAMES = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "BASH_ENV",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReservedName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "PI_SESSION_ID" || upper === "PI_SESSION_FILE" || upper.startsWith("PI_DEDE_");
}

/** Validate portable child environment overrides without exposing values in diagnostics. */
export function validateChildEnv(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object of string values`);
  const entries = Object.entries(value);
  if (entries.length > MAX_CHILD_ENV_VARIABLES) {
    throw new Error(`${label} must contain at most ${MAX_CHILD_ENV_VARIABLES} variables`);
  }

  let totalBytes = 0;
  const result: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    if (!CHILD_ENV_NAME_REGEX.test(name)) {
      throw new Error(`${label} contains invalid variable name: ${name}`);
    }
    const upper = name.toUpperCase();
    if (
      isReservedName(name) ||
      BLOCKED_ENV_NAMES.has(upper) ||
      upper.startsWith("LD_") ||
      upper.startsWith("DYLD_")
    ) {
      throw new Error(`${label} cannot override protected variable: ${name}`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`${label}.${name} must be a string`);
    }
    if (rawValue.includes("\0")) {
      throw new Error(`${label}.${name} must not contain NUL bytes`);
    }
    const valueBytes = Buffer.byteLength(rawValue, "utf8");
    if (valueBytes > MAX_CHILD_ENV_VALUE_BYTES) {
      throw new Error(`${label}.${name} exceeds ${MAX_CHILD_ENV_VALUE_BYTES} UTF-8 bytes`);
    }
    totalBytes += Buffer.byteLength(name, "utf8") + valueBytes;
    result[name] = rawValue;
  }
  if (totalBytes > MAX_CHILD_ENV_BYTES) {
    throw new Error(`${label} exceeds ${MAX_CHILD_ENV_BYTES} total UTF-8 bytes`);
  }
  return result;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Merge environment sources in precedence order, respecting Windows' case-insensitive names. */
export function mergeChildEnv(
  sources: readonly (EnvSource | undefined)[],
  caseInsensitive = process.platform === "win32",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (caseInsensitive) {
        const upper = name.toUpperCase();
        for (const existing of Object.keys(result)) {
          if (existing.toUpperCase() === upper) delete result[existing];
        }
      }
      result[name] = value;
    }
  }
  return result;
}

/** Remove parent-session and delegation control variables case-insensitively. */
export function removeReservedChildEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (isReservedName(name)) delete env[name];
  }
}

/** Trusted-config robustness, not a sandbox for installed extensions. */
export interface AdditionalArg { flag: string; value?: string; changesSurface: boolean }

// An allowlist also rejects aliases, future lifecycle switches and positional prompts.
// Prompt/model/tool selection belongs to the typed agent fields, not trailing argv.
const VALUES = new Map([
  ["-e", "--extension"], ["--extension", "--extension"],
  ["--provider", "--provider"], ["--api-key", "--api-key"],
  ["--skill", "--skill"],
]);
const SWITCHES = new Set(["--no-extensions", "--no-skills", "--no-context-files"]);

export function parseAdditionalArgs(args: readonly string[], label = "additionalArgs"): AdditionalArg[] {
  const parsed: AdditionalArg[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string" || arg.includes("\0")) throw new Error(`${label}[${index}] must be a NUL-free string`);
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const canonical = VALUES.get(flag);
    if (canonical) {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (typeof value !== "string" || !value || value.startsWith("-") || value.includes("\0")) {
        throw new Error(`${label}: ${flag} requires a non-empty value`);
      }
      parsed.push({ flag: canonical, value, changesSurface: true });
    } else if (SWITCHES.has(flag) && equals < 0) {
      parsed.push({ flag, changesSurface: true });
    } else {
      throw new Error(`${label}: unsupported or pi-dede-owned option ${flag}; positional prompts are forbidden. Use agent model/thinking/tools/systemPrompt fields for overrides.`);
    }
  }
  return parsed;
}

/** Normalize equals syntax because not every supported Pi CLI parses it itself. */
export function additionalArgv(args: readonly string[]): string[] {
  const parsed = parseAdditionalArgs(args);
  let index = 0;
  return parsed.flatMap(({ flag, value }) => {
    const original = args[index++];
    if (value !== undefined && !original.includes("=")) index++;
    const spelling = original === "-e" ? "-e" : flag;
    return value === undefined ? [spelling] : [spelling, value];
  });
}

/** Trusted-config argument parsing; child lifecycle overrides are explicitly user-owned. */
export interface AdditionalArg { flag: string; value?: string; changesSurface: boolean }

function isFlag(value: string): boolean {
  return value.startsWith("-")
    && value !== "-"
    && value !== "--"
    && !/[\s\0=]/.test(value);
}

/**
 * Parse configured flag/value pairs while rejecting positional arguments.
 *
 * Configuration is trusted: any CLI flag may be supplied, including extension
 * flags registered only after Pi loads its normal extension set. Every custom
 * child argument disables fork eligibility because its prompt/model/tool
 * effects cannot be verified locally.
 */
export function parseAdditionalArgs(args: readonly string[], label = "additionalArgs"): AdditionalArg[] {
  const parsed: AdditionalArg[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string" || arg.includes("\0")) throw new Error(`${label}[${index}] must be a NUL-free string`);

    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (!isFlag(flag)) throw new Error(`${label}[${index}] must be a CLI flag; positional prompts are forbidden`);

    let value: string | undefined;
    if (equals >= 0) {
      value = arg.slice(equals + 1);
      if (!value || value.includes("\0")) throw new Error(`${label}: ${flag} requires a non-empty value`);
    } else {
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        if (!next || next.includes("\0")) throw new Error(`${label}[${index + 1}] must be a non-empty NUL-free value`);
        value = next;
        index++;
      }
    }
    parsed.push({ flag, value, changesSurface: true });
  }
  return parsed;
}

/** Normalize equals syntax because not every supported Pi CLI parses it itself. */
export function additionalArgv(args: readonly string[]): string[] {
  return parseAdditionalArgs(args).flatMap(({ flag, value }) => value === undefined ? [flag] : [flag, value]);
}

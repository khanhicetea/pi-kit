import { describe, expect, it } from "vitest";
import { additionalArgv, parseAdditionalArgs } from "../src/cli-args.ts";

describe("configured child CLI overrides", () => {
  it.each(["prompt", "--", "-", "--extension\0bad"])("rejects positional or malformed argument %s", (arg) => {
    expect(() => parseAdditionalArgs([arg])).toThrow();
  });

  it("accepts extension-defined boolean flags and generic flag/value pairs", () => {
    expect(parseAdditionalArgs(["--fast", "--custom-option", "value"])).toEqual([
      { flag: "--fast", value: undefined, changesSurface: true },
      { flag: "--custom-option", value: "value", changesSurface: true },
    ]);
  });

  it("normalizes equals syntax for arbitrary overrides", () => {
    expect(additionalArgv(["--fast", "--custom-option=value"])).toEqual([
      "--fast", "--custom-option", "value",
    ]);
  });
});

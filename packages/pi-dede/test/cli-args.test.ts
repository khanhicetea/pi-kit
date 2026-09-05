import { describe, expect, it } from "vitest";
import { additionalArgv, parseAdditionalArgs } from "../src/cli-args.ts";

describe("owned CLI invariants", () => {
  it.each(["--mode=print", "--session", "-c", "--no-session", "--approve", "--system-prompt=x", "--tools=write", "-t", "prompt", "--", "--extension\0bad"])("rejects %s", (flag) => {
    expect(() => parseAdditionalArgs([flag])).toThrow();
  });
  it.each([["-e"], ["--extension="], ["--provider", "--no-skills"]])("rejects missing values %j", (...args) => {
    expect(() => parseAdditionalArgs(args)).toThrow();
  });
  it("normalizes approved extension flags and equals syntax", () => {
    expect(additionalArgv(["-e", "/tmp/provider.ts", "--skill=/tmp/skill", "--no-skills"])).toEqual([
      "-e", "/tmp/provider.ts", "--skill", "/tmp/skill", "--no-skills",
    ]);
  });
});

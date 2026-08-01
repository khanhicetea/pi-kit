import { describe, expect, it } from "vitest";
import { mergeChildEnv, validateChildEnv } from "../src/env.ts";

describe("child environment handling", () => {
  it("merges sources in precedence order", () => {
    expect(mergeChildEnv([
      { GLOBAL_ONLY: "yes", SHARED: "global" },
      { PROJECT_ONLY: "yes", SHARED: "project" },
      { AGENT_ONLY: "yes", SHARED: "agent" },
    ])).toEqual({
      GLOBAL_ONLY: "yes",
      PROJECT_ONLY: "yes",
      AGENT_ONLY: "yes",
      SHARED: "agent",
    });
  });

  it("replaces differently-cased names when using Windows semantics", () => {
    expect(mergeChildEnv([
      { TOKEN: "global", KEEP: "yes" },
      { token: "project" },
      { Token: "agent" },
    ], true)).toEqual({ KEEP: "yes", Token: "agent" });
  });

  it("blocks dynamic-loader startup variables", () => {
    expect(() => validateChildEnv({ LD_AUDIT: "/tmp/inject.so" }, "env")).toThrow(/protected variable: LD_AUDIT/);
    expect(() => validateChildEnv({ DYLD_PRINT_TO_FILE: "/tmp/output" }, "env")).toThrow(/protected variable/);
  });
});

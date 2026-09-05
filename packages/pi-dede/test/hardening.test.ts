import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { localForkSurface } from "../src/fork-surface.ts";
import { DedeDelegateSchema } from "../src/schema.ts";
import { resolvePiExecutable } from "../src/invocation.ts";
import { toolSurfaceFixture } from "./tool-surface-fixture.ts";

const script = process.argv[1];
const executable = process.env.PI_DEDE_EXECUTABLE;
const path = process.env.PATH;
afterEach(() => {
  process.argv[1] = script;
  if (executable === undefined) delete process.env.PI_DEDE_EXECUTABLE;
  else process.env.PI_DEDE_EXECUTABLE = executable;
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
});

describe("hardening contracts", () => {
  it("documents context-aware model precedence in the actual schema", () => {
    const description = DedeDelegateSchema.properties.agents.items.properties.model.description;
    expect(description).toContain("even when auto falls back");
    expect(description).toContain("Explicit isolated");
  });

  it("rejects unavailable and same-name overridden tool surfaces", () => {
    expect(localForkSurface(process.cwd(), ["dynamic"], []).reason).toContain("dynamic");
    const tools = toolSurfaceFixture(process.cwd());
    expect(localForkSurface(process.cwd(), ["read"], tools).fingerprint).toBeTruthy();
    const overridden = tools.map((tool) => tool.name === "read" ? { ...tool, parameters: { type: "string" } } : tool);
    expect(localForkSurface(process.cwd(), ["read"], overridden).reason).toContain("metadata/schema differs");
    expect(localForkSurface(process.cwd(), ["read"], undefined).reason).toContain("metadata/provenance");
  });

  it("never relaunches an unrelated existing SDK entrypoint", () => {
    delete process.env.PI_DEDE_EXECUTABLE;
    process.argv[1] = new URL(import.meta.url).pathname;
    const invocation = resolvePiExecutable(["--mode", "rpc"]);
    expect(invocation.args[0]).not.toBe(process.argv[1]);
  });

  it("finds the Pi launcher on PATH when no override is configured", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-dede-path-"));
    const launcher = join(directory, process.platform === "win32" ? "pi.exe" : "pi");
    try {
      writeFileSync(launcher, "#!/bin/sh\n");
      chmodSync(launcher, 0o755);
      delete process.env.PI_DEDE_EXECUTABLE;
      process.env.PATH = [directory, path].filter(Boolean).join(delimiter);
      expect(resolvePiExecutable(["--mode", "rpc"])).toEqual({ command: launcher, args: ["--mode", "rpc"] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable explicit launcher with actionable guidance", () => {
    process.env.PI_DEDE_EXECUTABLE = "/nonexistent/pi-dede-launcher";
    expect(() => resolvePiExecutable([])).toThrow("PI_DEDE_EXECUTABLE");
  });
});

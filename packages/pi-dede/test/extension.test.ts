import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dedeExtension from "../src/index.ts";

afterEach(() => { delete process.env.PI_DEDE_DEPTH; });

describe("extension registration", () => {
  it("registers exactly the dede_delegate MVP tool at depth zero", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    dedeExtension({ registerTool, on } as unknown as ExtensionAPI);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0][0];
    expect(tool).toMatchObject({ name: "dede_delegate", label: "Đệ Đệ" });
    expect(tool.description).toContain("one to five");
    expect(tool.promptSnippet).toContain("planning");
    expect(tool.promptGuidelines.join("\n")).toContain("dependsOn");
    expect(tool.promptGuidelines.join("\n")).toContain("Never invent profile names");
    expect(tool.promptGuidelines.join("\n")).toContain("planner");
    expect(tool.promptGuidelines.join("\n")).toContain("dependencyContext");
    expect(tool.parameters.properties.agents.maxItems).toBe(5);
    expect(tool.parameters.properties.agents.items.properties.dependsOn.maxItems).toBe(4);
    expect(tool.parameters.properties.agents.items.properties.profile.description).toContain("planner");
    expect(tool.parameters.properties.agents.items.properties.profile.description).toContain("never invent a profile name");
    expect(tool.parameters.properties.timeoutSeconds).toMatchObject({ minimum: 1800, maximum: 3600 });
    expect(tool.parameters.properties.agents.items.properties.timeoutSeconds).toMatchObject({ minimum: 30, maximum: 3600 });
    expect(tool.parameters.properties.agents.items.properties.dependencyContext).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(tool.parameters.properties.agents.items.properties.dependencyContext.properties.maxBytes).toMatchObject({
      minimum: 4096,
      maximum: 262144,
    });
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("registers nothing in a child process", () => {
    process.env.PI_DEDE_DEPTH = "1";
    const registerTool = vi.fn();
    const on = vi.fn();
    dedeExtension({ registerTool, on } as unknown as ExtensionAPI);
    expect(registerTool).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dedeExtension from "../src/index.ts";

afterEach(() => { delete process.env.PI_DEDE_DEPTH; });

describe("extension registration", () => {
  it("registers the narrow v0.2 delegation tool at depth zero", () => {
    const registerTool = vi.fn();
    const on = vi.fn();
    dedeExtension({ registerTool, on } as unknown as ExtensionAPI);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0][0];
    expect(tool).toMatchObject({ name: "dede_delegate", label: "Đệ Đệ" });
    expect(tool.description).toContain("one to three");
    expect(tool.description).toContain("session-scoped resume handle");
    expect(tool.promptSnippet).toContain("resume a timed-out child");
    const guidance = tool.promptGuidelines.join("\n");
    expect(guidance).toContain("first-pass repository orientation");
    expect(guidance).toContain("planning, synthesis");
    expect(guidance).toContain("two local tool calls");
    expect(guidance).toContain("cloned prompts");
    expect(guidance).toContain("compact contract");
    expect(guidance).toContain("success criteria");
    expect(guidance).toContain("master");
    expect(guidance).toContain("30-180 second extension");
    expect(guidance).toContain("do not restart completed work or resume blindly");
    expect(guidance).not.toContain("dependsOn");
    expect(tool.parameters.properties.agents.maxItems).toBe(3);
    expect(tool.parameters.properties.agents.items.properties.dependsOn).toBeUndefined();
    expect(tool.parameters.properties.agents.items.properties.resume).toMatchObject({ type: "string", maxLength: 128 });
    expect(tool.parameters.properties.agents.items.properties.env).toMatchObject({ type: "object", maxProperties: 64 });
    expect(tool.parameters.properties.agents.items.properties.profile.description).not.toContain("planner");
    expect(tool.parameters.properties.timeoutSeconds).toMatchObject({ minimum: 30, maximum: 1800 });
    expect(tool.parameters.properties.agents.items.properties.timeoutSeconds).toMatchObject({ minimum: 30, maximum: 1800 });
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent_settled", expect.any(Function));
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

import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";

function mockPi() {
	const tools: Array<Record<string, unknown>> = [];
	const api = {
		registerTool(def: Record<string, unknown>) {
			tools.push(def);
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	return { api, tools };
}

describe("extension registration", () => {
	it("registers an edit tool override with the built-in-compatible shape", () => {
		const { api, tools } = mockPi();
		extension(api);
		expect(tools).toHaveLength(1);
		const tool = tools[0];
		expect(tool.name).toBe("edit");
		expect(tool.label).toBe("edit");
		expect(typeof tool.description).toBe("string");
		expect(tool.description).toContain("recovery context");
		expect(typeof tool.promptSnippet).toBe("string");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as unknown[]).length).toBeGreaterThanOrEqual(5);
		expect(tool.parameters).toBeDefined();
		expect(typeof tool.prepareArguments).toBe("function");
		expect(typeof tool.execute).toBe("function");
		// no custom renderers: the built-in edit renderer is inherited
		expect(tool.renderCall).toBeUndefined();
		expect(tool.renderResult).toBeUndefined();
	});
});

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension, { INDEX_ENTRY_TYPE, REVIEW_ENTRY_TYPE } from "../src/index.ts";

function mockPi() {
	const commands = new Map<string, Record<string, unknown>>();
	const renderers = new Map<string, (...args: any[]) => unknown>();
	const api = {
		registerCommand(name: string, command: Record<string, unknown>) { commands.set(name, command); },
		registerEntryRenderer(name: string, renderer: (...args: any[]) => unknown) { renderers.set(name, renderer); },
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	return { api, commands, renderers };
}

describe("pi-sevo extension", () => {
	it("registers explicit index, status, and review commands without background hooks or tools", () => {
		const state = mockPi();
		extension(state.api);
		expect([...state.commands.keys()]).toEqual(["sevo-index", "sevo-status", "sevo-review"]);
		expect(state.renderers.has(INDEX_ENTRY_TYPE)).toBe(true);
		expect(state.renderers.has(REVIEW_ENTRY_TYPE)).toBe(true);
	});
});

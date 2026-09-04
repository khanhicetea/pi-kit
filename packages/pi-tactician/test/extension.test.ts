import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { GUIDANCE_MARKER, REPORT_ENTRY_TYPE } from "../src/index.ts";

function mockPi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, Record<string, unknown>>();
	const renderers = new Map<string, (...args: unknown[]) => unknown>();
	const appendEntry = vi.fn();
	const api = {
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: Record<string, unknown>) {
			commands.set(name, command);
		},
		registerEntryRenderer(name: string, renderer: (...args: unknown[]) => unknown) {
			renderers.set(name, renderer);
		},
		appendEntry,
	} as unknown as ExtensionAPI;
	return { api, handlers, commands, renderers, appendEntry };
}

describe("pi-tactician extension", () => {
	it("adds stable guidance without registering a model-callable tool", () => {
		const state = mockPi();
		extension(state.api);
		expect(state.handlers.has("before_agent_start")).toBe(true);
		expect(state.commands.has("tactician-report")).toBe(true);
		expect(state.renderers.has(REPORT_ENTRY_TYPE)).toBe(true);

		const handler = state.handlers.get("before_agent_start")!;
		const changed = handler({ systemPrompt: "base" }) as { systemPrompt: string };
		expect(changed.systemPrompt).toContain(GUIDANCE_MARKER);
		expect(handler({ systemPrompt: changed.systemPrompt })).toBeUndefined();
	});

	it("stores a TUI-only report entry for the current task", async () => {
		const state = mockPi();
		extension(state.api);
		const command = state.commands.get("tactician-report") as {
			handler: (args: string, ctx: unknown) => Promise<void>;
		};
		const notify = vi.fn();
		const branch = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "work" }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }],
					usage: { cost: { total: 0.01 } },
				},
			},
		];
		await command.handler("", { sessionManager: { getBranch: () => branch }, ui: { notify } });
		expect(state.appendEntry).toHaveBeenCalledWith(
			REPORT_ENTRY_TYPE,
			expect.objectContaining({ scope: "task", report: expect.objectContaining({ toolBatches: 1 }) }),
		);
		expect(notify).toHaveBeenCalled();
	});
});

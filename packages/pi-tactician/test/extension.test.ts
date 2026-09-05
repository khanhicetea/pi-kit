import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { BATCH_ENTRY_TYPE, GUIDANCE_MARKER, REPORT_ENTRY_TYPE } from "../src/index.ts";

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
		const ctx = { sessionManager: { getEntries: () => [], getBranch: () => [] } };
		const changed = handler({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
		expect(changed.systemPrompt).toContain("<tactician_system_prompt>");
		expect(changed.systemPrompt).toContain(GUIDANCE_MARKER);
		expect(changed.systemPrompt).toContain("If you spawn subagents, append this complete <tactician_system_prompt>...</tactician_system_prompt> block");
		expect(changed.systemPrompt).toContain("</tactician_system_prompt>");
		expect(handler({ systemPrompt: changed.systemPrompt }, ctx)).toBeUndefined();
	});

	it("adds a TUI-only marker once for a sibling tool batch", () => {
		const state = mockPi();
		extension(state.api);
		const branch = [{
			type: "message",
			message: { role: "assistant", content: [
				{ type: "toolCall", id: "one", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "two", name: "ffgrep", arguments: { pattern: "x" } },
			] },
		}];
		const ctx = {
			mode: "tui",
			sessionManager: { getEntries: () => branch, getBranch: () => branch },
		};
		const handler = state.handlers.get("tool_execution_start")!;
		handler({ toolCallId: "one" }, ctx);
		handler({ toolCallId: "two" }, ctx);
		expect(state.appendEntry).toHaveBeenCalledTimes(1);
		expect(state.appendEntry).toHaveBeenCalledWith(BATCH_ENTRY_TYPE, { schemaVersion: 1, tools: ["read", "ffgrep"] });
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
			expect.objectContaining({ schemaVersion: 2, scope: "session", report: expect.objectContaining({ toolBatches: 1 }) }),
		);
		expect(notify).toHaveBeenCalled();
	});

	it("selects task versus session scope and rejects invalid arguments", async () => {
		const state = mockPi();
		extension(state.api);
		const command = state.commands.get("tactician-report") as { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown };
		const user = { type: "message", message: { role: "user", content: "task" } };
		const assistant = { type: "message", message: { role: "assistant", content: [] } };
		const ctx = { cwd: "/repo", sessionManager: { getBranch: () => [user, assistant, user, assistant] }, ui: { notify: vi.fn() } };
		await command.handler("task", ctx);
		expect(state.appendEntry).toHaveBeenLastCalledWith(REPORT_ENTRY_TYPE, expect.objectContaining({ report: expect.objectContaining({ assistantRequests: 1 }) }));
		await command.handler(" SESSION ", ctx);
		expect(state.appendEntry).toHaveBeenLastCalledWith(REPORT_ENTRY_TYPE, expect.objectContaining({ scope: "session", report: expect.objectContaining({ assistantRequests: 2 }) }));
		await command.handler("invalid", ctx);
		expect(state.appendEntry).toHaveBeenCalledTimes(2);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /tactician-report [task|session]", "warning");
		expect(command.getArgumentCompletions(" S")).toEqual([{ value: "session", label: "session" }]);
	});
});

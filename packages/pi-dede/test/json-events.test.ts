import { describe, expect, it } from "vitest";
import { PiJsonCollector } from "../src/json-events.ts";

const assistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "hidden chain of thought" },
    { type: "text", text: "## Summary\nUseful result" },
  ],
  provider: "test",
  model: "model",
  responseId: "response-1",
  timestamp: 10,
  stopReason: "stop",
  usage: {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
  },
};

describe("PiJsonCollector", () => {
  it("parses arbitrary byte chunks, excludes thinking, and collects activity", () => {
    const collector = new PiJsonCollector();
    const stream = [
      JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } }),
      JSON.stringify({ type: "message_end", message: assistant }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n";
    const bytes = Buffer.from(stream);
    for (let i = 0; i < bytes.length; i += 7) collector.push(bytes.subarray(i, i + 7));
    const result = collector.end();

    expect(result.finalText).toBe("## Summary\nUseful result");
    expect(result.finalText).not.toContain("hidden chain");
    expect(result.activity.some((item) => item.text.includes("reading src/index.ts"))).toBe(true);
    expect(result.sawAgentEnd).toBe(true);
    expect(result.turns).toBe(1);
    expect(result.usage.cost.total).toBeCloseTo(0.33);
  });

  it("does not emit progress for answer deltas or tool update payloads", () => {
    const progress: string[] = [];
    const collector = new PiJsonCollector((text) => progress.push(text));
    collector.push(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial secret answer" },
    })}\n`);
    collector.push(`${JSON.stringify({ type: "tool_execution_update", toolName: "read", partialResult: "large output" })}\n`);
    const result = collector.end();
    expect(progress).toEqual([]);
    expect(result.finalText).toContain("partial secret answer");
    expect(result.finalText).toContain("Partial response interrupted");
  });

  it("deduplicates repeated finalized assistant events", () => {
    const collector = new PiJsonCollector();
    const line = JSON.stringify({ type: "message_end", message: assistant });
    collector.push(`${line}\n${line}\n${JSON.stringify({ type: "agent_end" })}\n`);
    const result = collector.end();
    expect(result.turns).toBe(1);
    expect(result.usage.input).toBe(10);
  });

  it("bounds malformed and oversized diagnostics while continuing", () => {
    const collector = new PiJsonCollector();
    collector.push("not json\n{bad}\n");
    collector.push(`${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
    collector.push(`${JSON.stringify({ type: "message_end", message: assistant })}\n${JSON.stringify({ type: "agent_end" })}\n`);
    const result = collector.end();
    expect(result.malformedLines).toBe(2);
    expect(result.oversizedLines).toBe(1);
    expect(result.finalText).toContain("Useful result");
    expect(result.activity.length).toBeLessThanOrEqual(100);
  });
});

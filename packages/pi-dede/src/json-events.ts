import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";
import type { ChildUsage, DedeActivity, DetailedUsage } from "./types.ts";

const MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVITY = 100;

function zeroDetailedUsage(): DetailedUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function sumUsage(target: DetailedUsage, usage: Partial<Usage> | undefined): void {
  if (!usage) return;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.totalTokens += usage.totalTokens ?? 0;
  target.cost.input += usage.cost?.input ?? 0;
  target.cost.output += usage.cost?.output ?? 0;
  target.cost.cacheRead += usage.cost?.cacheRead ?? 0;
  target.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
  target.cost.total += usage.cost?.total ?? 0;
}

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, any> : undefined;
}

function textFromAssistant(message: Record<string, any>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: unknown) => object(part)?.type === "text")
    .map((part: unknown) => String(object(part)?.text ?? ""))
    .join("\n");
}

function messageIdentity(message: Record<string, any>): string {
  return String(
    message.id ?? message.responseId ??
    `${message.provider ?? ""}/${message.model ?? ""}/${message.timestamp ?? ""}/${message.stopReason ?? ""}/${message.usage?.input ?? ""}/${message.usage?.output ?? ""}`,
  );
}

function short(value: unknown, max = 120): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function displayPath(value: unknown): string {
  const raw = String(value ?? "");
  const home = homedir();
  return raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
}

export interface CollectedProtocol {
  finalText: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage: DetailedUsage;
  turns: number;
  activity: DedeActivity[];
  sawAgentEnd: boolean;
  malformedLines: number;
  oversizedLines: number;
}

/** Bounded JSONL collector for Pi's print/json event stream. */
export class PiJsonCollector {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discardingOversizedLine = false;
  private readonly seenAssistantMessages = new Set<string>();
  private readonly state: CollectedProtocol = {
    finalText: "",
    usage: zeroDetailedUsage(),
    turns: 0,
    activity: [],
    sawAgentEnd: false,
    malformedLines: 0,
    oversizedLines: 0,
  };

  constructor(private readonly onProgress?: (text: string) => void) {}

  push(chunk: Buffer | string): void {
    this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  end(): CollectedProtocol {
    this.consume(this.decoder.end());
    if (!this.discardingOversizedLine && this.buffer.trim()) this.processLine(this.buffer);
    this.buffer = "";
    return {
      ...this.state,
      usage: { ...this.state.usage, cost: { ...this.state.usage.cost } },
      activity: [...this.state.activity],
    };
  }

  snapshot(): CollectedProtocol {
    return {
      ...this.state,
      usage: { ...this.state.usage, cost: { ...this.state.usage.cost } },
      activity: [...this.state.activity],
    };
  }

  private consume(text: string): void {
    let remaining = text;
    while (remaining.length > 0) {
      if (this.discardingOversizedLine) {
        const newline = remaining.indexOf("\n");
        if (newline < 0) return;
        this.discardingOversizedLine = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      const newline = remaining.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer + remaining.slice(0, newline).replace(/\r$/, "");
        this.buffer = "";
        remaining = remaining.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
          this.oversized();
        } else {
          this.processLine(line);
        }
        continue;
      }

      this.buffer += remaining;
      if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSON_LINE_BYTES) {
        this.buffer = "";
        this.discardingOversizedLine = true;
        this.oversized();
      }
      return;
    }
  }

  private oversized(): void {
    this.state.oversizedLines++;
    this.addActivity("status", "ignored oversized protocol line");
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line) as Record<string, any>;
    } catch {
      this.state.malformedLines++;
      if (this.state.malformedLines <= 3) this.addActivity("status", "ignored malformed protocol line");
      return;
    }

    switch (event.type) {
      case "message_update": {
        const delta = object(event.assistantMessageEvent);
        if (delta?.type === "text_delta" && typeof delta.delta === "string") {
          this.onProgress?.(`responding: ${short(delta.delta.replace(/\s+/g, " ").trim(), 80)}`);
        }
        break;
      }
      case "message_end": {
        const message = object(event.message);
        if (message?.role !== "assistant") break;
        const identity = messageIdentity(message);
        if (!this.seenAssistantMessages.has(identity)) {
          this.seenAssistantMessages.add(identity);
          this.state.turns++;
          sumUsage(this.state.usage, message.usage);
        }
        this.state.finalText = textFromAssistant(message);
        this.state.model = message.model ? `${message.provider ? `${message.provider}/` : ""}${message.model}` : this.state.model;
        this.state.stopReason = message.stopReason ?? this.state.stopReason;
        this.state.errorMessage = message.errorMessage ?? this.state.errorMessage;
        this.onProgress?.("responded");
        break;
      }
      case "tool_execution_start": {
        const name = String(event.toolName ?? "tool");
        const args = object(event.args) ?? {};
        let description = name;
        if (name === "read") description = `reading ${short(displayPath(args.path ?? args.file_path ?? "file"), 100)}`;
        else if (name === "grep") description = `grep /${short(args.pattern ?? "", 70)}/`;
        else if (name === "find") description = `find ${short(args.pattern ?? "*", 80)}`;
        else if (name === "ls") description = `listing ${short(displayPath(args.path ?? "."), 100)}`;
        else if (name === "bash") description = `$ ${short(args.command ?? "", 100)}`;
        else if (name === "edit" || name === "write") description = `${name} ${short(displayPath(args.path ?? args.file_path ?? "file"), 100)}`;
        this.addActivity("tool", description);
        this.onProgress?.(description);
        break;
      }
      case "tool_execution_update":
        // Tool output can be large or sensitive; expose only a fixed activity label.
        this.onProgress?.(`${String(event.toolName ?? "tool")} working`);
        break;
      case "tool_execution_end":
        this.onProgress?.(`${String(event.toolName ?? "tool")} finished`);
        break;
      case "agent_end":
        this.state.sawAgentEnd = true;
        this.addActivity("status", "agent finished");
        break;
      case "auto_retry_start":
      case "retry_start":
        this.addActivity("status", "model retrying");
        this.onProgress?.("model retrying");
        break;
      case "auto_compaction_start":
      case "compaction_start":
        this.addActivity("status", "context compacting");
        this.onProgress?.("context compacting");
        break;
    }
  }

  private addActivity(type: DedeActivity["type"], text: string): void {
    if (!text) return;
    if (this.state.activity.length >= MAX_ACTIVITY) this.state.activity.shift();
    this.state.activity.push({ type, text: short(text, 240) });
  }
}

export function childUsage(protocol: CollectedProtocol): ChildUsage {
  return {
    input: protocol.usage.input,
    output: protocol.usage.output,
    cacheRead: protocol.usage.cacheRead,
    cacheWrite: protocol.usage.cacheWrite,
    cost: protocol.usage.cost.total,
    totalTokens: protocol.usage.totalTokens,
    turns: protocol.turns,
  };
}

export function aggregateUsages(usages: DetailedUsage[]): DetailedUsage {
  const result = zeroDetailedUsage();
  for (const usage of usages) sumUsage(result, usage);
  return result;
}

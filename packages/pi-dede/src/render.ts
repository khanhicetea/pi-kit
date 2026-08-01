import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { DEFAULT_CHILD_TIMEOUT_SECONDS, DEFAULT_RESUME_TIMEOUT_SECONDS } from "./schema.ts";
import type { DedeDelegateParams, DedeToolDetails } from "./types.ts";

function preview(value: string, max = 54): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function tokens(value: number): string {
  if (value < 1000) return String(value);
  return value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function renderDedeCall(args: DedeDelegateParams, theme: any, context: any): Text {
  const agents = args.agents ?? [];
  const mode = agents[0]?.resume ? "short resume" : agents.length > 1 ? "parallel evidence" : agents[0]?.profile === "worker" ? "worker" : "single evidence";
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  let text = theme.fg("toolTitle", theme.bold("Đệ Đệ  ")) + theme.fg("accent", `${mode} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  for (const agent of agents) {
    const profile = agent.profile ?? "custom";
    const preset = agent.resume ? "existing" : agent.toolPreset ?? (profile === "worker" ? "coding" : "read-only");
    const timeout = agent.timeoutSeconds ?? args.timeoutSeconds ?? (agent.resume ? DEFAULT_RESUME_TIMEOUT_SECONDS : DEFAULT_CHILD_TIMEOUT_SECONDS);
    const resume = agent.resume ? `resume ${preview(agent.resume, 18)} · ` : "";
    text += `\n  ${theme.fg("accent", agent.id.padEnd(18))} ${theme.fg("muted", preset.padEnd(9))} ${theme.fg("dim", `${resume}${timeout}s · ${preview(agent.goal)}`)}`;
  }
  component.setText(text);
  return component;
}

function icon(status: string, theme: any): string {
  if (status === "succeeded") return theme.fg("success", "✓");
  if (status === "failed" || status === "timed_out" || status === "cancelled") return theme.fg("error", "✗");
  if (status === "running") return theme.fg("warning", "●");
  return theme.fg("muted", "○");
}

export function renderDedeResult(result: any, options: any, theme: any, context: any): Text | Container {
  const details = result.details as DedeToolDetails | undefined;
  if (!details?.results?.length) {
    const raw = result.content?.find((part: any) => part.type === "text")?.text ?? "(no output)";
    return new Text(raw, 0, 0);
  }

  const done = details.results.filter((child) => !["queued", "running"].includes(child.status)).length;
  const running = details.results.filter((child) => child.status === "running").length;
  const succeeded = details.results.filter((child) => child.status === "succeeded").length;

  if (options.isPartial) {
    const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    let text = theme.fg("toolTitle", theme.bold("Đệ Đệ  ")) + theme.fg("accent", `${done}/${details.results.length} done · ${running} running`) + theme.fg("dim", " · Esc to cancel");
    for (const child of details.results) {
      const latest = child.activity.at(-1)?.text;
      const runtime = `${child.resumedFrom ? "resumed · " : ""}${child.model} · ${child.thinking} · ${seconds(child.durationMs)}/${child.timeoutSeconds}s`;
      text += `\n  ${icon(child.status, theme)} ${theme.fg("accent", child.id)} ${theme.fg("muted", `· ${runtime} ·`)} ${theme.fg("dim", latest ?? child.status)}`;
    }
    component.setText(text);
    return component;
  }

  if (!options.expanded) {
    let text = `${details.status === "succeeded" ? theme.fg("success", "✓") : theme.fg("warning", "◐")} ${theme.fg("toolTitle", theme.bold("Đệ Đệ  "))}${theme.fg("accent", `${succeeded}/${details.results.length} succeeded`)}`;
    for (const child of details.results) {
      const first = child.finalText.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).slice(0, 2).join(" ");
      const stats = `${child.usage.turns} turns · ${tokens(child.usage.totalTokens)} tok${child.usage.cost ? ` · $${child.usage.cost.toFixed(4)}` : ""} · ${seconds(child.durationMs)}`;
      text += `\n\n  ${icon(child.status, theme)} ${theme.fg("accent", child.id)} ${theme.fg("muted", child.status)}`;
      text += `\n    ${theme.fg("toolOutput", preview(first || child.errorMessage || "(no output)", 100))}`;
      text += `\n    ${theme.fg("dim", stats)}`;
    }
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(`${theme.fg("toolTitle", theme.bold("Đệ Đệ  "))}${theme.fg("accent", `${succeeded}/${details.results.length} succeeded`)} ${theme.fg("dim", `· ${seconds(details.durationMs)}`)}`, 0, 0));
  const args = context.args as DedeDelegateParams | undefined;
  if (args?.objective) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Master-owned objective: ") + theme.fg("dim", args.objective), 0, 0));
  }

  for (const child of details.results) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(`${icon(child.status, theme)} ${theme.fg("accent", theme.bold(child.id))} ${theme.fg("muted", `${child.profile} · ${child.model} · ${child.thinking}`)}`, 0, 0));
    container.addChild(new Text(theme.fg("muted", "Assignment: ") + theme.fg("dim", child.goal), 0, 0));
    container.addChild(new Text(theme.fg("muted", "Budget: ") + theme.fg("dim", `${child.timeoutSeconds}s · ${child.tools.join(", ") || "no tools"}`), 0, 0));
    if (child.activity.length) {
      const activity = child.activity.map((item) => `  ${item.type === "tool" ? "→" : "·"} ${item.text}`).join("\n");
      container.addChild(new Text(theme.fg("dim", activity), 0, 0));
    }
    if (child.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${child.errorMessage}`), 0, 0));
    if (child.resumeHandle) container.addChild(new Text(theme.fg("warning", `Short resume: ${child.resumeHandle} · 30-180s · use only if close to completion`), 0, 0));
    if (child.finalText) {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(child.finalText, 0, 0, getMarkdownTheme()));
    }
    if (child.artifactPath) container.addChild(new Text(theme.fg("dim", `Full output: ${child.artifactPath}`), 0, 0));
    container.addChild(new Text(theme.fg("dim", `${child.usage.turns} turns · ${tokens(child.usage.totalTokens)} tokens · $${child.usage.cost.toFixed(4)} · ${seconds(child.durationMs)}/${child.timeoutSeconds}s`), 0, 0));
  }
  return container;
}

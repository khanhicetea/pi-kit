import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { DEFAULT_CHILD_TIMEOUT_SECONDS, DEFAULT_RESUME_TIMEOUT_SECONDS } from "./schema.ts";
import type { ChildStatus, DedeActivity, DedeChildResult, DedeDelegateParams, DedeToolDetails } from "./types.ts";

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

function countStatus(results: readonly DedeChildResult[], status: ChildStatus): number {
  return results.filter((child) => child.status === status).length;
}

function outcomeBreakdown(results: readonly DedeChildResult[]): string {
  const labels: Array<[ChildStatus, string]> = [
    ["timed_out", "timed out"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];
  return labels
    .map(([status, label]) => [countStatus(results, status), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
}

function activityPreview(activity: readonly DedeActivity[], max = 12): string {
  const visible = activity.slice(-max);
  const omitted = activity.length - visible.length;
  const lines = visible.map((item) => `  ${item.type === "tool" ? "→" : "·"} ${preview(item.text, 140)}`);
  if (omitted > 0) lines.unshift(`  … ${omitted} earlier event${omitted === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export function renderDedeCall(args: DedeDelegateParams, theme: any, context: any): Text {
  const agents = args.agents ?? [];
  const mode = agents[0]?.resume ? "short resume" : agents.length > 1 ? "parallel evidence" : agents[0]?.profile === "worker" ? "worker" : "single evidence";
  const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  let text = theme.fg("toolTitle", theme.bold("Đệ Đệ  ")) + theme.fg("accent", `${mode} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`);
  if (args.objective) text += `\n  ${theme.fg("muted", "objective · ")}${theme.fg("dim", preview(args.objective, 100))}`;
  for (const agent of agents) {
    const profile = agent.resume ? "existing profile" : agent.profile ?? "custom";
    const preset = agent.resume ? "existing capabilities" : agent.toolPreset ?? (profile === "worker" ? "coding" : "read-only");
    const timeout = agent.timeoutSeconds ?? args.timeoutSeconds ?? (agent.resume ? DEFAULT_RESUME_TIMEOUT_SECONDS : DEFAULT_CHILD_TIMEOUT_SECONDS);
    const resume = agent.resume ? ` · resume ${preview(agent.resume, 18)}` : "";
    text += `\n  ${theme.fg("accent", agent.id)} ${theme.fg("muted", `· ${profile} · ${preset} · ${timeout}s${resume}`)}`;
    text += `\n    ${theme.fg("dim", preview(agent.goal, 110))}`;
  }
  component.setText(text);
  return component;
}

function icon(status: ChildStatus, theme: any): string {
  if (status === "succeeded") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "timed_out") return theme.fg("warning", "◷");
  if (status === "cancelled") return theme.fg("muted", "■");
  if (status === "running") return theme.fg("warning", "●");
  return theme.fg("muted", "○");
}

function aggregateIcon(status: DedeToolDetails["status"], theme: any): string {
  if (status === "succeeded") return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "cancelled") return theme.fg("muted", "■");
  return theme.fg("warning", "◐");
}

export function renderDedeResult(result: any, options: any, theme: any, context: any): Text | Container {
  const details = result.details as DedeToolDetails | undefined;
  if (!details?.results?.length) {
    const raw = result.content?.find((part: any) => part.type === "text")?.text ?? "(no output)";
    return new Text(raw, 0, 0);
  }

  const done = details.results.filter((child) => !["queued", "running"].includes(child.status)).length;
  const running = countStatus(details.results, "running");
  const queued = countStatus(details.results, "queued");
  const succeeded = countStatus(details.results, "succeeded");
  const totalTokens = details.results.reduce((sum, child) => sum + child.usage.totalTokens, 0);
  const totalTurns = details.results.reduce((sum, child) => sum + child.usage.turns, 0);
  const totalCost = details.results.reduce((sum, child) => sum + child.usage.cost, 0);

  if (options.isPartial) {
    const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    const queueLabel = queued ? ` · ${queued} queued` : "";
    let text = theme.fg("toolTitle", theme.bold("Đệ Đệ  ")) + theme.fg("accent", `${done}/${details.results.length} done · ${running} running${queueLabel}`) + theme.fg("dim", ` · ${seconds(details.durationMs)} · Esc to cancel`);
    for (const child of details.results) {
      const latest = child.activity.at(-1)?.text ?? child.status;
      const runtime = `${child.resumedFrom ? "resumed · " : ""}${child.profile} · ${child.model} · ${child.thinking} · ${seconds(child.durationMs)}/${child.timeoutSeconds}s`;
      text += `\n  ${icon(child.status, theme)} ${theme.fg("accent", child.id)} ${theme.fg("muted", `· ${runtime}`)}`;
      text += `\n    ${theme.fg("dim", preview(latest, 120))}`;
    }
    component.setText(text);
    return component;
  }

  if (!options.expanded) {
    const breakdown = outcomeBreakdown(details.results);
    const aggregate = `${succeeded}/${details.results.length} succeeded${breakdown ? ` · ${breakdown}` : ""}`;
    let text = `${aggregateIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold("Đệ Đệ  "))}${theme.fg("accent", aggregate)}${theme.fg("dim", ` · ${tokens(totalTokens)} tok · ${seconds(details.durationMs)}`)}`;
    for (const child of details.results) {
      const first = child.finalText.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).slice(0, 2).join(" ");
      const stats = `${child.profile} · ${child.usage.turns} turns · ${tokens(child.usage.totalTokens)} tok${child.usage.cost ? ` · $${child.usage.cost.toFixed(4)}` : ""} · ${seconds(child.durationMs)}`;
      text += `\n\n  ${icon(child.status, theme)} ${theme.fg("accent", child.id)} ${theme.fg("muted", `· ${child.status} · ${stats}`)}`;
      text += `\n    ${theme.fg("toolOutput", preview(first || child.errorMessage || "(no output)", 100))}`;
      if (child.sessionId) text += `\n    ${theme.fg("dim", `session ${child.sessionId} · pi --session ${child.sessionId}`)}`;
    }
    return new Text(text, 0, 0);
  }

  const container = new Container();
  const breakdown = outcomeBreakdown(details.results);
  const aggregate = `${succeeded}/${details.results.length} succeeded${breakdown ? ` · ${breakdown}` : ""}`;
  container.addChild(new Text(`${aggregateIcon(details.status, theme)} ${theme.fg("toolTitle", theme.bold("Đệ Đệ  "))}${theme.fg("accent", aggregate)} ${theme.fg("dim", `· ${totalTurns} turns · ${tokens(totalTokens)} tokens${totalCost ? ` · $${totalCost.toFixed(4)}` : ""} · ${seconds(details.durationMs)}`)}`, 0, 0));
  const args = context.args as DedeDelegateParams | undefined;
  if (args?.objective) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Master-owned objective: ") + theme.fg("dim", args.objective), 0, 0));
  }

  for (const child of details.results) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(`${icon(child.status, theme)} ${theme.fg("accent", theme.bold(child.id))} ${theme.fg("muted", `${child.status} · ${child.profile} · ${child.model} · ${child.thinking}`)}`, 0, 0));
    container.addChild(new Text(theme.fg("muted", "Assignment: ") + theme.fg("dim", child.goal), 0, 0));
    container.addChild(new Text(theme.fg("muted", "Budget: ") + theme.fg("dim", `${child.timeoutSeconds}s · ${child.tools.join(", ") || "no tools"}`), 0, 0));
    if (child.sessionId) container.addChild(new Text(theme.fg("muted", "Session: ") + theme.fg("dim", `${child.sessionId} · inspect with pi --session ${child.sessionId}`), 0, 0));
    if (child.activity.length) container.addChild(new Text(theme.fg("dim", activityPreview(child.activity)), 0, 0));
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

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ResolvedAgent } from "./types.ts";

export interface PiInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function resolvePiExecutable(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface ChildInvocationOptions {
  agent: ResolvedAgent;
  systemPromptPath: string;
  taskPath: string;
  runId: string;
  parentSessionId: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildChildInvocation(options: ChildInvocationOptions): PiInvocation {
  const { agent } = options;
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--system-prompt", "You are an isolated delegated Pi sub-agent.",
    "--append-system-prompt", options.systemPromptPath,
  ];

  if (agent.tools.length === 0) args.push("--no-tools");
  else args.push("--tools", agent.tools.join(","));
  args.push("--model", agent.model, "--thinking", agent.thinking);
  args.push(`@${options.taskPath}`, "Complete the delegated task in the attached task file.");

  const invocation = resolvePiExecutable(args);
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  env.PI_DEDE_DEPTH = "1";
  env.PI_DEDE_RUN_ID = options.runId;
  env.PI_DEDE_AGENT_ID = agent.id;
  env.PI_DEDE_PARENT_SESSION_ID = options.parentSessionId;

  return { ...invocation, env };
}

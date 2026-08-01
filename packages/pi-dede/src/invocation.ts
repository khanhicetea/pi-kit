import { existsSync } from "node:fs";
import { basename } from "node:path";
import { mergeChildEnv, removeReservedChildEnv } from "./env.ts";
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
  sessionDirectory: string;
  sessionPath: string;
  childSessionId: string;
  isResume?: boolean;
  runId: string;
  parentSessionId: string;
  additionalArgs?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildChildInvocation(options: ChildInvocationOptions): PiInvocation {
  const { agent } = options;
  const args = [
    "--mode", "json",
    "--print",
    "--session-dir", options.sessionDirectory,
    "--session", options.sessionPath,
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
  args.push(...(options.additionalArgs ?? []));
  args.push(
    `@${options.taskPath}`,
    options.isResume
      ? "Continue the previous delegated task using the short extension in the attached task file."
      : "Complete the delegated task in the attached task file.",
  );

  const invocation = resolvePiExecutable(args);
  const env: NodeJS.ProcessEnv = mergeChildEnv([options.baseEnv ?? process.env, agent.env]);
  removeReservedChildEnv(env);
  env.PI_DEDE_DEPTH = "1";
  env.PI_DEDE_RUN_ID = options.runId;
  env.PI_DEDE_AGENT_ID = agent.id;
  env.PI_DEDE_PARENT_SESSION_ID = options.parentSessionId;
  env.PI_DEDE_CHILD_SESSION_ID = options.childSessionId;
  env.PI_DEDE_RESUME_ATTEMPT = String(agent.resume?.attempt ?? 0);

  return { ...invocation, env };
}

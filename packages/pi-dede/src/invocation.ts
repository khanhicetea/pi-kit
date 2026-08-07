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
  sessionDirectory: string;
  sessionPath: string;
  childSessionId: string;
  runId: string;
  parentSessionId: string;
  additionalArgs?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the headless RPC-mode invocation for one delegated child.
 *
 * Children run `pi --mode rpc`. The task assignment is delivered over the RPC
 * stdin channel (a `prompt` command), never as an argument, so no user-controlled
 * text appears in `argv`. The role contract is appended from a private
 * mode-`0600` file via `--append-system-prompt`, which Pi reads as file contents.
 */
export function buildChildInvocation(options: ChildInvocationOptions): PiInvocation {
  const { agent } = options;
  const args = [
    "--mode", "rpc",
    "--session-dir", options.sessionDirectory,
    "--session", options.sessionPath,
    "--no-approve",
    "--no-prompt-templates",
    "--no-themes",
    "--system-prompt", "You are an isolated delegated Pi sub-agent.",
    "--append-system-prompt", options.systemPromptPath,
  ];

  if (agent.tools.length === 0) args.push("--no-tools");
  else args.push("--tools", agent.tools.join(","));
  args.push("--model", agent.model, "--thinking", agent.thinking);
  args.push(...(options.additionalArgs ?? []));

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

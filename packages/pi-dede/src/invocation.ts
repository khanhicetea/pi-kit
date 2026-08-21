import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
 * text appears in `argv`. Isolated children append their private role contract;
 * forked children load the captured master prompt and restore it exactly from
 * the internal child bootstrap immediately before the agent turn.
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
    "--extension", fileURLToPath(new URL("./child-bootstrap.ts", import.meta.url)),
  ];

  const visibleTools = agent.resolvedContextMode === "fork" ? (agent.visibleTools ?? []) : agent.tools;
  if (agent.resolvedContextMode === "fork") args.push("--system-prompt", options.systemPromptPath);
  else args.push(
    "--system-prompt", "You are an isolated delegated Pi sub-agent.",
    "--append-system-prompt", options.systemPromptPath,
  );
  if (visibleTools.length === 0) args.push("--no-tools");
  else args.push("--tools", visibleTools.join(","));
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
  env.PI_DEDE_CONTINUATION_INDEX = String(agent.continueFrom?.continuationIndex ?? agent.resume?.continuationIndex ?? 0);
  env.PI_DEDE_CONTEXT_MODE = agent.resolvedContextMode;
  env.PI_DEDE_CHILD_BOOTSTRAP = "1";
  env.PI_DEDE_ALLOWED_TOOLS = JSON.stringify(agent.tools);
  if (agent.cacheAffinityKey) env.PI_DEDE_CACHE_AFFINITY_KEY = agent.cacheAffinityKey;
  if (agent.resolvedContextMode === "fork") env.PI_DEDE_MASTER_SYSTEM_PROMPT_PATH = options.systemPromptPath;

  return { ...invocation, env };
}

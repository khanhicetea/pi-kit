import { createWriteStream } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { finished as streamFinished } from "node:stream/promises";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing Herdr supervisor config path");

const config = JSON.parse(await readFile(configPath, "utf8"));
const managedHerdrNames = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
];
const childEnv = { ...config.env };
for (const name of managedHerdrNames) {
  if (process.env[name] === undefined) delete childEnv[name];
  else childEnv[name] = process.env[name];
}

let child;
let finished = false;
let lastCancelSignal;
const DISPLAY_LINE_CAP = 2 * 1024 * 1024;
let displayBuffer = "";
let droppingDisplayLine = false;
let cancelPoll;
const activeTools = new Map();
const stdoutSpool = createWriteStream(config.stdoutPath, { flags: "a", mode: 0o600 });
const stderrSpool = createWriteStream(config.stderrPath, { flags: "a", mode: 0o600 });

async function atomicCompletion(value) {
  const temporary = `${config.completionPath}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, config.completionPath);
}

function signalTree(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function terminalSafe(value) {
  // Child/repository text is untrusted. Strip terminal control bytes while
  // preserving ordinary whitespace; exact unsanitized bytes remain in spools.
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function short(value, max = 120) {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

function displayPath(value) {
  const raw = String(value ?? "");
  const home = homedir();
  return raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
}

function describeTool(event) {
  const name = String(event.toolName ?? "tool");
  const args = event.args && typeof event.args === "object" ? event.args : {};
  if (name === "read") {
    const path = displayPath(args.path ?? args.file_path ?? "file");
    const range = args.offset ? `:${args.offset}${args.limit ? `-${Number(args.offset) + Number(args.limit) - 1}` : ""}` : "";
    return `read ${short(path, 100)}${range}`;
  }
  if (name === "grep") {
    const scope = args.path ? ` in ${displayPath(args.path)}` : "";
    return `grep /${short(args.pattern ?? "", 70)}/${short(scope, 80)}`;
  }
  if (name === "find") {
    const scope = args.path ? ` in ${displayPath(args.path)}` : "";
    return `find ${short(args.pattern ?? "*", 80)}${short(scope, 80)}`;
  }
  if (name === "ls") return `ls ${short(displayPath(args.path ?? "."), 100)}`;
  if (name === "bash") return `$ ${short(args.command ?? "", 140)}`;
  if (name === "edit") {
    const count = Array.isArray(args.edits) ? ` · ${args.edits.length} replacement${args.edits.length === 1 ? "" : "s"}` : "";
    return `edit ${short(displayPath(args.path ?? args.file_path ?? "file"), 100)}${count}`;
  }
  if (name === "write") return `write ${short(displayPath(args.path ?? args.file_path ?? "file"), 100)}`;
  return `${name} ${short(args, 120)}`.trim();
}

function displayLine(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (event.type === "tool_execution_start") {
      const description = describeTool(event);
      if (event.toolCallId) activeTools.set(event.toolCallId, description);
      process.stdout.write(`\u001b[36m→ ${terminalSafe(description)}\u001b[0m\n`);
      return;
    }
    if (event.type === "tool_execution_end") {
      const description = activeTools.get(event.toolCallId) ?? describeTool(event);
      if (event.toolCallId) activeTools.delete(event.toolCallId);
      if (event.isError) process.stdout.write(`\u001b[31m✗ ${terminalSafe(description)}\u001b[0m\n`);
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = event.message.content
        ?.filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (text) process.stdout.write(`\n${terminalSafe(text)}\n`);
      return;
    }
    if (event.type === "agent_end") process.stdout.write("\n\u001b[32mDone\u001b[0m\n");
  } catch {
    process.stdout.write(`${terminalSafe(line)}\n`);
  }
}

function appendDisplayPart(part, endsLine) {
  if (!droppingDisplayLine) {
    displayBuffer += part;
    if (displayBuffer.length > DISPLAY_LINE_CAP) {
      process.stdout.write("[pi-dede omitted an oversized output line]\n");
      displayBuffer = "";
      droppingDisplayLine = true;
    }
  }
  if (endsLine) {
    if (!droppingDisplayLine) displayLine(displayBuffer.replace(/\r$/, ""));
    displayBuffer = "";
    droppingDisplayLine = false;
  }
}

function displayStdout(chunk) {
  const text = chunk.toString("utf8");
  let start = 0;
  let newline;
  while ((newline = text.indexOf("\n", start)) >= 0) {
    appendDisplayPart(text.slice(start, newline), true);
    start = newline + 1;
  }
  if (start < text.length) appendDisplayPart(text.slice(start), false);
}

async function finish(value) {
  if (finished) return;
  finished = true;
  if (cancelPoll) clearInterval(cancelPoll);
  if (displayBuffer && !droppingDisplayLine) displayLine(displayBuffer);
  stdoutSpool.end();
  stderrSpool.end();
  await Promise.allSettled([streamFinished(stdoutSpool), streamFinished(stderrSpool)]);
  try { await atomicCompletion(value); }
  catch (error) { process.stderr.write(`pi-dede: failed to record completion: ${error.message}\n`); }
}

// Clear the shell command submitted by `herdr pane run`; the pane should show
// delegated activity rather than supervisor implementation details.
process.stdout.write(`\u001b[2J\u001b[H\u001b[1mĐệ Đệ · ${config.label}\u001b[0m\n\n`);

try {
  child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: childEnv,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    if (!stdoutSpool.write(chunk)) {
      child.stdout.pause();
      stdoutSpool.once("drain", () => child.stdout.resume());
    }
    displayStdout(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (!stderrSpool.write(chunk)) {
      child.stderr.pause();
      stderrSpool.once("drain", () => child.stderr.resume());
    }
    process.stderr.write(terminalSafe(chunk.toString("utf8")));
  });
  child.once("error", (error) => void finish({ error: error.message }));
  child.once("close", (code, signal) => void finish({
    ...(code !== null ? { exitCode: code } : {}),
    ...(signal ? { signal } : {}),
  }));
} catch (error) {
  await finish({ error: error instanceof Error ? error.message : String(error) });
}

cancelPoll = setInterval(async () => {
  try {
    const signal = (await readFile(config.cancelPath, "utf8")).trim();
    if (signal && signal !== lastCancelSignal) {
      lastCancelSignal = signal;
      signalTree(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    }
  } catch { /* no cancellation request */ }
}, 50);
cancelPoll.unref?.();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => signalTree("SIGTERM"));
}

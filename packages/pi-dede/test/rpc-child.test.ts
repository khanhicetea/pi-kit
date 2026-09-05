import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { RpcChild } from "../src/rpc-child.ts";

let processDouble: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
beforeEach(() => {
  processDouble = Object.assign(new EventEmitter(), {
    pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  mocked.spawn.mockReturnValue(processDouble);
});
const create = () => new RpcChild({ invocation: { command: "fake", args: [], env: {} }, cwd: "/tmp" });

describe("RPC rejection lifecycle", () => {
  it("settles a rejected initial prompt without waiting for process exit", async () => {
    const child = create();
    child.prompt("task");
    processDouble.stdout.write('{"type":"response","command":"prompt","id":"dede-task","success":false,"error":"not accepted"}\n');
    await expect(child.done).resolves.toMatchObject({ settled: false, closed: false, promptRejected: "not accepted" });
    child.close();
    child.detachOutput();
  });

  it("does not confuse another command response with the task rejection", async () => {
    const child = create();
    processDouble.stdout.write('{"type":"response","command":"prompt","id":"other","success":false}\n');
    processDouble.stdout.write('{"type":"agent_settled"}\n');
    const outcome = await child.done;
    expect(outcome.settled).toBe(true);
    expect(outcome.promptRejected).toBeUndefined();
    child.close();
    child.detachOutput();
  });

  it("does not deliver a queued prompt after disposal", async () => {
    const child = create();
    const write = vi.spyOn(processDouble.stdin, "write");
    child.prompt("must not run");
    child.close();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    child.detachOutput();
  });
});

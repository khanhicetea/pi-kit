import { describe, expect, it } from "vitest";
import { FifoSemaphore } from "../src/scheduler.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FifoSemaphore", () => {
  it("enforces capacity and starts queued work in FIFO order", async () => {
    const semaphore = new FifoSemaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    const order: number[] = [];
    const thirdPromise = semaphore.acquire().then((permit) => { order.push(3); return permit; });
    const fourthPromise = semaphore.acquire().then((permit) => { order.push(4); return permit; });

    expect(semaphore.active).toBe(2);
    expect(semaphore.queued).toBe(2);
    first.release();
    const third = await thirdPromise;
    expect(order).toEqual([3]);
    second.release();
    const fourth = await fourthPromise;
    expect(order).toEqual([3, 4]);
    third.release();
    fourth.release();
    expect(semaphore.active).toBe(0);
  });

  it("removes an aborted waiter without consuming a slot", async () => {
    const semaphore = new FifoSemaphore(1);
    const first = await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.queued).toBe(0);
    expect(semaphore.active).toBe(1);
    first.release();
    await tick();
    expect(semaphore.active).toBe(0);
  });

  it("releases only once and cancels every queued waiter", async () => {
    const semaphore = new FifoSemaphore(1);
    const first = await semaphore.acquire();
    const a = semaphore.acquire();
    const b = semaphore.acquire();
    semaphore.cancelQueued();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    first.release();
    first.release();
    expect(semaphore.active).toBe(0);
  });
});

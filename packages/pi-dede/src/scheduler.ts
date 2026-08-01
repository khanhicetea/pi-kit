export interface SemaphorePermit {
  release(): void;
}

interface Waiter {
  resolve: (permit: SemaphorePermit) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function abortError(message = "Delegation cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Abort-aware FIFO semaphore shared by every tool call in one extension runtime. */
export class FifoSemaphore {
  private activeCount = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly capacity: number,
    private readonly onChange?: (active: number, queued: number) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be positive");
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<SemaphorePermit> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<SemaphorePermit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(abortError());
            this.changed();
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.dispatch();
    });
  }

  cancelQueued(reason = "Delegation runtime shut down"): void {
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError(reason));
    }
    this.changed();
  }

  private dispatch(): void {
    while (this.activeCount < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.activeCount++;
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.activeCount--;
          this.dispatch();
          this.changed();
        },
      });
    }
    this.changed();
  }

  private changed(): void {
    this.onChange?.(this.activeCount, this.queue.length);
  }
}

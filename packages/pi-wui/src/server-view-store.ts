import type { PortalView, WuiInputResult } from "./shared/protocol";

interface PendingInput {
  viewId: string;
  requestId: string;
  resolve: (result: WuiInputResult) => void;
  timeout?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

export interface FeedbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Session-scoped view index and feedback promise lifecycle. */
export class ViewFeedbackStore {
  readonly views = new Map<string, PortalView>();
  readonly pendingInputs = new Map<string, PendingInput>();
  activeViewId: string | undefined;

  createPending(view: PortalView, requestId: string, options: FeedbackOptions): Promise<WuiInputResult> {
    return new Promise<WuiInputResult>((resolve) => {
      const pending: PendingInput = {
        viewId: view.id,
        requestId,
        resolve,
        ...(options.signal ? { abortSignal: options.signal } : {}),
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timeout = setTimeout(
          () => this.finish(requestId, { status: "timed-out", viewId: view.id, requestId }),
          options.timeoutMs,
        );
        pending.timeout.unref();
      }
      if (options.signal) {
        pending.abortListener = () => this.finish(requestId, { status: "aborted", viewId: view.id, requestId });
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pendingInputs.set(requestId, pending);
    });
  }

  finish(requestId: string, result: WuiInputResult): void {
    const pending = this.pendingInputs.get(requestId);
    if (!pending) return;
    this.pendingInputs.delete(requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.abortSignal && pending.abortListener)
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    const view = this.views.get(pending.viewId);
    if (view && result.status !== "submitted") {
      view.status = result.status === "timed-out" ? "timed-out" : "cancelled";
      view.updatedAt = Date.now();
    }
    pending.resolve(result);
  }

  end(reason: WuiInputResult["status"] = "session-ended"): void {
    for (const [requestId, pending] of [...this.pendingInputs])
      this.finish(requestId, { status: reason, viewId: pending.viewId, requestId } as WuiInputResult);
  }
}

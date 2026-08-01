import type { CreateViewInput, CreateViewResult, ViewStateResult, WuiServer } from "./server";
import type { WuiInputResult } from "./shared/protocol";
import type { ReadStateParams, UpdateStateParams, UploadAssetsParams, WuiParams } from "./tool-contracts";

/** Host-neutral adapter shared by the Pi extension and MCP transport. */
export class WuiServiceAdapter {
  constructor(
    private readonly ensureServer: () => Promise<WuiServer>,
    private readonly requireServer: () => WuiServer,
  ) {}

  async createView(params: WuiParams, signal?: AbortSignal): Promise<CreateViewResult> {
    const server = await this.ensureServer();
    return server.createView(toCreateViewInput(params, signal));
  }

  async uploadAssets(params: UploadAssetsParams) {
    return (await this.ensureServer()).uploadAssets(params.paths);
  }

  readState(params: ReadStateParams): ViewStateResult {
    return this.requireServer().readState(params.viewId, params.path);
  }

  updateState(params: UpdateStateParams): ViewStateResult {
    return this.requireServer().updateState(params.viewId, params.operations);
  }
}

export function toCreateViewInput(params: WuiParams, signal?: AbortSignal): CreateViewInput {
  return {
    title: params.title,
    ...(params.spec ? { spec: params.spec } : {}),
    ...(params.assets ? { assets: params.assets } : {}),
    ...(params.html ? { html: params.html } : {}),
    ...(params.columns !== undefined ? { columns: params.columns } : {}),
    ...(params.viewId ? { viewId: params.viewId } : {}),
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.feedback
      ? {
          feedback: {
            timeoutMs: (params.feedback.timeoutSeconds ?? 600) * 1000,
            ...(signal ? { signal } : {}),
          },
        }
      : {}),
  };
}

export function stateResult(result: ViewStateResult, path?: string): Record<string, unknown> {
  return path === undefined
    ? { viewId: result.id, revision: result.revision, state: result.state }
    : { viewId: result.id, revision: result.revision, path, value: result.value };
}

export function feedbackResult(result: WuiInputResult): Record<string, unknown> {
  return result.status === "submitted"
    ? { status: "submitted", viewId: result.viewId, params: result.params, state: result.state }
    : result;
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildRuntime } from "./child-runtime.ts";

/** Explicitly loaded into every child so enforcement never depends on package discovery. */
export default function childBootstrap(pi: ExtensionAPI): void {
  registerChildRuntime(pi);
}

import assert from "node:assert/strict";
import test from "node:test";
import { canOpenBrowser, isCmuxShell } from "../src/host-capabilities";

test("Linux requires a graphical display to open a browser", () => {
  assert.equal(canOpenBrowser({}, "linux"), false);
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(canOpenBrowser({ MIR_SOCKET: "/run/user/1000/mir_socket" }, "linux"), true);
});

test("remote macOS and Windows sessions copy instead of opening", () => {
  assert.equal(canOpenBrowser({}, "darwin"), true);
  assert.equal(canOpenBrowser({}, "win32"), true);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: "client server" }, "darwin"), false);
  assert.equal(canOpenBrowser({ MOSH_CONNECTION: "client server" }, "win32"), false);
});

test("cmux shell integration can open a browser split", () => {
  assert.equal(isCmuxShell({ CMUX_SHELL_INTEGRATION: "1" }), true);
  assert.equal(isCmuxShell({ CMUX_SHELL_INTEGRATION: "0" }), false);
  assert.equal(canOpenBrowser({ CMUX_SHELL_INTEGRATION: "1", SSH_CONNECTION: "client server" }, "darwin"), true);
});

test("unsupported hosts do not claim browser support", () => {
  assert.equal(canOpenBrowser({}, "freebsd"), false);
});

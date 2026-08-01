export function isCmuxShell(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CMUX_SHELL_INTEGRATION === "1";
}

export function canOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isCmuxShell(env)) return true;

  if (platform === "linux") {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
  }

  const remoteSession = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.MOSH_CONNECTION);
  if (remoteSession) return false;

  return platform === "darwin" || platform === "win32";
}

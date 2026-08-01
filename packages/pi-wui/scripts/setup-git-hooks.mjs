import { spawnSync } from "node:child_process";

const insideWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  stdio: "ignore",
});

// npm registry installs do not have a Git worktree, so there is nothing to configure.
if (insideWorkTree.status !== 0) process.exit(0);

const configured = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});

if (configured.error) throw configured.error;
process.exit(configured.status ?? 1);

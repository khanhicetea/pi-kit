import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: npm run release -- <semver>");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (git("status", "--short")) {
  throw new Error("Release from a clean worktree so generated bundles and manifests cannot hide unrelated changes.");
}
if (git("tag", "--list", `v${version}`)) {
  throw new Error(`Tag v${version} already exists.`);
}

const packageRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);

async function updateJson(url, update) {
  const value = JSON.parse(await readFile(url, "utf8"));
  update(value);
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
}

await updateJson(new URL("package.json", packageRoot), (value) => {
  value.version = version;
});
await updateJson(new URL("package-lock.json", repositoryRoot), (value) => {
  const workspace = value.packages?.["packages/pi-wui"];
  if (!workspace) throw new Error("Root package-lock.json is missing the packages/pi-wui workspace entry.");
  workspace.version = version;
});
await updateJson(new URL(".codex-plugin/plugin.json", packageRoot), (value) => {
  value.version = version;
});

execFileSync("npm", ["run", "check"], { stdio: "inherit", cwd: packageRoot });
console.log(`\nRelease ${version} is ready. Review the diff, commit it, then create tag v${version}.`);

import { readFile } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

const [packageJson, packageLock, plugin, mcpSource] = await Promise.all([
  readJson(new URL("package.json", packageRoot)),
  readJson(new URL("package-lock.json", repositoryRoot)),
  readJson(new URL(".codex-plugin/plugin.json", packageRoot)),
  readFile(new URL("src/mcp.ts", packageRoot), "utf8"),
]);
const versions = {
  "package.json": packageJson.version,
  "package-lock.json workspace": packageLock.packages?.["packages/pi-wui"]?.version,
  ".codex-plugin/plugin.json": plugin.version,
};
const expected = packageJson.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  throw new Error(`Invalid package version: ${expected}`);
}

if (!mcpSource.includes("const VERSION = packageJson.version;")) {
  throw new Error("src/mcp.ts must read its version from package.json instead of duplicating a literal.");
}

const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  throw new Error(
    `Release version mismatch; expected ${expected}: ${mismatches.map(([file, version]) => `${file}=${version}`).join(", ")}`,
  );
}

console.log(`Release manifests agree on ${expected}.`);

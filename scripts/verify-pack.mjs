import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(
  npmCommand,
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);

if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

const reports = JSON.parse(packed.stdout);
assert.equal(reports.length, 1, "npm pack must report exactly one package");

const actualPaths = reports[0].files.map(({ path }) => path).sort();
const expectedPaths = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/config/contracts.d.ts",
  "dist/config/contracts.d.ts.map",
  "dist/config/contracts.js",
  "dist/config/contracts.js.map",
  "dist/config/index.d.ts",
  "dist/config/index.d.ts.map",
  "dist/config/index.js",
  "dist/config/index.js.map",
  "dist/core/index.d.ts",
  "dist/core/index.d.ts.map",
  "dist/core/index.js",
  "dist/core/index.js.map",
  "dist/core/job-events.d.ts",
  "dist/core/job-events.d.ts.map",
  "dist/core/job-events.js",
  "dist/core/job-events.js.map",
  "dist/core/job-reducer.d.ts",
  "dist/core/job-reducer.d.ts.map",
  "dist/core/job-reducer.js",
  "dist/core/job-reducer.js.map",
  "dist/core/state-machine.d.ts",
  "dist/core/state-machine.d.ts.map",
  "dist/core/state-machine.js",
  "dist/core/state-machine.js.map",
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/index.js",
  "dist/index.js.map",
  "docs/COMPATIBILITY.md",
  "package.json",
  "schema/config.schema.json",
].sort();

assert.deepEqual(
  actualPaths,
  expectedPaths,
  "packed files must exactly match the reviewed public artifact allowlist",
);

console.log(`Verified ${actualPaths.length} packed files.`);

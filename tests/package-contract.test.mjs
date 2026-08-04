import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the package metadata fixes the Phase 0 toolchain contract", () => {
  assert.equal(manifest.name, "@actiondata/pi-delivery");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.packageManager, "npm@10.9.7");
  assert.equal(manifest.private, true);
  assert.equal(manifest.devDependencies.typescript, "5.9.3");
  assert.equal(manifest.devDependencies["@types/node"], "22.20.1");
});

test("the scaffold has no runtime dependencies or operational entry points", () => {
  assert.equal("dependencies" in manifest, false);
  assert.equal("optionalDependencies" in manifest, false);
  assert.equal("bin" in manifest, false);
  assert.equal("pi" in manifest, false);
  assert.equal("publishConfig" in manifest, false);
  assert.equal("pack:check" in manifest.scripts, true);
});

test("public exports resolve only to built artifacts and the public schema", async () => {
  assert.deepEqual(Object.keys(manifest.exports), [
    ".",
    "./core",
    "./config",
    "./store",
    "./schema/config.schema.json",
  ]);

  for (const target of Object.values(manifest.exports)) {
    for (const path of typeof target === "string" ? [target] : Object.values(target)) {
      assert.equal(path.startsWith("./dist/") || path.startsWith("./schema/"), true);
    }
  }

  const [root, core, config, store, schema] = await Promise.all([
    import("@actiondata/pi-delivery"),
    import("@actiondata/pi-delivery/core"),
    import("@actiondata/pi-delivery/config"),
    import("@actiondata/pi-delivery/store"),
    import("@actiondata/pi-delivery/schema/config.schema.json", {
      with: { type: "json" },
    }),
  ]);

  assert.equal(root.reduceJobState, core.reduceJobState);
  assert.equal(root.parseJobEvent, core.parseJobEvent);
  assert.equal(root.parseJobSnapshot, core.parseJobSnapshot);
  assert.equal(root.reduceJobEvent, core.reduceJobEvent);
  assert.equal(root.replayJobEvents, core.replayJobEvents);
  assert.equal(root.JOB_EVENT_VERSION, 1);
  assert.equal(root.JOB_SNAPSHOT_VERSION, 1);
  assert.equal(root.openSqliteJobStore, store.openSqliteJobStore);
  assert.equal(root.JOB_STORE_SCHEMA_VERSION, 1);
  assert.equal(root.CONFIG_SCHEMA_VERSION, config.CONFIG_SCHEMA_VERSION);
  assert.equal(schema.default.properties.schemaVersion.const, 1);
});

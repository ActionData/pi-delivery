import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CONFIG_SCHEMA_VERSION } from "../dist/config/index.js";

const schema = JSON.parse(
  await readFile(new URL("../schema/config.schema.json", import.meta.url), "utf8"),
);

test("the TypeScript and JSON Schema contracts share one version", () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 1);
  assert.equal(schema.properties.schemaVersion.const, CONFIG_SCHEMA_VERSION);
});

test("the draft schema exposes provider-native tracker queries and GitHub delivery", () => {
  assert.deepEqual(schema.properties.tracker.properties.kind.enum, [
    "github",
    "linear",
    "jira",
  ]);
  assert.deepEqual(
    schema.properties.tracker.properties.candidateQuery.oneOf.map(
      ({ type }) => type,
    ),
    ["string", "object"],
  );
  assert.equal(schema.properties.forge.properties.kind.const, "github");
});

test("the draft schema fixes its minimal object boundaries", () => {
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "project",
    "tracker",
    "forge",
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.project.additionalProperties, false);
  assert.equal(schema.properties.tracker.additionalProperties, false);
  assert.equal(schema.properties.forge.additionalProperties, false);

  const repositoryPattern = new RegExp(
    schema.properties.project.properties.repository.pattern,
  );
  assert.equal(repositoryPattern.test("ActionData/pi-delivery"), true);
  assert.equal(repositoryPattern.test("missing-owner"), false);
  assert.equal(repositoryPattern.test("too/many/parts"), false);
  assert.equal(schema.properties.project.properties.defaultBranch.minLength, 1);
});

test("the draft schema contains no credential or execution contract", () => {
  const serialized = JSON.stringify(schema).toLowerCase();

  for (const forbidden of [
    "token",
    "password",
    "secret",
    "command",
    "deploy",
    "merge",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

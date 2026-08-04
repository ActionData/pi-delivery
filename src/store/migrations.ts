import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  JobStoreCorruptionError,
  UnsupportedJobStoreSchemaError,
} from "./errors.js";

export const JOB_STORE_APPLICATION_ID = 0x5049444c;
export const JOB_STORE_SCHEMA_VERSION = 1 as const;

const MAX_SAFE_INTEGER_SQL = "9007199254740991";

const createMigrationsTableSql = `
CREATE TABLE store_migrations (
  version INTEGER PRIMARY KEY CHECK(version >= 1 AND version <= ${MAX_SAFE_INTEGER_SQL}),
  name TEXT NOT NULL UNIQUE CHECK(length(name) > 0),
  sql_sha256 TEXT NOT NULL CHECK(length(sql_sha256) = 64)
) STRICT, WITHOUT ROWID
`;

const createEventsTableSql = `
CREATE TABLE job_events (
  job_id TEXT NOT NULL CHECK(length(job_id) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= ${MAX_SAFE_INTEGER_SQL}),
  event_id TEXT NOT NULL CHECK(length(event_id) > 0),
  event_version INTEGER NOT NULL CHECK(event_version >= 1 AND event_version <= ${MAX_SAFE_INTEGER_SQL}),
  event_type TEXT NOT NULL CHECK(length(event_type) > 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json) = 1),
  PRIMARY KEY (job_id, revision)
) STRICT, WITHOUT ROWID
`;

const createEventIdIndexSql = `
CREATE UNIQUE INDEX job_events_job_event_id_uq
ON job_events (job_id, event_id)
`;

const createSnapshotsTableSql = `
CREATE TABLE job_snapshots (
  job_id TEXT PRIMARY KEY CHECK(length(job_id) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 1 AND revision <= ${MAX_SAFE_INTEGER_SQL}),
  last_event_id TEXT NOT NULL CHECK(length(last_event_id) > 0),
  snapshot_version INTEGER NOT NULL CHECK(snapshot_version >= 1 AND snapshot_version <= ${MAX_SAFE_INTEGER_SQL}),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) = 1),
  FOREIGN KEY (job_id, revision)
    REFERENCES job_events (job_id, revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (job_id, last_event_id)
    REFERENCES job_events (job_id, event_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID
`;

const createContiguousInsertTriggerSql = `
CREATE TRIGGER job_events_contiguous_insert
BEFORE INSERT ON job_events
FOR EACH ROW
WHEN NEW.revision != COALESCE(
  (SELECT MAX(revision) + 1 FROM job_events WHERE job_id = NEW.job_id),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'job event revisions must be contiguous');
END
`;

const createUpdateTriggerSql = `
CREATE TRIGGER job_events_reject_update
BEFORE UPDATE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job events are append-only');
END
`;

const createDeleteTriggerSql = `
CREATE TRIGGER job_events_reject_delete
BEFORE DELETE ON job_events
BEGIN
  SELECT RAISE(ABORT, 'job events are append-only');
END
`;

export interface StoreMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial-job-journal",
    sql: [
      createMigrationsTableSql,
      createEventsTableSql,
      createEventIdIndexSql,
      createSnapshotsTableSql,
      createContiguousInsertTriggerSql,
      createUpdateTriggerSql,
      createDeleteTriggerSql,
    ]
      .map((statement) => `${statement.trim()};`)
      .join("\n"),
  }),
]);

interface ExpectedSchemaObject {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly sql: string;
}

const EXPECTED_SCHEMA_OBJECTS: readonly ExpectedSchemaObject[] = Object.freeze([
  { type: "table", name: "store_migrations", sql: createMigrationsTableSql },
  { type: "table", name: "job_events", sql: createEventsTableSql },
  { type: "index", name: "job_events_job_event_id_uq", sql: createEventIdIndexSql },
  { type: "table", name: "job_snapshots", sql: createSnapshotsTableSql },
  {
    type: "trigger",
    name: "job_events_contiguous_insert",
    sql: createContiguousInsertTriggerSql,
  },
  {
    type: "trigger",
    name: "job_events_reject_update",
    sql: createUpdateTriggerSql,
  },
  {
    type: "trigger",
    name: "job_events_reject_delete",
    sql: createDeleteTriggerSql,
  },
]);

function safeInteger(value: unknown, label: string): number {
  const converted =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(converted) || (converted as number) < 0) {
    throw new JobStoreCorruptionError(
      "schema",
      `${label} is not a non-negative safe integer.`,
    );
  }
  return converted as number;
}

function pragmaInteger(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return safeInteger(row?.[name], `PRAGMA ${name}`);
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

export function migrationFingerprint(migration: StoreMigration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

function assertMigrationSequence(migrations: readonly StoreMigration[]): void {
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1 ||
      !Number.isSafeInteger(migration.version) ||
      migration.name.length === 0
    ) {
      throw new JobStoreCorruptionError(
        "migration-ledger",
        "Store migrations must be non-empty and consecutively versioned from 1.",
      );
    }
  }
}

function listUserSchemaObjects(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function validateMigrationLedger(
  database: DatabaseSync,
  version: number,
  migrations: readonly StoreMigration[],
): void {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database
      .prepare(
        `SELECT version, name, sql_sha256
         FROM store_migrations
         ORDER BY version`,
      )
      .all();
  } catch (error) {
    throw new JobStoreCorruptionError(
      "migration-ledger",
      "The migration ledger is missing or unreadable.",
      { cause: error },
    );
  }

  if (rows.length !== version) {
    throw new JobStoreCorruptionError(
      "migration-ledger",
      `Migration ledger has ${rows.length} rows for schema version ${version}.`,
    );
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const migration = migrations[index];
    if (
      migration === undefined ||
      safeInteger(row?.version, "migration version") !== migration.version ||
      row?.name !== migration.name ||
      row?.sql_sha256 !== migrationFingerprint(migration)
    ) {
      throw new JobStoreCorruptionError(
        "migration-ledger",
        `Migration ledger entry ${index + 1} does not match reviewed migration input.`,
      );
    }
  }
}

export function applyStoreMigrations(
  database: DatabaseSync,
  migrations: readonly StoreMigration[] = STORE_MIGRATIONS,
): void {
  assertMigrationSequence(migrations);
  const supportedVersion = migrations.length;

  database.exec("BEGIN IMMEDIATE");
  try {
    const applicationId = pragmaInteger(database, "application_id");
    const currentVersion = pragmaInteger(database, "user_version");

    if (currentVersion > supportedVersion) {
      throw new UnsupportedJobStoreSchemaError(
        currentVersion,
        supportedVersion,
      );
    }
    if (currentVersion === 0) {
      if (applicationId !== 0) {
        throw new JobStoreCorruptionError(
          "foreign-database",
          "An unversioned database has a foreign SQLite application ID.",
        );
      }
      if (listUserSchemaObjects(database).length !== 0) {
        throw new JobStoreCorruptionError(
          "foreign-database",
          "Refusing to initialize a non-empty unversioned database.",
        );
      }
    } else {
      if (applicationId !== JOB_STORE_APPLICATION_ID) {
        throw new JobStoreCorruptionError(
          "foreign-database",
          "The SQLite application ID does not identify a pi-delivery store.",
        );
      }
      validateMigrationLedger(database, currentVersion, migrations);
    }

    for (const migration of migrations.slice(currentVersion)) {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO store_migrations (version, name, sql_sha256)
           VALUES (?, ?, ?)`,
        )
        .run(
          BigInt(migration.version),
          migration.name,
          migrationFingerprint(migration),
        );
      database.exec(`PRAGMA application_id = ${JOB_STORE_APPLICATION_ID}`);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }

    const finalVersion = pragmaInteger(database, "user_version");
    if (finalVersion !== supportedVersion) {
      throw new JobStoreCorruptionError(
        "migration-ledger",
        `Migration stopped at version ${finalVersion}; expected ${supportedVersion}.`,
      );
    }
    if (pragmaInteger(database, "application_id") !== JOB_STORE_APPLICATION_ID) {
      throw new JobStoreCorruptionError(
        "foreign-database",
        "Migration did not establish the expected SQLite application ID.",
      );
    }
    validateMigrationLedger(database, finalVersion, migrations);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration error; close/reopen validation will fail closed.
      }
    }
    throw error;
  }
}

export function validateStoreSchema(database: DatabaseSync): void {
  const version = pragmaInteger(database, "user_version");
  if (version !== JOB_STORE_SCHEMA_VERSION) {
    throw new UnsupportedJobStoreSchemaError(
      version,
      JOB_STORE_SCHEMA_VERSION,
    );
  }
  if (pragmaInteger(database, "application_id") !== JOB_STORE_APPLICATION_ID) {
    throw new JobStoreCorruptionError(
      "foreign-database",
      "The SQLite application ID does not identify a pi-delivery store.",
    );
  }
  validateMigrationLedger(database, version, STORE_MIGRATIONS);

  const actual = listUserSchemaObjects(database);
  if (actual.length !== EXPECTED_SCHEMA_OBJECTS.length) {
    throw new JobStoreCorruptionError(
      "schema",
      `Store has ${actual.length} schema objects; expected ${EXPECTED_SCHEMA_OBJECTS.length}.`,
    );
  }

  const expectedByName = new Map(
    EXPECTED_SCHEMA_OBJECTS.map((object) => [object.name, object]),
  );
  for (const row of actual) {
    const name = typeof row.name === "string" ? row.name : "<invalid>";
    const expected = expectedByName.get(name);
    if (
      expected === undefined ||
      row.type !== expected.type ||
      typeof row.sql !== "string" ||
      normalizeSql(row.sql) !== normalizeSql(expected.sql)
    ) {
      throw new JobStoreCorruptionError(
        "schema",
        `Schema object ${name} does not match the reviewed version-1 schema.`,
      );
    }
  }
}

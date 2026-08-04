import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  InvalidJobStoreInputError,
  JobRevisionConflictError,
  JobStoreClosedError,
  JobStoreCorruptionError,
  JobStoreWriteError,
  UnsupportedJobStoreSchemaError,
  openSqliteJobStore,
  resolveJobStorePath,
} from "../dist/store/index.js";
import { reduceJobEvent } from "../dist/core/index.js";
import {
  JOB_STORE_APPLICATION_ID,
  applyStoreMigrations,
} from "../dist/store/migrations.js";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-delivery-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function databasePath(t, name = "state.sqlite") {
  return join(temporaryDirectory(t), name);
}

function transition({
  jobId = "job-1",
  eventId,
  revision,
  from,
  to,
  attempt = null,
  reason = null,
}) {
  return {
    eventVersion: 1,
    eventId: eventId ?? `${jobId}-event-${revision}`,
    jobId,
    revision,
    attempt,
    type: "job.transitioned",
    payload: {
      from,
      to,
      reason,
      deliveryRevisionChange: null,
    },
  };
}

function discovery(jobId = "job-1") {
  return transition({ jobId, revision: 1, from: null, to: "discovered" });
}

function queue(jobId = "job-1") {
  return transition({ jobId, revision: 2, from: "discovered", to: "queued" });
}

function claim(jobId = "job-1") {
  return transition({
    jobId,
    revision: 3,
    from: "queued",
    to: "claimed",
    attempt: { id: `${jobId}-attempt-1`, number: 1 },
  });
}

function planning(jobId = "job-1") {
  return transition({
    jobId,
    revision: 4,
    from: "claimed",
    to: "planning",
    attempt: { id: `${jobId}-attempt-1`, number: 1 },
  });
}

function rawDatabase(path) {
  return new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false,
    readBigInts: true,
  });
}

function tableCounts(path) {
  const database = rawDatabase(path);
  try {
    return {
      events: database.prepare("SELECT COUNT(*) AS count FROM job_events").get().count,
      snapshots: database
        .prepare("SELECT COUNT(*) AS count FROM job_snapshots")
        .get().count,
      snapshotRevision: database
        .prepare("SELECT revision FROM job_snapshots WHERE job_id = 'job-1'")
        .get()?.revision,
    };
  } finally {
    database.close();
  }
}

test("store paths support explicit files and supplied Git common directories", (t) => {
  assert.equal(
    resolveJobStorePath({ databasePath: "/tmp/custom.sqlite" }),
    "/tmp/custom.sqlite",
  );
  assert.equal(
    resolveJobStorePath({ gitCommonDirectory: "/repo/.git" }),
    "/repo/.git/pi-delivery/state.sqlite",
  );

  const accessor = {};
  Object.defineProperty(accessor, "databasePath", {
    enumerable: true,
    get() {
      return "/tmp/accessor.sqlite";
    },
  });
  for (const location of [
    {},
    { databasePath: "", gitCommonDirectory: "/repo/.git" },
    { databasePath: ":memory:" },
    { databasePath: "file:state.sqlite" },
    { gitCommonDirectory: "bad\0path" },
    accessor,
    new Proxy({ databasePath: "/tmp/proxy.sqlite" }, {}),
  ]) {
    assert.throws(
      () => resolveJobStorePath(location),
      InvalidJobStoreInputError,
    );
  }

  if (process.platform !== "win32") {
    const directory = temporaryDirectory(t);
    const permissive = join(directory, "permissive.sqlite");
    writeFileSync(permissive, "");
    chmodSync(permissive, 0o644);
    assert.throws(
      () => openSqliteJobStore({ databasePath: permissive }),
      InvalidJobStoreInputError,
    );

    chmodSync(permissive, 0o600);
    const store = openSqliteJobStore({ databasePath: permissive });
    store.close();

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${permissive}${suffix}`;
      writeFileSync(sidecar, "");
      chmodSync(sidecar, 0o644);
      assert.throws(
        () => openSqliteJobStore({ databasePath: permissive }),
        InvalidJobStoreInputError,
      );
      rmSync(sidecar);

      symlinkSync(permissive, sidecar);
      assert.throws(
        () => openSqliteJobStore({ databasePath: permissive }),
        InvalidJobStoreInputError,
      );
      rmSync(sidecar);
    }

    const symlink = join(directory, "state-link.sqlite");
    symlinkSync(permissive, symlink);
    assert.throws(
      () => openSqliteJobStore({ databasePath: symlink }),
      InvalidJobStoreInputError,
    );
  }
});

test("new stores migrate transactionally, use WAL, and reopen idempotently", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  assert.equal(store.databasePath, path);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  store.close();

  const database = rawDatabase(path);
  try {
    assert.equal(database.prepare("PRAGMA application_id").get().application_id, BigInt(JOB_STORE_APPLICATION_ID));
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1n);
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.deepEqual(
      database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map(({ name }) => name),
      [
        "job_events",
        "job_events_contiguous_insert",
        "job_events_job_event_id_uq",
        "job_events_reject_delete",
        "job_events_reject_update",
        "job_snapshots",
        "store_migrations",
      ],
    );
  } finally {
    database.close();
  }

  const reopened = openSqliteJobStore({ databasePath: path });
  assert.equal(reopened.readJob("absent"), null);
  reopened.close();
});

test("append and restart replay return provenance-bound immutable snapshots", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  const first = store.appendJobEvent(discovery(), { expectedRevision: 0 });
  const second = store.appendJobEvent(queue(), { expectedRevision: 1 });
  const third = store.appendJobEvent(claim(), { expectedRevision: 2 });

  assert.equal(first.state, "discovered");
  assert.equal(second.state, "queued");
  assert.equal(third.state, "claimed");
  assert.equal(Object.isFrozen(third), true);
  store.close();

  const reopened = openSqliteJobStore({ databasePath: path });
  const replayed = reopened.readJob("job-1");
  assert.deepEqual(replayed, third);
  assert.equal(
    reduceJobEvent(replayed, planning()).state,
    "planning",
  );
  reopened.close();
});

test("multiple jobs remain independent", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  store.appendJobEvent(discovery("job-1"), { expectedRevision: 0 });
  store.appendJobEvent(discovery("job-2"), { expectedRevision: 0 });
  store.appendJobEvent(queue("job-2"), { expectedRevision: 1 });

  assert.equal(store.readJob("job-1").revision, 1);
  assert.equal(store.readJob("job-2").revision, 2);
  store.close();
});

test("revision conflicts and invalid events leave event and snapshot unchanged", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });

  assert.throws(
    () => store.appendJobEvent(queue(), { expectedRevision: 0 }),
    (error) =>
      error instanceof JobRevisionConflictError &&
      error.expectedRevision === 0 &&
      error.actualRevision === 1,
  );
  assert.throws(
    () =>
      store.appendJobEvent(
        transition({ revision: 3, from: "discovered", to: "queued" }),
        { expectedRevision: 1 },
      ),
    InvalidJobStoreInputError,
  );
  assert.throws(
    () =>
      store.appendJobEvent(
        transition({ revision: 2, from: "discovered", to: "claimed" }),
        { expectedRevision: 1 },
      ),
  );
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "expectedRevision", {
    enumerable: true,
    get() {
      return 1;
    },
  });
  for (const options of [
    { expectedRevision: 1, extra: true },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    accessorOptions,
    new Proxy({ expectedRevision: 1 }, {}),
  ]) {
    assert.throws(
      () => store.appendJobEvent(queue(), options),
      InvalidJobStoreInputError,
    );
  }

  assert.deepEqual(tableCounts(path), {
    events: 1n,
    snapshots: 1n,
    snapshotRevision: 1n,
  });
  assert.equal(store.readJob("job-1").revision, 1);
  store.close();
});

test("two connections cannot append from the same expected revision", (t) => {
  const path = databasePath(t);
  const first = openSqliteJobStore({ databasePath: path });
  const second = openSqliteJobStore({ databasePath: path });

  first.appendJobEvent(discovery(), { expectedRevision: 0 });
  assert.throws(
    () =>
      second.appendJobEvent(
        transition({
          eventId: "competing-discovery",
          revision: 1,
          from: null,
          to: "discovered",
        }),
        { expectedRevision: 0 },
      ),
    JobRevisionConflictError,
  );
  assert.equal(second.readJob("job-1").revision, 1);

  first.close();
  second.close();
});

test("snapshot write failure rolls back the preceding event insert", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });

  const database = rawDatabase(path);
  database.exec(`
    CREATE TRIGGER test_reject_snapshot_update
    BEFORE UPDATE ON job_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'forced snapshot failure');
    END;
  `);

  assert.throws(
    () => store.appendJobEvent(queue(), { expectedRevision: 1 }),
    JobStoreWriteError,
  );
  assert.deepEqual(tableCounts(path), {
    events: 1n,
    snapshots: 1n,
    snapshotRevision: 1n,
  });
  assert.equal(store.readJob("job-1").revision, 1);

  database.exec("DROP TRIGGER test_reject_snapshot_update");
  database.close();
  store.close();
});

test("all pending migrations roll back together on a later failure", (t) => {
  const path = databasePath(t);
  const database = rawDatabase(path);
  const migrations = [
    {
      version: 1,
      name: "first-pending",
      sql: `
        CREATE TABLE store_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          sql_sha256 TEXT NOT NULL
        ) STRICT;
        CREATE TABLE first_pending (id INTEGER PRIMARY KEY) STRICT;
      `,
    },
    {
      version: 2,
      name: "later-failure",
      sql: `
        CREATE TABLE second_pending (id INTEGER PRIMARY KEY) STRICT;
        SELECT definitely_missing_function();
      `,
    },
  ];

  assert.throws(() => applyStoreMigrations(database, migrations));
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare("PRAGMA application_id").get().application_id, 0n);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 0n);
  assert.deepEqual(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all(),
    [],
  );
  database.close();
});

test("unsupported, foreign, and non-empty unversioned databases fail closed", (t) => {
  const directory = temporaryDirectory(t);
  const unsupportedPath = join(directory, "unsupported.sqlite");
  const unsupported = rawDatabase(unsupportedPath);
  unsupported.exec(`PRAGMA application_id = ${JOB_STORE_APPLICATION_ID}`);
  unsupported.exec("PRAGMA user_version = 2");
  unsupported.close();
  if (process.platform !== "win32") chmodSync(unsupportedPath, 0o600);
  assert.throws(
    () => openSqliteJobStore({ databasePath: unsupportedPath }),
    UnsupportedJobStoreSchemaError,
  );

  const foreignPath = join(directory, "foreign.sqlite");
  const foreign = rawDatabase(foreignPath);
  foreign.exec("CREATE TABLE existing_data (id INTEGER PRIMARY KEY) STRICT");
  foreign.close();
  if (process.platform !== "win32") chmodSync(foreignPath, 0o600);
  assert.throws(
    () => openSqliteJobStore({ databasePath: foreignPath }),
    (error) =>
      error instanceof JobStoreCorruptionError &&
      error.kind === "foreign-database",
  );
  const foreignCheck = rawDatabase(foreignPath);
  assert.equal(
    foreignCheck
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'existing_data'")
      .get().count,
    1n,
  );
  foreignCheck.close();
});

test("startup rejects migration, schema, snapshot, and orphan corruption", async (t) => {
  const directory = temporaryDirectory(t);

  const ledgerPath = join(directory, "ledger.sqlite");
  let store = openSqliteJobStore({ databasePath: ledgerPath });
  store.close();
  let database = rawDatabase(ledgerPath);
  database.exec("UPDATE store_migrations SET sql_sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: ledgerPath }),
    (error) =>
      error instanceof JobStoreCorruptionError &&
      error.kind === "migration-ledger",
  );

  const schemaPath = join(directory, "schema.sqlite");
  store = openSqliteJobStore({ databasePath: schemaPath });
  store.close();
  database = rawDatabase(schemaPath);
  database.exec("CREATE TABLE unexpected (id INTEGER PRIMARY KEY) STRICT");
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: schemaPath }),
    (error) =>
      error instanceof JobStoreCorruptionError && error.kind === "schema",
  );

  const snapshotPath = join(directory, "snapshot.sqlite");
  store = openSqliteJobStore({ databasePath: snapshotPath });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });
  store.close();
  database = rawDatabase(snapshotPath);
  database.prepare("UPDATE job_snapshots SET snapshot_json = ?").run("{}");
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: snapshotPath }),
    (error) =>
      error instanceof JobStoreCorruptionError && error.kind === "snapshot-row",
  );

  const orphanPath = join(directory, "orphan.sqlite");
  store = openSqliteJobStore({ databasePath: orphanPath });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });
  store.close();
  database = rawDatabase(orphanPath);
  database.exec("DELETE FROM job_snapshots");
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: orphanPath }),
    (error) =>
      error instanceof JobStoreCorruptionError && error.kind === "snapshot-row",
  );
});

test("startup rejects unsupported stored events and replay-inconsistent snapshots", (t) => {
  const directory = temporaryDirectory(t);

  const eventPath = join(directory, "event-version.sqlite");
  let store = openSqliteJobStore({ databasePath: eventPath });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });
  store.close();
  let database = rawDatabase(eventPath);
  const updateTriggerSql = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name = 'job_events_reject_update'")
    .get().sql;
  const storedEvent = JSON.parse(
    database.prepare("SELECT event_json FROM job_events").get().event_json,
  );
  storedEvent.eventVersion = 2;
  database.exec("DROP TRIGGER job_events_reject_update");
  database
    .prepare("UPDATE job_events SET event_version = 2, event_json = ?")
    .run(JSON.stringify(storedEvent));
  database.exec(updateTriggerSql);
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: eventPath }),
    (error) =>
      error instanceof JobStoreCorruptionError && error.kind === "event-row",
  );

  const mismatchPath = join(directory, "snapshot-mismatch.sqlite");
  store = openSqliteJobStore({ databasePath: mismatchPath });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });
  store.close();
  database = rawDatabase(mismatchPath);
  const storedSnapshot = JSON.parse(
    database.prepare("SELECT snapshot_json FROM job_snapshots").get().snapshot_json,
  );
  storedSnapshot.lastEventId = "structurally-valid-but-wrong";
  database
    .prepare("UPDATE job_snapshots SET snapshot_json = ?")
    .run(JSON.stringify(storedSnapshot));
  database.close();
  assert.throws(
    () => openSqliteJobStore({ databasePath: mismatchPath }),
    (error) =>
      error instanceof JobStoreCorruptionError &&
      error.kind === "snapshot-mismatch",
  );
});

test("event history is append-only and direct revision gaps are rejected", (t) => {
  const path = databasePath(t);
  const store = openSqliteJobStore({ databasePath: path });
  store.appendJobEvent(discovery(), { expectedRevision: 0 });
  store.close();

  const database = rawDatabase(path);
  assert.throws(() =>
    database.exec("UPDATE job_events SET event_type = 'changed'"),
  );
  assert.throws(() => database.exec("DELETE FROM job_events"));
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO job_events (
           job_id, revision, event_id, event_version, event_type, event_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("job-1", 3n, "gap", 1n, "job.transitioned", "{}"),
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM job_events").get().count,
    1n,
  );
  database.close();
});

test("close is idempotent and operations fail after close", (t) => {
  const store = openSqliteJobStore({ databasePath: databasePath(t) });
  store.close();
  store.close();
  assert.throws(() => store.readJob("job-1"), JobStoreClosedError);
  assert.throws(
    () => store.appendJobEvent(discovery(), { expectedRevision: 0 }),
    JobStoreClosedError,
  );
});

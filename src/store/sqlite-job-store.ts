import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";

import {
  JobInvariantError,
  InvalidJobEventError,
  InvalidJobSnapshotError,
  parseJobEvent,
  parseJobSnapshot,
  reduceJobEvent,
  replayJobEvents,
  type JobEvent,
  type JobSnapshot,
} from "../core/index.js";
import {
  InvalidJobStoreInputError,
  JobRevisionConflictError,
  JobStoreClosedError,
  JobStoreCorruptionError,
  JobStoreError,
  JobStoreWriteError,
  UnsupportedJobStoreSchemaError,
} from "./errors.js";
import {
  JOB_STORE_SCHEMA_VERSION,
  applyStoreMigrations,
  validateStoreSchema,
} from "./migrations.js";

export const DEFAULT_JOB_STORE_RELATIVE_PATH = "pi-delivery/state.sqlite";
export const DEFAULT_JOB_STORE_BUSY_TIMEOUT_MS = 5_000;

export type JobStoreLocation =
  | {
      readonly databasePath: string;
      readonly gitCommonDirectory?: never;
    }
  | {
      readonly gitCommonDirectory: string;
      readonly databasePath?: never;
    };

export interface AppendJobEventOptions {
  readonly expectedRevision: number;
}

const require = createRequire(import.meta.url);

function databaseConstructor(): typeof import("node:sqlite").DatabaseSync {
  return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
}

interface EventRow {
  readonly job_id: unknown;
  readonly revision: unknown;
  readonly event_id: unknown;
  readonly event_version: unknown;
  readonly event_type: unknown;
  readonly event_json: unknown;
}

interface SnapshotRow {
  readonly job_id: unknown;
  readonly revision: unknown;
  readonly last_event_id: unknown;
  readonly snapshot_version: unknown;
  readonly snapshot_json: unknown;
}

function exactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidJobStoreInputError(`${label} must be a plain object.`);
  }

  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const actual = keys
    .filter((key): key is string => typeof key === "string")
    .sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== keys.length ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidJobStoreInputError(
      `${label} must contain exactly: ${expected.join(", ")}.`,
    );
  }
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new InvalidJobStoreInputError(
        `${label}.${key} must be an enumerable data property.`,
      );
    }
  }
  return Object.fromEntries(
    expected.map((key) => [key, descriptors[key]?.value]),
  );
}

function validatePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\0") ||
    value === ":memory:" ||
    value.startsWith("file:")
  ) {
    throw new InvalidJobStoreInputError(
      `${label} must be a non-empty local filesystem path.`,
    );
  }
  return value;
}

function validateJobId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidJobStoreInputError(
      "jobId must be a non-empty, trimmed opaque string of at most 512 characters.",
    );
  }
  return value;
}

export function resolveJobStorePath(location: JobStoreLocation): string {
  let input: Record<string, unknown>;
  try {
    input = exactDataObject(location, ["databasePath"], "location");
  } catch (databasePathError) {
    try {
      input = exactDataObject(
        location,
        ["gitCommonDirectory"],
        "location",
      );
    } catch {
      throw databasePathError;
    }
  }

  if ("databasePath" in input) {
    const databasePath = validatePath(input.databasePath, "databasePath");
    return isAbsolute(databasePath) ? databasePath : resolve(databasePath);
  }
  if ("gitCommonDirectory" in input) {
    const gitCommonDirectory = validatePath(
      input.gitCommonDirectory,
      "gitCommonDirectory",
    );
    return resolve(
      gitCommonDirectory,
      ...DEFAULT_JOB_STORE_RELATIVE_PATH.split("/"),
    );
  }

  throw new InvalidJobStoreInputError(
    "Specify exactly one of databasePath or gitCommonDirectory.",
  );
}

function expectedRevisionAt(value: unknown): number {
  const options = exactDataObject(
    value,
    ["expectedRevision"],
    "append options",
  );
  const revision = options.expectedRevision;
  if (
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    (revision as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new InvalidJobStoreInputError(
      "expectedRevision must be a non-negative safe integer with room for the next revision.",
    );
  }
  return revision as number;
}

function safeInteger(value: unknown, label: string): number {
  const converted =
    typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(converted) || (converted as number) < 0) {
    throw new JobStoreCorruptionError(
      "event-row",
      `${label} is not a non-negative safe integer.`,
    );
  }
  return converted as number;
}

function requiredText(value: unknown, label: string, kind: "event-row" | "snapshot-row"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JobStoreCorruptionError(kind, `${label} is not non-empty text.`);
  }
  return value;
}

function parseJson(text: string, label: string, kind: "event-row" | "snapshot-row"): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new JobStoreCorruptionError(kind, `${label} is not valid JSON.`, {
      cause: error,
    });
  }
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new InvalidJobStoreInputError("Value is not JSON serializable.");
  }
  return serialized;
}

function isKnownError(error: unknown): boolean {
  return (
    error instanceof JobStoreError ||
    error instanceof JobInvariantError ||
    error instanceof InvalidJobEventError ||
    error instanceof InvalidJobSnapshotError
  );
}

function rollbackPreserving(database: DatabaseSync): void {
  if (!database.isTransaction) return;
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure. A subsequent operation or reopen fails closed.
  }
}

function inspectExistingPrivateFile(path: string, label: string): boolean {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new InvalidJobStoreInputError(`Cannot inspect existing ${label}.`, {
      cause: error,
    });
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new InvalidJobStoreInputError(
      `An existing ${label} must be a regular, non-symlinked file.`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new InvalidJobStoreInputError(
      `An existing ${label} must be owned by the current operating-system user.`,
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new InvalidJobStoreInputError(
      `An existing ${label} must not grant group or world permissions.`,
    );
  }
  return true;
}

function inspectExistingDatabasePath(databasePath: string): boolean {
  const databaseExists = inspectExistingPrivateFile(
    databasePath,
    "database file",
  );
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarExists = inspectExistingPrivateFile(
      `${databasePath}${suffix}`,
      `SQLite ${suffix.slice(1)} sidecar`,
    );
    if (sidecarExists && !databaseExists) {
      throw new InvalidJobStoreInputError(
        "SQLite sidecars must not exist without the main database file.",
      );
    }
  }
  return databaseExists;
}

export class SqliteJobStore {
  readonly databasePath: string;
  #database: DatabaseSync;
  #closed = false;

  private constructor(databasePath: string, database: DatabaseSync) {
    this.databasePath = databasePath;
    this.#database = database;
  }

  static open(location: JobStoreLocation): SqliteJobStore {
    const databasePath = resolveJobStorePath(location);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const databaseExisted = inspectExistingDatabasePath(databasePath);

    let database: DatabaseSync | undefined;
    try {
      const Database = databaseConstructor();
      database = new Database(databasePath, {
        open: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        readOnly: false,
        allowExtension: false,
        timeout: DEFAULT_JOB_STORE_BUSY_TIMEOUT_MS,
        readBigInts: true,
        returnArrays: false,
        allowBareNamedParameters: false,
        allowUnknownNamedParameters: false,
      });
      if (!databaseExisted) {
        chmodSync(databasePath, 0o600);
      }
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA synchronous = FULL");

      applyStoreMigrations(database);

      const journalMode = database.prepare("PRAGMA journal_mode = WAL").get()
        ?.journal_mode;
      if (journalMode !== "wal") {
        throw new JobStoreCorruptionError(
          "schema",
          `SQLite refused WAL mode and returned ${String(journalMode)}.`,
        );
      }
      database.exec("PRAGMA synchronous = FULL");
      database.exec("PRAGMA wal_autocheckpoint = 1000");

      validateStoreSchema(database);
      SqliteJobStore.#validateConnection(database);

      const store = new SqliteJobStore(databasePath, database);
      store.#validateAllJobs();
      return store;
    } catch (error) {
      if (database?.isOpen) {
        try {
          database.close();
        } catch {
          // Preserve the startup failure.
        }
      }
      if (isKnownError(error)) throw error;
      throw new JobStoreCorruptionError(
        "schema",
        `Failed to open SQLite job store at ${databasePath}.`,
        { cause: error },
      );
    }
  }

  static #validateConnection(database: DatabaseSync): void {
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (
      quickCheck.length !== 1 ||
      quickCheck[0]?.quick_check !== "ok"
    ) {
      throw new JobStoreCorruptionError(
        "integrity",
        "SQLite quick_check did not report ok.",
      );
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new JobStoreCorruptionError(
        "integrity",
        "SQLite foreign_key_check reported violations.",
      );
    }

    const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
    const synchronous = database.prepare("PRAGMA synchronous").get()?.synchronous;
    const trustedSchema = database.prepare("PRAGMA trusted_schema").get()?.trusted_schema;
    if (foreignKeys !== 1n || synchronous !== 2n || trustedSchema !== 0n) {
      throw new JobStoreCorruptionError(
        "schema",
        "SQLite connection safety PRAGMAs are not active.",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed || !this.#database.isOpen) {
      throw new JobStoreClosedError();
    }
  }

  #validateAllJobs(): void {
    try {
      this.#database.exec("BEGIN");
      const rows = this.#database
        .prepare(
          `SELECT job_id FROM job_events
           UNION
           SELECT job_id FROM job_snapshots
           ORDER BY job_id`,
        )
        .all();
      for (const row of rows) {
        this.#readJobInTransaction(
          requiredText(row.job_id, "job ID", "event-row"),
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollbackPreserving(this.#database);
      throw error;
    }
  }

  #readJobInTransaction(jobId: string): JobSnapshot | null {
    const eventRows = this.#database
      .prepare(
        `SELECT job_id, revision, event_id, event_version, event_type, event_json
         FROM job_events
         WHERE job_id = ?
         ORDER BY revision`,
      )
      .all(jobId) as unknown as EventRow[];
    const snapshotRow = this.#database
      .prepare(
        `SELECT job_id, revision, last_event_id, snapshot_version, snapshot_json
         FROM job_snapshots
         WHERE job_id = ?`,
      )
      .get(jobId) as SnapshotRow | undefined;

    if (eventRows.length === 0) {
      if (snapshotRow !== undefined) {
        throw new JobStoreCorruptionError(
          "snapshot-row",
          `Job ${jobId} has a snapshot without event history.`,
        );
      }
      return null;
    }
    if (snapshotRow === undefined) {
      throw new JobStoreCorruptionError(
        "snapshot-row",
        `Job ${jobId} has event history without a snapshot.`,
      );
    }

    const events: JobEvent[] = [];
    for (const row of eventRows) {
      const eventJson = requiredText(
        row.event_json,
        "event_json",
        "event-row",
      );
      let event: JobEvent;
      try {
        event = parseJobEvent(
          parseJson(eventJson, "event_json", "event-row"),
        );
      } catch (error) {
        if (error instanceof JobStoreCorruptionError) throw error;
        throw new JobStoreCorruptionError(
          "event-row",
          `Job ${jobId} contains a malformed event row.`,
          { cause: error },
        );
      }

      if (
        event.jobId !== requiredText(row.job_id, "job_id", "event-row") ||
        event.revision !== safeInteger(row.revision, "event revision") ||
        event.eventId !== requiredText(row.event_id, "event_id", "event-row") ||
        event.eventVersion !== safeInteger(row.event_version, "event version") ||
        event.type !== requiredText(row.event_type, "event_type", "event-row") ||
        canonicalJson(event) !== eventJson
      ) {
        throw new JobStoreCorruptionError(
          "event-row",
          `Job ${jobId} event columns do not match canonical event JSON.`,
        );
      }
      events.push(event);
    }

    let replayed: JobSnapshot;
    try {
      replayed = replayJobEvents(events);
    } catch (error) {
      throw new JobStoreCorruptionError(
        "event-history",
        `Job ${jobId} event history cannot be replayed.`,
        { cause: error },
      );
    }

    const snapshotJson = requiredText(
      snapshotRow.snapshot_json,
      "snapshot_json",
      "snapshot-row",
    );
    let persisted: JobSnapshot;
    try {
      persisted = parseJobSnapshot(
        parseJson(snapshotJson, "snapshot_json", "snapshot-row"),
      );
    } catch (error) {
      if (error instanceof JobStoreCorruptionError) throw error;
      throw new JobStoreCorruptionError(
        "snapshot-row",
        `Job ${jobId} contains a malformed snapshot row.`,
        { cause: error },
      );
    }

    if (
      persisted.jobId !== requiredText(snapshotRow.job_id, "job_id", "snapshot-row") ||
      persisted.revision !== safeInteger(snapshotRow.revision, "snapshot revision") ||
      persisted.lastEventId !==
        requiredText(snapshotRow.last_event_id, "last_event_id", "snapshot-row") ||
      persisted.snapshotVersion !==
        safeInteger(snapshotRow.snapshot_version, "snapshot version") ||
      canonicalJson(persisted) !== snapshotJson ||
      canonicalJson(persisted) !== canonicalJson(replayed)
    ) {
      throw new JobStoreCorruptionError(
        "snapshot-mismatch",
        `Job ${jobId} persisted snapshot does not match complete replay.`,
      );
    }

    return replayed;
  }

  readJob(jobId: string): JobSnapshot | null {
    this.#assertOpen();
    const normalizedJobId = validateJobId(jobId);
    try {
      this.#database.exec("BEGIN");
      const snapshot = this.#readJobInTransaction(normalizedJobId);
      this.#database.exec("COMMIT");
      return snapshot;
    } catch (error) {
      rollbackPreserving(this.#database);
      throw error;
    }
  }

  appendJobEvent(
    value: unknown,
    options: AppendJobEventOptions,
  ): JobSnapshot {
    this.#assertOpen();
    const event = parseJobEvent(value);
    const expectedRevision = expectedRevisionAt(options);

    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = this.#readJobInTransaction(event.jobId);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw new JobRevisionConflictError(
          event.jobId,
          expectedRevision,
          actualRevision,
        );
      }
      if (event.revision !== expectedRevision + 1) {
        throw new InvalidJobStoreInputError(
          `Event revision ${event.revision} must equal expectedRevision + 1 (${expectedRevision + 1}).`,
        );
      }

      const next = reduceJobEvent(current, event);
      const eventJson = canonicalJson(event);
      const snapshotJson = canonicalJson(next);

      this.#database
        .prepare(
          `INSERT INTO job_events (
             job_id, revision, event_id, event_version, event_type, event_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.jobId,
          BigInt(event.revision),
          event.eventId,
          BigInt(event.eventVersion),
          event.type,
          eventJson,
        );
      this.#database
        .prepare(
          `INSERT INTO job_snapshots (
             job_id, revision, last_event_id, snapshot_version, snapshot_json
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (job_id) DO UPDATE SET
             revision = excluded.revision,
             last_event_id = excluded.last_event_id,
             snapshot_version = excluded.snapshot_version,
             snapshot_json = excluded.snapshot_json`,
        )
        .run(
          next.jobId,
          BigInt(next.revision),
          next.lastEventId,
          BigInt(next.snapshotVersion),
          snapshotJson,
        );
      this.#database.exec("COMMIT");
      return next;
    } catch (error) {
      rollbackPreserving(this.#database);
      if (isKnownError(error)) throw error;
      throw new JobStoreWriteError(
        `Failed to append event ${event.eventId} for job ${event.jobId}.`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }
}

export function openSqliteJobStore(location: JobStoreLocation): SqliteJobStore {
  return SqliteJobStore.open(location);
}

export { JOB_STORE_SCHEMA_VERSION };

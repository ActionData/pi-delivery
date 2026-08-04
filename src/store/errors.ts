export type JobStoreCorruptionKind =
  | "foreign-database"
  | "schema"
  | "migration-ledger"
  | "integrity"
  | "event-row"
  | "event-history"
  | "snapshot-row"
  | "snapshot-mismatch";

export class JobStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobStoreError";
    this.code = code;
  }
}

export class InvalidJobStoreInputError extends JobStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("invalid-input", message, options);
    this.name = "InvalidJobStoreInputError";
  }
}

export class JobRevisionConflictError extends JobStoreError {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(jobId: string, expectedRevision: number, actualRevision: number) {
    super(
      "revision-conflict",
      `Job ${jobId} expected revision ${expectedRevision}, but persisted revision is ${actualRevision}.`,
    );
    this.name = "JobRevisionConflictError";
    this.jobId = jobId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class UnsupportedJobStoreSchemaError extends JobStoreError {
  readonly foundVersion: number;
  readonly supportedVersion: number;

  constructor(foundVersion: number, supportedVersion: number) {
    super(
      "unsupported-schema",
      `Job store schema version ${foundVersion} is unsupported; this build supports ${supportedVersion}.`,
    );
    this.name = "UnsupportedJobStoreSchemaError";
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class JobStoreCorruptionError extends JobStoreError {
  readonly kind: JobStoreCorruptionKind;

  constructor(
    kind: JobStoreCorruptionKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super("corrupt-store", message, options);
    this.name = "JobStoreCorruptionError";
    this.kind = kind;
  }
}

export class JobStoreClosedError extends JobStoreError {
  constructor() {
    super("store-closed", "The SQLite job store is closed.");
    this.name = "JobStoreClosedError";
  }
}

export class JobStoreWriteError extends JobStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("write-failed", message, options);
    this.name = "JobStoreWriteError";
  }
}

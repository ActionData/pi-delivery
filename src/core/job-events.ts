import { types as utilTypes } from "node:util";

import { JOB_STATES, type JobState } from "./state-machine.js";

export const JOB_EVENT_VERSION = 1 as const;

export interface JobAttemptIdentity {
  readonly id: string;
  readonly number: number;
}

export interface JobReason {
  readonly code: string;
  readonly summary: string;
}

export interface DeliveryBinding {
  readonly id: string;
  readonly baseRevision: string;
  readonly headRevision: string;
}

export interface DeliveryRevisionChange {
  readonly from: DeliveryBinding | null;
  readonly to: DeliveryBinding;
}

export interface HumanActorAttestation {
  readonly id: string;
  readonly kind: "human";
}

export interface HumanMergeObservation {
  readonly deliveryId: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly mergeRevision: string;
  readonly actor: HumanActorAttestation;
}

export interface JobTransitionPayload {
  readonly from: JobState | null;
  readonly to: JobState;
  readonly reason: JobReason | null;
  readonly deliveryRevisionChange: DeliveryRevisionChange | null;
}

export interface ValidationRecordedPayload {
  readonly delivery: DeliveryBinding;
  readonly evidenceId: string;
  readonly verdict: "passed" | "failed";
}

export interface ReviewRecordedPayload {
  readonly delivery: DeliveryBinding;
  readonly evidenceId: string;
  readonly verdict: "accepted" | "changes-requested";
}

export interface HumanMergeObservedPayload {
  readonly from: "review-ready";
  readonly observation: HumanMergeObservation;
}

export interface JobEventEnvelope<Type extends string, Payload> {
  readonly eventVersion: typeof JOB_EVENT_VERSION;
  readonly eventId: string;
  readonly jobId: string;
  readonly revision: number;
  readonly attempt: JobAttemptIdentity | null;
  readonly type: Type;
  readonly payload: Payload;
}

export type JobTransitionedEvent = JobEventEnvelope<
  "job.transitioned",
  JobTransitionPayload
>;
export type ValidationRecordedEvent = JobEventEnvelope<
  "job.validation-recorded",
  ValidationRecordedPayload
>;
export type ReviewRecordedEvent = JobEventEnvelope<
  "job.review-recorded",
  ReviewRecordedPayload
>;
export type HumanMergeObservedEvent = JobEventEnvelope<
  "job.human-merge-observed",
  HumanMergeObservedPayload
>;

export type JobEvent =
  | JobTransitionedEvent
  | ValidationRecordedEvent
  | ReviewRecordedEvent
  | HumanMergeObservedEvent;

export type JobEventValidationFailure =
  | "malformed-event"
  | "unsupported-event-version"
  | "unknown-event-type";

export class InvalidJobEventError extends Error {
  readonly failure: JobEventValidationFailure;
  readonly path: string;

  constructor(
    failure: JobEventValidationFailure,
    path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "InvalidJobEventError";
    this.failure = failure;
    this.path = path;
  }
}

export type UnknownRecord = Record<string, unknown>;

const jobStateSet = new Set<string>(JOB_STATES);
const reasonCodePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

function malformed(path: string, message: string): never {
  throw new InvalidJobEventError("malformed-event", path, message);
}

export function recordAt(value: unknown, path: string): UnknownRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return malformed(path, "must be a plain object");
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return malformed(path, "must support deterministic reflection");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return malformed(path, "must be a plain object");
  }

  return value as UnknownRecord;
}

export function dataArrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    return malformed(path, "must be an ordinary dense array");
  }

  let keys: readonly PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
  } catch {
    return malformed(path, "must support deterministic reflection");
  }

  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return malformed(`${path}.length`, "must be an ordinary array length");
  }

  if (keys.length !== lengthDescriptor.value + 1) {
    return malformed(path, "must be a dense array without extra properties");
  }
  const expected = [
    ...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
    "length",
  ].sort();
  if (
    keys.some((key) => typeof key !== "string") ||
    (keys as readonly string[])
      .slice()
      .sort()
      .some((key, index) => key !== expected[index])
  ) {
    return malformed(path, "must be a dense array without extra properties");
  }

  const captured: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return malformed(
        `${path}[${index}]`,
        "must be an enumerable data property",
      );
    }
    captured.push(descriptor.value);
  }
  return Object.freeze(captured);
}

export function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
): void {
  let keys: readonly PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
  } catch {
    return malformed(path, "must support deterministic reflection");
  }

  if (keys.some((key) => typeof key !== "string")) {
    malformed(path, "must not contain symbol keys");
  }

  const actual = (keys as readonly string[]).slice().sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    malformed(path, `must contain exactly: ${wanted.join(", ")}`);
  }

  for (const key of wanted) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      malformed(`${path}.${key}`, "must be an enumerable data property");
    }
  }
}

export function opaqueString(
  value: unknown,
  path: string,
  maximumLength = 512,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    controlCharacterPattern.test(value)
  ) {
    return malformed(
      path,
      `must be a non-empty, trimmed opaque string of at most ${maximumLength} characters`,
    );
  }

  return value;
}

export function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return malformed(path, "must be a positive safe integer");
  }

  return value as number;
}

export function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return malformed(path, "must be a non-negative safe integer");
  }

  return value as number;
}

export function stateAt(
  value: unknown,
  path: string,
  nullable: boolean,
): JobState | null {
  if (value === null && nullable) {
    return null;
  }

  if (typeof value !== "string" || !jobStateSet.has(value)) {
    return malformed(path, "must be a known job state");
  }

  return value as JobState;
}

export function attemptAt(
  value: unknown,
  path: string,
): JobAttemptIdentity | null {
  if (value === null) {
    return null;
  }

  const attempt = recordAt(value, path);
  exactKeys(attempt, ["id", "number"], path);

  return Object.freeze({
    id: opaqueString(attempt.id, `${path}.id`),
    number: positiveInteger(attempt.number, `${path}.number`),
  });
}

export function reasonAt(value: unknown, path: string): JobReason | null {
  if (value === null) {
    return null;
  }

  const reason = recordAt(value, path);
  exactKeys(reason, ["code", "summary"], path);
  const code = opaqueString(reason.code, `${path}.code`, 128);

  if (!reasonCodePattern.test(code)) {
    return malformed(
      `${path}.code`,
      "must use lowercase dot- or dash-separated machine tokens",
    );
  }

  return Object.freeze({
    code,
    summary: opaqueString(reason.summary, `${path}.summary`, 1_000),
  });
}

export function deliveryBindingAt(
  value: unknown,
  path: string,
): DeliveryBinding {
  const delivery = recordAt(value, path);
  exactKeys(delivery, ["id", "baseRevision", "headRevision"], path);

  return Object.freeze({
    id: opaqueString(delivery.id, `${path}.id`, 1_024),
    baseRevision: opaqueString(
      delivery.baseRevision,
      `${path}.baseRevision`,
      1_024,
    ),
    headRevision: opaqueString(
      delivery.headRevision,
      `${path}.headRevision`,
      1_024,
    ),
  });
}

function deliveryRevisionChangeAt(
  value: unknown,
  path: string,
): DeliveryRevisionChange | null {
  if (value === null) {
    return null;
  }

  const change = recordAt(value, path);
  exactKeys(change, ["from", "to"], path);

  return Object.freeze({
    from:
      change.from === null
        ? null
        : deliveryBindingAt(change.from, `${path}.from`),
    to: deliveryBindingAt(change.to, `${path}.to`),
  });
}

function transitionPayloadAt(value: unknown): JobTransitionPayload {
  const payload = recordAt(value, "event.payload");
  exactKeys(
    payload,
    ["from", "to", "reason", "deliveryRevisionChange"],
    "event.payload",
  );

  return Object.freeze({
    from: stateAt(payload.from, "event.payload.from", true),
    to: stateAt(payload.to, "event.payload.to", false) as JobState,
    reason: reasonAt(payload.reason, "event.payload.reason"),
    deliveryRevisionChange: deliveryRevisionChangeAt(
      payload.deliveryRevisionChange,
      "event.payload.deliveryRevisionChange",
    ),
  });
}

function evidencePayloadAt(
  value: unknown,
  kind: "validation" | "review",
): ValidationRecordedPayload | ReviewRecordedPayload {
  const payload = recordAt(value, "event.payload");
  exactKeys(payload, ["delivery", "evidenceId", "verdict"], "event.payload");
  const delivery = deliveryBindingAt(payload.delivery, "event.payload.delivery");
  const evidenceId = opaqueString(
    payload.evidenceId,
    "event.payload.evidenceId",
    1_024,
  );

  if (kind === "validation") {
    if (payload.verdict !== "passed" && payload.verdict !== "failed") {
      malformed("event.payload.verdict", "must be passed or failed");
    }
    return Object.freeze({ delivery, evidenceId, verdict: payload.verdict });
  }

  if (
    payload.verdict !== "accepted" &&
    payload.verdict !== "changes-requested"
  ) {
    malformed(
      "event.payload.verdict",
      "must be accepted or changes-requested",
    );
  }
  return Object.freeze({ delivery, evidenceId, verdict: payload.verdict });
}

export function humanMergeObservationAt(
  value: unknown,
  path: string,
): HumanMergeObservation {
  const observation = recordAt(value, path);
  exactKeys(
    observation,
    [
      "deliveryId",
      "baseRevision",
      "headRevision",
      "mergeRevision",
      "actor",
    ],
    path,
  );
  const actor = recordAt(observation.actor, `${path}.actor`);
  exactKeys(actor, ["id", "kind"], `${path}.actor`);

  if (actor.kind !== "human") {
    malformed(`${path}.actor.kind`, "must be human");
  }

  return Object.freeze({
    deliveryId: opaqueString(
      observation.deliveryId,
      `${path}.deliveryId`,
      1_024,
    ),
    baseRevision: opaqueString(
      observation.baseRevision,
      `${path}.baseRevision`,
      1_024,
    ),
    headRevision: opaqueString(
      observation.headRevision,
      `${path}.headRevision`,
      1_024,
    ),
    mergeRevision: opaqueString(
      observation.mergeRevision,
      `${path}.mergeRevision`,
      1_024,
    ),
    actor: Object.freeze({
      id: opaqueString(actor.id, `${path}.actor.id`, 512),
      kind: "human" as const,
    }),
  });
}

function humanMergePayloadAt(value: unknown): HumanMergeObservedPayload {
  const payload = recordAt(value, "event.payload");
  exactKeys(payload, ["from", "observation"], "event.payload");

  if (payload.from !== "review-ready") {
    malformed("event.payload.from", "must be review-ready");
  }

  return Object.freeze({
    from: "review-ready",
    observation: humanMergeObservationAt(
      payload.observation,
      "event.payload.observation",
    ),
  });
}

function parseJobEventUnchecked(value: unknown): JobEvent {
  const event = recordAt(value, "event");
  exactKeys(
    event,
    [
      "eventVersion",
      "eventId",
      "jobId",
      "revision",
      "attempt",
      "type",
      "payload",
    ],
    "event",
  );

  if (event.eventVersion !== JOB_EVENT_VERSION) {
    throw new InvalidJobEventError(
      "unsupported-event-version",
      "event.eventVersion",
      `must equal ${JOB_EVENT_VERSION}`,
    );
  }

  const base = {
    eventVersion: JOB_EVENT_VERSION,
    eventId: opaqueString(event.eventId, "event.eventId"),
    jobId: opaqueString(event.jobId, "event.jobId"),
    revision: positiveInteger(event.revision, "event.revision"),
    attempt: attemptAt(event.attempt, "event.attempt"),
  };

  if (event.type === "job.transitioned") {
    return Object.freeze({
      ...base,
      type: "job.transitioned",
      payload: transitionPayloadAt(event.payload),
    });
  }
  if (event.type === "job.validation-recorded") {
    return Object.freeze({
      ...base,
      type: "job.validation-recorded",
      payload: evidencePayloadAt(
        event.payload,
        "validation",
      ) as ValidationRecordedPayload,
    });
  }
  if (event.type === "job.review-recorded") {
    return Object.freeze({
      ...base,
      type: "job.review-recorded",
      payload: evidencePayloadAt(event.payload, "review") as ReviewRecordedPayload,
    });
  }
  if (event.type === "job.human-merge-observed") {
    return Object.freeze({
      ...base,
      type: "job.human-merge-observed",
      payload: humanMergePayloadAt(event.payload),
    });
  }

  throw new InvalidJobEventError(
    "unknown-event-type",
    "event.type",
    "must be a supported version-1 job event type",
  );
}

/**
 * Validate JSON-like input and return a detached, deeply frozen version-1
 * event. Accessors, symbols, non-enumerable fields, and reflection failures are
 * rejected rather than treated as JSON data.
 */
export function parseJobEvent(value: unknown): JobEvent {
  try {
    return parseJobEventUnchecked(value);
  } catch (error) {
    if (error instanceof InvalidJobEventError) {
      throw error;
    }
    throw new InvalidJobEventError(
      "malformed-event",
      "event",
      "could not be read as deterministic JSON-like data",
    );
  }
}

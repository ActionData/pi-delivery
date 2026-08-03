import {
  InvalidJobEventError,
  attemptAt,
  dataArrayAt,
  deliveryBindingAt,
  exactKeys,
  humanMergeObservationAt,
  nonNegativeInteger,
  opaqueString,
  parseJobEvent,
  positiveInteger,
  reasonAt,
  recordAt,
  stateAt,
  type DeliveryBinding,
  type DeliveryRevisionChange,
  type HumanMergeObservation,
  type JobAttemptIdentity,
  type JobEvent,
  type JobReason,
  type JobTransitionedEvent,
  type ReviewRecordedEvent,
  type ValidationRecordedEvent,
} from "./job-events.js";
import {
  IllegalTransitionError,
  JOB_TRANSITIONS,
  reduceJobState,
  type JobState,
} from "./state-machine.js";

export const JOB_SNAPSHOT_VERSION = 1 as const;

export type JobDeliveryIdentity = DeliveryBinding;

export interface ValidationEvidence {
  readonly delivery: DeliveryBinding;
  readonly evidenceId: string;
  readonly verdict: "passed" | "failed";
}

export interface ReviewEvidence {
  readonly delivery: DeliveryBinding;
  readonly evidenceId: string;
  readonly verdict: "accepted" | "changes-requested";
}

export interface JobSuspension {
  readonly fromState: JobState;
  readonly attempt: JobAttemptIdentity | null;
  readonly reason: JobReason;
}

export interface JobSnapshot {
  readonly snapshotVersion: typeof JOB_SNAPSHOT_VERSION;
  readonly jobId: string;
  readonly revision: number;
  readonly lastEventId: string;
  readonly state: JobState;
  readonly currentAttempt: JobAttemptIdentity | null;
  readonly lastAttempt: JobAttemptIdentity | null;
  readonly attemptCount: number;
  readonly delivery: DeliveryBinding | null;
  readonly validation: ValidationEvidence | null;
  readonly review: ReviewEvidence | null;
  readonly stateReason: JobReason | null;
  readonly suspension: JobSuspension | null;
  readonly completion: HumanMergeObservation | null;
}

export type JobInvariantFailure =
  | "empty-history"
  | "stale-revision"
  | "job-id-mismatch"
  | "duplicate-event-id"
  | "duplicate-attempt-id"
  | "attempt-mismatch"
  | "reason-mismatch"
  | "delivery-mismatch"
  | "evidence-mismatch"
  | "illegal-transition";

export type JobSnapshotValidationFailure =
  | "malformed-snapshot"
  | "unsupported-snapshot-version"
  | "inconsistent-snapshot"
  | "untrusted-snapshot";

export class JobInvariantError extends Error {
  readonly failure: JobInvariantFailure;
  readonly eventId: string | null;

  constructor(
    failure: JobInvariantFailure,
    eventId: string | null,
    message: string,
  ) {
    super(message);
    this.name = "JobInvariantError";
    this.failure = failure;
    this.eventId = eventId;
  }
}

export class InvalidJobSnapshotError extends Error {
  readonly failure: JobSnapshotValidationFailure;
  readonly path: string;

  constructor(
    failure: JobSnapshotValidationFailure,
    path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "InvalidJobSnapshotError";
    this.failure = failure;
    this.path = path;
  }
}

const reasonStateSet = new Set<JobState>([
  "blocked",
  "failed",
  "cancelled",
  "changes-requested",
]);
const invalidationSourceSet = new Set<JobState>([
  "reviewing",
  "finalizing",
  "review-ready",
]);
const deliveryRequiredStateSet = new Set<JobState>([
  "draft-pr",
  "validating",
  "reviewing",
  "changes-requested",
  "fixing",
  "finalizing",
  "review-ready",
  "completed-after-human-merge",
]);
const currentAttemptRequiredStateSet = new Set<JobState>([
  "claimed",
  "planning",
  "implementing",
  "draft-pr",
  "validating",
  "reviewing",
  "changes-requested",
  "fixing",
  "finalizing",
  "review-ready",
  "completed-after-human-merge",
]);
const acceptedEvidenceStateSet = new Set<JobState>([
  "finalizing",
  "review-ready",
  "completed-after-human-merge",
]);
const evidenceForbiddenStateSet = new Set<JobState>([
  "discovered",
  "queued",
  "claimed",
  "planning",
  "implementing",
  "draft-pr",
]);

interface HistoricalIdentities {
  readonly eventIds: ReadonlySet<string>;
  readonly attemptIds: ReadonlySet<string>;
}

const identityHistoryBySnapshot = new WeakMap<JobSnapshot, HistoricalIdentities>();

function invariant(
  failure: JobInvariantFailure,
  eventId: string | null,
  message: string,
): never {
  throw new JobInvariantError(failure, eventId, message);
}

function invalidSnapshot(path: string, message: string): never {
  throw new InvalidJobSnapshotError("inconsistent-snapshot", path, message);
}

function copyAttempt(
  attempt: JobAttemptIdentity | null,
): JobAttemptIdentity | null {
  return attempt === null
    ? null
    : Object.freeze({ id: attempt.id, number: attempt.number });
}

function copyReason(reason: JobReason | null): JobReason | null {
  return reason === null
    ? null
    : Object.freeze({ code: reason.code, summary: reason.summary });
}

function copyDelivery(delivery: DeliveryBinding | null): DeliveryBinding | null {
  return delivery === null
    ? null
    : Object.freeze({
        id: delivery.id,
        baseRevision: delivery.baseRevision,
        headRevision: delivery.headRevision,
      });
}

function copyValidation(
  evidence: ValidationEvidence | null,
): ValidationEvidence | null {
  return evidence === null
    ? null
    : Object.freeze({
        delivery: copyDelivery(evidence.delivery) as DeliveryBinding,
        evidenceId: evidence.evidenceId,
        verdict: evidence.verdict,
      });
}

function copyReview(evidence: ReviewEvidence | null): ReviewEvidence | null {
  return evidence === null
    ? null
    : Object.freeze({
        delivery: copyDelivery(evidence.delivery) as DeliveryBinding,
        evidenceId: evidence.evidenceId,
        verdict: evidence.verdict,
      });
}

function copyObservation(
  observation: HumanMergeObservation | null,
): HumanMergeObservation | null {
  return observation === null
    ? null
    : Object.freeze({
        deliveryId: observation.deliveryId,
        baseRevision: observation.baseRevision,
        headRevision: observation.headRevision,
        mergeRevision: observation.mergeRevision,
        actor: Object.freeze({
          id: observation.actor.id,
          kind: "human" as const,
        }),
      });
}

function freezeSnapshot(snapshot: JobSnapshot): JobSnapshot {
  const suspension =
    snapshot.suspension === null
      ? null
      : Object.freeze({
          fromState: snapshot.suspension.fromState,
          attempt: copyAttempt(snapshot.suspension.attempt),
          reason: copyReason(snapshot.suspension.reason) as JobReason,
        });

  return Object.freeze({
    snapshotVersion: JOB_SNAPSHOT_VERSION,
    jobId: snapshot.jobId,
    revision: snapshot.revision,
    lastEventId: snapshot.lastEventId,
    state: snapshot.state,
    currentAttempt: copyAttempt(snapshot.currentAttempt),
    lastAttempt: copyAttempt(snapshot.lastAttempt),
    attemptCount: snapshot.attemptCount,
    delivery: copyDelivery(snapshot.delivery),
    validation: copyValidation(snapshot.validation),
    review: copyReview(snapshot.review),
    stateReason: copyReason(snapshot.stateReason),
    suspension,
    completion: copyObservation(snapshot.completion),
  });
}

function attemptsEqual(
  left: JobAttemptIdentity | null,
  right: JobAttemptIdentity | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.id === right.id &&
      left.number === right.number)
  );
}

function deliveriesEqual(
  left: DeliveryBinding | null,
  right: DeliveryBinding | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.id === right.id &&
      left.baseRevision === right.baseRevision &&
      left.headRevision === right.headRevision)
  );
}

function parseEvidence(
  value: unknown,
  path: string,
  kind: "validation" | "review",
): ValidationEvidence | ReviewEvidence | null {
  if (value === null) {
    return null;
  }
  const evidence = recordAt(value, path);
  exactKeys(evidence, ["delivery", "evidenceId", "verdict"], path);
  const delivery = deliveryBindingAt(evidence.delivery, `${path}.delivery`);
  const evidenceId = opaqueString(evidence.evidenceId, `${path}.evidenceId`, 1_024);

  if (kind === "validation") {
    if (evidence.verdict !== "passed" && evidence.verdict !== "failed") {
      invalidSnapshot(`${path}.verdict`, "must be passed or failed");
    }
    return Object.freeze({ delivery, evidenceId, verdict: evidence.verdict });
  }
  if (
    evidence.verdict !== "accepted" &&
    evidence.verdict !== "changes-requested"
  ) {
    invalidSnapshot(
      `${path}.verdict`,
      "must be accepted or changes-requested",
    );
  }
  return Object.freeze({ delivery, evidenceId, verdict: evidence.verdict });
}

function parseSnapshotUnchecked(value: unknown): JobSnapshot {
  const snapshot = recordAt(value, "snapshot");
  exactKeys(
    snapshot,
    [
      "snapshotVersion",
      "jobId",
      "revision",
      "lastEventId",
      "state",
      "currentAttempt",
      "lastAttempt",
      "attemptCount",
      "delivery",
      "validation",
      "review",
      "stateReason",
      "suspension",
      "completion",
    ],
    "snapshot",
  );

  if (snapshot.snapshotVersion !== JOB_SNAPSHOT_VERSION) {
    throw new InvalidJobSnapshotError(
      "unsupported-snapshot-version",
      "snapshot.snapshotVersion",
      `must equal ${JOB_SNAPSHOT_VERSION}`,
    );
  }

  const state = stateAt(snapshot.state, "snapshot.state", false) as JobState;
  const currentAttempt = attemptAt(
    snapshot.currentAttempt,
    "snapshot.currentAttempt",
  );
  const lastAttempt = attemptAt(snapshot.lastAttempt, "snapshot.lastAttempt");
  const attemptCount = nonNegativeInteger(
    snapshot.attemptCount,
    "snapshot.attemptCount",
  );
  const delivery =
    snapshot.delivery === null
      ? null
      : deliveryBindingAt(snapshot.delivery, "snapshot.delivery");
  const validation = parseEvidence(
    snapshot.validation,
    "snapshot.validation",
    "validation",
  ) as ValidationEvidence | null;
  const review = parseEvidence(
    snapshot.review,
    "snapshot.review",
    "review",
  ) as ReviewEvidence | null;
  const stateReason = reasonAt(snapshot.stateReason, "snapshot.stateReason");

  let suspension: JobSuspension | null = null;
  if (snapshot.suspension !== null) {
    const rawSuspension = recordAt(snapshot.suspension, "snapshot.suspension");
    exactKeys(
      rawSuspension,
      ["fromState", "attempt", "reason"],
      "snapshot.suspension",
    );
    const parsedReason = reasonAt(
      rawSuspension.reason,
      "snapshot.suspension.reason",
    );
    if (parsedReason === null) {
      invalidSnapshot("snapshot.suspension.reason", "must not be null");
    }
    suspension = Object.freeze({
      fromState: stateAt(
        rawSuspension.fromState,
        "snapshot.suspension.fromState",
        false,
      ) as JobState,
      attempt: attemptAt(
        rawSuspension.attempt,
        "snapshot.suspension.attempt",
      ),
      reason: parsedReason,
    });
  }

  const completion =
    snapshot.completion === null
      ? null
      : humanMergeObservationAt(snapshot.completion, "snapshot.completion");

  const parsed = freezeSnapshot({
    snapshotVersion: JOB_SNAPSHOT_VERSION,
    jobId: opaqueString(snapshot.jobId, "snapshot.jobId"),
    revision: positiveInteger(snapshot.revision, "snapshot.revision"),
    lastEventId: opaqueString(snapshot.lastEventId, "snapshot.lastEventId"),
    state,
    currentAttempt,
    lastAttempt,
    attemptCount,
    delivery,
    validation,
    review,
    stateReason,
    suspension,
    completion,
  });

  validateSnapshotConsistency(parsed);
  return parsed;
}

function validateSnapshotConsistency(snapshot: JobSnapshot): void {
  if (
    snapshot.state === "discovered" &&
    (snapshot.revision !== 1 ||
      snapshot.attemptCount !== 0 ||
      snapshot.currentAttempt !== null ||
      snapshot.lastAttempt !== null ||
      snapshot.delivery !== null ||
      snapshot.validation !== null ||
      snapshot.review !== null)
  ) {
    invalidSnapshot(
      "snapshot",
      "discovered must be the initial revision without attempt, delivery, or evidence",
    );
  }
  if (snapshot.state === "queued" && snapshot.currentAttempt !== null) {
    invalidSnapshot(
      "snapshot.currentAttempt",
      "queued work must not retain a current attempt",
    );
  }
  if (
    evidenceForbiddenStateSet.has(snapshot.state) &&
    (snapshot.validation !== null || snapshot.review !== null)
  ) {
    invalidSnapshot(
      "snapshot.validation",
      `${snapshot.state} must not retain validation or review evidence`,
    );
  }
  if (snapshot.state === "validating" && snapshot.review !== null) {
    invalidSnapshot(
      "snapshot.review",
      "validating must not retain review evidence",
    );
  }
  if (snapshot.attemptCount === 0 && snapshot.lastAttempt !== null) {
    invalidSnapshot("snapshot.lastAttempt", "must be null before any attempt");
  }
  if (
    snapshot.attemptCount > 0 &&
    (snapshot.lastAttempt === null ||
      snapshot.lastAttempt.number !== snapshot.attemptCount)
  ) {
    invalidSnapshot(
      "snapshot.lastAttempt",
      "must identify the most recently numbered attempt",
    );
  }
  if (
    snapshot.currentAttempt !== null &&
    !attemptsEqual(snapshot.currentAttempt, snapshot.lastAttempt)
  ) {
    invalidSnapshot(
      "snapshot.currentAttempt",
      "must match the most recent attempt",
    );
  }
  if (
    currentAttemptRequiredStateSet.has(snapshot.state) &&
    snapshot.currentAttempt === null
  ) {
    invalidSnapshot(
      "snapshot.currentAttempt",
      `${snapshot.state} requires a current attempt`,
    );
  }
  if (deliveryRequiredStateSet.has(snapshot.state) && snapshot.delivery === null) {
    invalidSnapshot(
      "snapshot.delivery",
      `${snapshot.state} requires a delivery binding`,
    );
  }
  if (
    snapshot.validation !== null &&
    !deliveriesEqual(snapshot.validation.delivery, snapshot.delivery)
  ) {
    invalidSnapshot(
      "snapshot.validation.delivery",
      "must match the current delivery",
    );
  }
  if (
    snapshot.review !== null &&
    !deliveriesEqual(snapshot.review.delivery, snapshot.delivery)
  ) {
    invalidSnapshot(
      "snapshot.review.delivery",
      "must match the current delivery",
    );
  }
  if (
    snapshot.review !== null &&
    snapshot.validation?.verdict !== "passed"
  ) {
    invalidSnapshot(
      "snapshot.review",
      "requires successful validation evidence",
    );
  }
  if (
    snapshot.state === "reviewing" &&
    snapshot.validation?.verdict !== "passed"
  ) {
    invalidSnapshot(
      "snapshot.validation",
      "reviewing requires successful validation evidence",
    );
  }
  if (
    (snapshot.state === "changes-requested" || snapshot.state === "fixing") &&
    snapshot.validation?.verdict !== "failed" &&
    snapshot.review?.verdict !== "changes-requested"
  ) {
    invalidSnapshot(
      "snapshot.review",
      `${snapshot.state} requires failed validation or requested review changes`,
    );
  }
  if (
    acceptedEvidenceStateSet.has(snapshot.state) &&
    (snapshot.validation?.verdict !== "passed" ||
      snapshot.review?.verdict !== "accepted")
  ) {
    invalidSnapshot(
      "snapshot.review",
      `${snapshot.state} requires accepted validation and review evidence`,
    );
  }

  const reasonRequired = reasonStateSet.has(snapshot.state);
  if (reasonRequired !== (snapshot.stateReason !== null)) {
    invalidSnapshot(
      "snapshot.stateReason",
      reasonRequired
        ? `${snapshot.state} requires a state reason`
        : `${snapshot.state} must not retain a state reason`,
    );
  }
  if (snapshot.state === "blocked") {
    if (
      snapshot.suspension === null ||
      !attemptsEqual(snapshot.suspension.attempt, snapshot.currentAttempt) ||
      snapshot.suspension.reason.code !== snapshot.stateReason?.code ||
      snapshot.suspension.reason.summary !== snapshot.stateReason?.summary ||
      !JOB_TRANSITIONS[snapshot.suspension.fromState].includes("blocked")
    ) {
      invalidSnapshot(
        "snapshot.suspension",
        "must describe the exact state, attempt, and reason suspended",
      );
    }
  } else if (snapshot.suspension !== null) {
    invalidSnapshot(
      "snapshot.suspension",
      "is allowed only while the job is blocked",
    );
  }

  if (snapshot.state === "completed-after-human-merge") {
    if (
      snapshot.completion === null ||
      snapshot.delivery === null ||
      snapshot.completion.deliveryId !== snapshot.delivery.id ||
      snapshot.completion.baseRevision !== snapshot.delivery.baseRevision ||
      snapshot.completion.headRevision !== snapshot.delivery.headRevision
    ) {
      invalidSnapshot(
        "snapshot.completion",
        "must match the exact completed delivery",
      );
    }
  } else if (snapshot.completion !== null) {
    invalidSnapshot(
      "snapshot.completion",
      "is allowed only after observed human merge",
    );
  }
}

/** Validate, detach, and deeply freeze a persisted or caller-supplied snapshot. */
export function parseJobSnapshot(value: unknown): JobSnapshot {
  try {
    return parseSnapshotUnchecked(value);
  } catch (error) {
    if (error instanceof InvalidJobSnapshotError) {
      throw error;
    }
    if (error instanceof InvalidJobEventError) {
      throw new InvalidJobSnapshotError(
        error.failure === "unsupported-event-version"
          ? "unsupported-snapshot-version"
          : "malformed-snapshot",
        error.path.replace(/^event/, "snapshot"),
        error.message,
      );
    }
    throw new InvalidJobSnapshotError(
      "malformed-snapshot",
      "snapshot",
      "could not be read as deterministic JSON-like data",
    );
  }
}

function isInvalidationEdge(from: JobState, to: JobState): boolean {
  return to === "validating" && invalidationSourceSet.has(from);
}

function reasonIsRequired(from: JobState, to: JobState): boolean {
  return (
    reasonStateSet.has(to) ||
    (from === "blocked" && to === "queued") ||
    isInvalidationEdge(from, to)
  );
}

function validateReason(event: JobTransitionedEvent): void {
  const { from, to, reason } = event.payload;
  if (from === null) {
    if (reason !== null) {
      invariant(
        "reason-mismatch",
        event.eventId,
        "Initial discovery cannot carry a lifecycle reason.",
      );
    }
    return;
  }

  const required = reasonIsRequired(from, to);
  if (required && reason === null) {
    invariant(
      "reason-mismatch",
      event.eventId,
      `${from} -> ${to} requires a normalized reason.`,
    );
  }
  if (!required && reason !== null) {
    invariant(
      "reason-mismatch",
      event.eventId,
      `${from} -> ${to} must not carry a lifecycle reason.`,
    );
  }
}

function deliveryChangeIsAllowed(from: JobState, to: JobState): boolean {
  return (
    (from === "implementing" && to === "draft-pr") ||
    (from === "fixing" && to === "validating") ||
    isInvalidationEdge(from, to)
  );
}

function deliveryChangeIsRequired(from: JobState, to: JobState): boolean {
  return (
    (from === "fixing" && to === "validating") ||
    isInvalidationEdge(from, to)
  );
}

function applyDeliveryChange(
  current: DeliveryBinding | null,
  change: DeliveryRevisionChange | null,
  from: JobState,
  to: JobState,
  eventId: string,
): { delivery: DeliveryBinding | null; changed: boolean } {
  if (change === null) {
    if (deliveryChangeIsRequired(from, to)) {
      invariant(
        "delivery-mismatch",
        eventId,
        `${from} -> ${to} requires an explicit delivery revision change.`,
      );
    }
    if (deliveryRequiredStateSet.has(to) && current === null) {
      invariant(
        "delivery-mismatch",
        eventId,
        `${to} requires a bound delivery identity and revisions.`,
      );
    }
    return { delivery: current, changed: false };
  }

  if (!deliveryChangeIsAllowed(from, to)) {
    invariant(
      "delivery-mismatch",
      eventId,
      `${from} -> ${to} cannot change the delivery revision.`,
    );
  }
  if (!deliveriesEqual(change.from, current)) {
    invariant(
      "delivery-mismatch",
      eventId,
      "Delivery change does not match the aggregate's current delivery.",
    );
  }
  if (current !== null && change.to.id !== current.id) {
    invariant(
      "delivery-mismatch",
      eventId,
      "A delivery revision change cannot replace the delivery identity.",
    );
  }
  if (deliveriesEqual(change.from, change.to)) {
    invariant(
      "delivery-mismatch",
      eventId,
      "Delivery revision changes must change base or head revision.",
    );
  }

  return { delivery: change.to, changed: true };
}

function validateEnvelope(
  current: JobSnapshot | null,
  event: JobEvent,
): void {
  if (current !== null && event.eventId === current.lastEventId) {
    invariant(
      "duplicate-event-id",
      event.eventId,
      `Event ${event.eventId} was already applied.`,
    );
  }

  const expectedRevision = current === null ? 1 : current.revision + 1;
  if (event.revision !== expectedRevision) {
    invariant(
      "stale-revision",
      event.eventId,
      `Expected event revision ${expectedRevision}, received ${event.revision}.`,
    );
  }
  if (current !== null && event.jobId !== current.jobId) {
    invariant(
      "job-id-mismatch",
      event.eventId,
      `Event job ${event.jobId} does not match aggregate ${current.jobId}.`,
    );
  }
}

function assertAttemptMatches(current: JobSnapshot, event: JobEvent): void {
  if (!attemptsEqual(event.attempt, current.currentAttempt)) {
    invariant(
      "attempt-mismatch",
      event.eventId,
      "Event attempt does not match the aggregate's current attempt.",
    );
  }
}

function requireAcceptedEvidence(
  current: JobSnapshot,
  eventId: string,
): void {
  if (
    current.validation?.verdict !== "passed" ||
    current.review?.verdict !== "accepted"
  ) {
    invariant(
      "evidence-mismatch",
      eventId,
      "Transition requires successful validation and accepted review evidence.",
    );
  }
}

function validateTransitionEvidence(
  current: JobSnapshot,
  event: JobTransitionedEvent,
): void {
  const { from, to } = event.payload;
  if (from === "validating" && to === "reviewing") {
    if (current.validation?.verdict !== "passed") {
      invariant(
        "evidence-mismatch",
        event.eventId,
        "Review requires successful validation evidence.",
      );
    }
  }
  if (from === "validating" && to === "changes-requested") {
    if (current.validation?.verdict !== "failed") {
      invariant(
        "evidence-mismatch",
        event.eventId,
        "Validation changes require failed validation evidence.",
      );
    }
  }
  if (from === "reviewing" && to === "changes-requested") {
    if (current.review?.verdict !== "changes-requested") {
      invariant(
        "evidence-mismatch",
        event.eventId,
        "Review changes require changes-requested review evidence.",
      );
    }
  }
  if (
    (from === "reviewing" && to === "finalizing") ||
    (from === "finalizing" && to === "review-ready")
  ) {
    requireAcceptedEvidence(current, event.eventId);
  }
}

function reduceTransition(
  current: JobSnapshot | null,
  event: JobTransitionedEvent,
): JobSnapshot {
  const { from, to, deliveryRevisionChange } = event.payload;
  validateReason(event);

  if (to === "completed-after-human-merge") {
    invariant(
      "illegal-transition",
      event.eventId,
      "Completion requires job.human-merge-observed.",
    );
  }

  if (current === null) {
    if (
      from !== null ||
      to !== "discovered" ||
      event.attempt !== null ||
      deliveryRevisionChange !== null
    ) {
      invariant(
        "illegal-transition",
        event.eventId,
        "The first event must discover the job without attempt or delivery state.",
      );
    }
    return freezeSnapshot({
      snapshotVersion: JOB_SNAPSHOT_VERSION,
      jobId: event.jobId,
      revision: event.revision,
      lastEventId: event.eventId,
      state: "discovered",
      currentAttempt: null,
      lastAttempt: null,
      attemptCount: 0,
      delivery: null,
      validation: null,
      review: null,
      stateReason: null,
      suspension: null,
      completion: null,
    });
  }

  if (from !== current.state) {
    invariant(
      "illegal-transition",
      event.eventId,
      `Transition expected ${from ?? "<none>"}, but current state is ${current.state}.`,
    );
  }
  validateTransitionEvidence(current, event);

  let nextAttempt = current.currentAttempt;
  let lastAttempt = current.lastAttempt;
  let attemptCount = current.attemptCount;

  if (from === "queued" && to === "claimed") {
    if (
      event.attempt === null ||
      event.attempt.number !== current.attemptCount + 1 ||
      event.attempt.id === current.lastAttempt?.id
    ) {
      invariant(
        "attempt-mismatch",
        event.eventId,
        "A claim must introduce the next distinct attempt identity.",
      );
    }
    nextAttempt = event.attempt;
    lastAttempt = event.attempt;
    attemptCount += 1;
  } else if (!attemptsEqual(event.attempt, current.currentAttempt)) {
    invariant(
      "attempt-mismatch",
      event.eventId,
      "Event attempt does not match the aggregate's current attempt.",
    );
  } else if (from === "blocked" && to === "queued") {
    nextAttempt = null;
  }

  let state: JobState;
  try {
    state = reduceJobState(current.state, {
      type: "job.transition",
      from,
      to,
    });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      invariant("illegal-transition", event.eventId, error.message);
    }
    throw error;
  }

  const deliveryResult = applyDeliveryChange(
    current.delivery,
    deliveryRevisionChange,
    from,
    to,
    event.eventId,
  );
  const clearEvidence =
    deliveryResult.changed || (from === "blocked" && to === "queued");
  const stateReason = reasonStateSet.has(to) ? event.payload.reason : null;
  const suspension =
    to === "blocked"
      ? Object.freeze({
          fromState: from,
          attempt: copyAttempt(event.attempt),
          reason: copyReason(event.payload.reason) as JobReason,
        })
      : null;

  return freezeSnapshot({
    snapshotVersion: JOB_SNAPSHOT_VERSION,
    jobId: current.jobId,
    revision: event.revision,
    lastEventId: event.eventId,
    state,
    currentAttempt: nextAttempt,
    lastAttempt,
    attemptCount,
    delivery: deliveryResult.delivery,
    validation: clearEvidence ? null : current.validation,
    review: clearEvidence ? null : current.review,
    stateReason,
    suspension,
    completion: null,
  });
}

function recordValidation(
  current: JobSnapshot,
  event: ValidationRecordedEvent,
): JobSnapshot {
  if (current.state !== "validating") {
    invariant(
      "evidence-mismatch",
      event.eventId,
      "Validation evidence can be recorded only while validating.",
    );
  }
  assertAttemptMatches(current, event);
  if (!deliveriesEqual(event.payload.delivery, current.delivery)) {
    invariant(
      "delivery-mismatch",
      event.eventId,
      "Validation evidence does not match the exact current delivery.",
    );
  }

  return freezeSnapshot({
    ...current,
    revision: event.revision,
    lastEventId: event.eventId,
    validation: event.payload,
    review: null,
  });
}

function recordReview(
  current: JobSnapshot,
  event: ReviewRecordedEvent,
): JobSnapshot {
  if (current.state !== "reviewing") {
    invariant(
      "evidence-mismatch",
      event.eventId,
      "Review evidence can be recorded only while reviewing.",
    );
  }
  assertAttemptMatches(current, event);
  if (!deliveriesEqual(event.payload.delivery, current.delivery)) {
    invariant(
      "delivery-mismatch",
      event.eventId,
      "Review evidence does not match the exact current delivery.",
    );
  }
  if (current.validation?.verdict !== "passed") {
    invariant(
      "evidence-mismatch",
      event.eventId,
      "Review evidence requires successful validation evidence.",
    );
  }

  return freezeSnapshot({
    ...current,
    revision: event.revision,
    lastEventId: event.eventId,
    review: event.payload,
  });
}

function reduceParsedJobEvent(
  current: JobSnapshot | null,
  event: JobEvent,
): JobSnapshot {
  validateEnvelope(current, event);

  if (event.type === "job.transitioned") {
    return reduceTransition(current, event);
  }
  if (current === null) {
    invariant(
      "illegal-transition",
      event.eventId,
      "The first job event must be discovery.",
    );
  }
  if (event.type === "job.validation-recorded") {
    return recordValidation(current, event);
  }
  if (event.type === "job.review-recorded") {
    return recordReview(current, event);
  }

  if (current.state !== "review-ready") {
    invariant(
      "illegal-transition",
      event.eventId,
      "A human merge can complete only a review-ready job.",
    );
  }
  assertAttemptMatches(current, event);
  requireAcceptedEvidence(current, event.eventId);
  const observation = event.payload.observation;
  if (
    current.delivery === null ||
    observation.deliveryId !== current.delivery.id ||
    observation.baseRevision !== current.delivery.baseRevision ||
    observation.headRevision !== current.delivery.headRevision
  ) {
    invariant(
      "delivery-mismatch",
      event.eventId,
      "Merge observation does not match the exact review-ready delivery.",
    );
  }

  let state: JobState;
  try {
    state = reduceJobState(current.state, {
      type: "job.transition",
      from: event.payload.from,
      to: "completed-after-human-merge",
    });
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      invariant("illegal-transition", event.eventId, error.message);
    }
    throw error;
  }

  return freezeSnapshot({
    snapshotVersion: JOB_SNAPSHOT_VERSION,
    jobId: current.jobId,
    revision: event.revision,
    lastEventId: event.eventId,
    state,
    currentAttempt: current.currentAttempt,
    lastAttempt: current.lastAttempt,
    attemptCount: current.attemptCount,
    delivery: current.delivery,
    validation: current.validation,
    review: current.review,
    stateReason: null,
    suspension: null,
    completion: observation,
  });
}

function isClaimEvent(
  event: JobEvent,
): event is JobTransitionedEvent & { attempt: JobAttemptIdentity } {
  return (
    event.type === "job.transitioned" &&
    event.payload.from === "queued" &&
    event.payload.to === "claimed" &&
    event.attempt !== null
  );
}

function advanceWithHistory(
  current: JobSnapshot | null,
  event: JobEvent,
  history: HistoricalIdentities,
): JobSnapshot {
  if (history.eventIds.has(event.eventId)) {
    invariant(
      "duplicate-event-id",
      event.eventId,
      `Event ID ${event.eventId} is reused.`,
    );
  }
  if (isClaimEvent(event) && history.attemptIds.has(event.attempt.id)) {
    invariant(
      "duplicate-attempt-id",
      event.eventId,
      `Attempt ID ${event.attempt.id} is reused.`,
    );
  }

  const next = reduceParsedJobEvent(current, event);
  const eventIds = new Set(history.eventIds);
  const attemptIds = new Set(history.attemptIds);
  eventIds.add(event.eventId);
  if (isClaimEvent(event)) {
    attemptIds.add(event.attempt.id);
  }
  identityHistoryBySnapshot.set(next, { eventIds, attemptIds });
  return next;
}

/**
 * Reduce one event from either no state or an in-process snapshot returned by
 * this reducer/replay module. Serialized snapshots require complete replay
 * until the future store can restore provenance transactionally.
 */
export function reduceJobEvent(
  current: JobSnapshot | null,
  value: unknown,
): JobSnapshot {
  let history: HistoricalIdentities = {
    eventIds: new Set<string>(),
    attemptIds: new Set<string>(),
  };
  if (current !== null) {
    const trustedHistory = identityHistoryBySnapshot.get(current);
    if (trustedHistory === undefined) {
      throw new InvalidJobSnapshotError(
        "untrusted-snapshot",
        "snapshot",
        "must come directly from reduceJobEvent or replayJobEvents",
      );
    }
    history = trustedHistory;
  }

  return advanceWithHistory(current, parseJobEvent(value), history);
}

/** Replay a complete dense JSON-like history and establish snapshot provenance. */
export function replayJobEvents(value: unknown): JobSnapshot {
  const values = dataArrayAt(value, "history");
  if (values.length === 0) {
    invariant("empty-history", null, "Job event history must not be empty.");
  }

  let snapshot: JobSnapshot | null = null;
  let history: HistoricalIdentities = {
    eventIds: new Set<string>(),
    attemptIds: new Set<string>(),
  };
  for (const rawEvent of values) {
    snapshot = advanceWithHistory(snapshot, parseJobEvent(rawEvent), history);
    history = identityHistoryBySnapshot.get(snapshot) as HistoricalIdentities;
  }

  return snapshot as JobSnapshot;
}

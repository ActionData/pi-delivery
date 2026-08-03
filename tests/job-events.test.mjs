import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidJobEventError,
  InvalidJobSnapshotError,
  JobInvariantError,
  parseJobEvent,
  parseJobSnapshot,
  reduceJobEvent,
  replayJobEvents,
} from "../dist/core/index.js";

const JOB_ID = "job-2";
const ATTEMPT_1 = Object.freeze({ id: "attempt-1", number: 1 });
const ATTEMPT_2 = Object.freeze({ id: "attempt-2", number: 2 });
const DELIVERY_1 = Object.freeze({
  id: "delivery-2",
  baseRevision: "base-1",
  headRevision: "head-1",
});
const DELIVERY_2 = Object.freeze({
  id: "delivery-2",
  baseRevision: "base-1",
  headRevision: "head-2",
});

function reason(code = "needs-input", summary = "Required input is missing.") {
  return { code, summary };
}

function transition({
  revision,
  from,
  to,
  attempt = null,
  lifecycleReason = null,
  deliveryRevisionChange = null,
  eventId = `event-${revision}`,
  jobId = JOB_ID,
}) {
  return {
    eventVersion: 1,
    eventId,
    jobId,
    revision,
    attempt,
    type: "job.transitioned",
    payload: {
      from,
      to,
      reason: lifecycleReason,
      deliveryRevisionChange,
    },
  };
}

function validationRecorded({
  revision,
  attempt = ATTEMPT_1,
  delivery = DELIVERY_1,
  verdict = "passed",
  evidenceId = `validation-${revision}`,
  eventId = `event-${revision}`,
  jobId = JOB_ID,
} = {}) {
  return {
    eventVersion: 1,
    eventId,
    jobId,
    revision,
    attempt,
    type: "job.validation-recorded",
    payload: { delivery, evidenceId, verdict },
  };
}

function reviewRecorded({
  revision,
  attempt = ATTEMPT_1,
  delivery = DELIVERY_1,
  verdict = "accepted",
  evidenceId = `review-${revision}`,
  eventId = `event-${revision}`,
  jobId = JOB_ID,
} = {}) {
  return {
    eventVersion: 1,
    eventId,
    jobId,
    revision,
    attempt,
    type: "job.review-recorded",
    payload: { delivery, evidenceId, verdict },
  };
}

function mergeObserved({
  revision,
  attempt = ATTEMPT_1,
  delivery = DELIVERY_1,
  mergeRevision = "merge-1",
  actorId = "maintainer-1",
  actorKind = "human",
  eventId = `event-${revision}`,
  jobId = JOB_ID,
} = {}) {
  return {
    eventVersion: 1,
    eventId,
    jobId,
    revision,
    attempt,
    type: "job.human-merge-observed",
    payload: {
      from: "review-ready",
      observation: {
        deliveryId: delivery.id,
        baseRevision: delivery.baseRevision,
        headRevision: delivery.headRevision,
        mergeRevision,
        actor: { id: actorId, kind: actorKind },
      },
    },
  };
}

function normalReviewReadyEvents() {
  return [
    transition({ revision: 1, from: null, to: "discovered" }),
    transition({ revision: 2, from: "discovered", to: "queued" }),
    transition({ revision: 3, from: "queued", to: "claimed", attempt: ATTEMPT_1 }),
    transition({ revision: 4, from: "claimed", to: "planning", attempt: ATTEMPT_1 }),
    transition({ revision: 5, from: "planning", to: "implementing", attempt: ATTEMPT_1 }),
    transition({
      revision: 6,
      from: "implementing",
      to: "draft-pr",
      attempt: ATTEMPT_1,
      deliveryRevisionChange: { from: null, to: DELIVERY_1 },
    }),
    transition({ revision: 7, from: "draft-pr", to: "validating", attempt: ATTEMPT_1 }),
    validationRecorded({ revision: 8, evidenceId: "validation-1" }),
    transition({ revision: 9, from: "validating", to: "reviewing", attempt: ATTEMPT_1 }),
    reviewRecorded({ revision: 10, evidenceId: "review-1" }),
    transition({ revision: 11, from: "reviewing", to: "finalizing", attempt: ATTEMPT_1 }),
    transition({ revision: 12, from: "finalizing", to: "review-ready", attempt: ATTEMPT_1 }),
  ];
}

function expectInvariant(operation, failure) {
  assert.throws(
    operation,
    (error) => error instanceof JobInvariantError && error.failure === failure,
  );
}

test("normal replay binds accepted evidence and completion to exact base/head", () => {
  const events = [...normalReviewReadyEvents(), mergeObserved({ revision: 13 })];
  const original = structuredClone(events);
  const first = replayJobEvents(events);
  const second = replayJobEvents(events);

  assert.deepEqual(first, second);
  assert.deepEqual(events, original);
  assert.deepEqual(first, {
    snapshotVersion: 1,
    jobId: JOB_ID,
    revision: 13,
    lastEventId: "event-13",
    state: "completed-after-human-merge",
    currentAttempt: ATTEMPT_1,
    lastAttempt: ATTEMPT_1,
    attemptCount: 1,
    delivery: DELIVERY_1,
    validation: {
      delivery: DELIVERY_1,
      evidenceId: "validation-1",
      verdict: "passed",
    },
    review: {
      delivery: DELIVERY_1,
      evidenceId: "review-1",
      verdict: "accepted",
    },
    stateReason: null,
    suspension: null,
    completion: {
      deliveryId: DELIVERY_1.id,
      baseRevision: DELIVERY_1.baseRevision,
      headRevision: DELIVERY_1.headRevision,
      mergeRevision: "merge-1",
      actor: { id: "maintainer-1", kind: "human" },
    },
  });
  for (const nested of [
    first.currentAttempt,
    first.delivery,
    first.validation,
    first.validation.delivery,
    first.review,
    first.review.delivery,
    first.completion,
    first.completion.actor,
  ]) {
    assert.equal(Object.isFrozen(nested), true);
  }
});

test("review-ready requires successful validation and accepted review evidence", () => {
  const beforeValidation = replayJobEvents(normalReviewReadyEvents().slice(0, 7));
  expectInvariant(
    () =>
      reduceJobEvent(
        beforeValidation,
        transition({ revision: 8, from: "validating", to: "reviewing", attempt: ATTEMPT_1 }),
      ),
    "evidence-mismatch",
  );

  const validating = reduceJobEvent(
    beforeValidation,
    validationRecorded({ revision: 8, verdict: "failed" }),
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        validating,
        transition({ revision: 9, from: "validating", to: "reviewing", attempt: ATTEMPT_1 }),
      ),
    "evidence-mismatch",
  );

  const reviewing = replayJobEvents(normalReviewReadyEvents().slice(0, 9));
  expectInvariant(
    () =>
      reduceJobEvent(
        reviewing,
        transition({ revision: 10, from: "reviewing", to: "finalizing", attempt: ATTEMPT_1 }),
      ),
    "evidence-mismatch",
  );
});

test("generic transitions and stale merge observations cannot complete", () => {
  const reviewReady = replayJobEvents(normalReviewReadyEvents());
  expectInvariant(
    () =>
      reduceJobEvent(
        reviewReady,
        transition({
          revision: 13,
          from: "review-ready",
          to: "completed-after-human-merge",
          attempt: ATTEMPT_1,
        }),
      ),
    "illegal-transition",
  );

  for (const delivery of [
    { ...DELIVERY_1, id: "another-delivery" },
    { ...DELIVERY_1, baseRevision: "stale-base" },
    { ...DELIVERY_1, headRevision: "stale-head" },
  ]) {
    expectInvariant(
      () => reduceJobEvent(reviewReady, mergeObserved({ revision: 13, delivery })),
      "delivery-mismatch",
    );
  }

  const reviewing = replayJobEvents(normalReviewReadyEvents().slice(0, 9));
  expectInvariant(
    () => reduceJobEvent(reviewing, mergeObserved({ revision: 10 })),
    "illegal-transition",
  );
});

test("failed validation and requested review changes gate remediation", () => {
  const validatingEvents = normalReviewReadyEvents().slice(0, 7);
  const failedValidation = [
    ...validatingEvents,
    validationRecorded({ revision: 8, verdict: "failed", evidenceId: "validation-failed" }),
    transition({
      revision: 9,
      from: "validating",
      to: "changes-requested",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("validation.failed", "Required validation failed."),
    }),
  ];
  assert.equal(replayJobEvents(failedValidation).state, "changes-requested");

  const reviewingEvents = normalReviewReadyEvents().slice(0, 9);
  const requestedChanges = [
    ...reviewingEvents,
    reviewRecorded({
      revision: 10,
      verdict: "changes-requested",
      evidenceId: "review-findings",
    }),
    transition({
      revision: 11,
      from: "reviewing",
      to: "changes-requested",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("review.finding", "A material finding must be fixed."),
    }),
  ];
  assert.equal(replayJobEvents(requestedChanges).state, "changes-requested");
});

test("fixes change delivery revision and invalidate prior evidence", () => {
  const events = [
    ...normalReviewReadyEvents().slice(0, 9),
    reviewRecorded({ revision: 10, verdict: "changes-requested" }),
    transition({
      revision: 11,
      from: "reviewing",
      to: "changes-requested",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("review.finding", "A material finding must be fixed."),
    }),
    transition({ revision: 12, from: "changes-requested", to: "fixing", attempt: ATTEMPT_1 }),
    transition({
      revision: 13,
      from: "fixing",
      to: "validating",
      attempt: ATTEMPT_1,
      deliveryRevisionChange: { from: DELIVERY_1, to: DELIVERY_2 },
    }),
  ];
  const snapshot = replayJobEvents(events);

  assert.deepEqual(snapshot.delivery, DELIVERY_2);
  assert.equal(snapshot.validation, null);
  assert.equal(snapshot.review, null);
});

test("stale-review invalidation requires reason and changed base/head", () => {
  const reviewing = replayJobEvents(normalReviewReadyEvents().slice(0, 9));
  const valid = transition({
    revision: 10,
    from: "reviewing",
    to: "validating",
    attempt: ATTEMPT_1,
    lifecycleReason: reason("delivery.changed", "The delivery revisions changed."),
    deliveryRevisionChange: { from: DELIVERY_1, to: DELIVERY_2 },
  });
  const invalidated = reduceJobEvent(reviewing, valid);

  assert.deepEqual(invalidated.delivery, DELIVERY_2);
  assert.equal(invalidated.validation, null);
  assert.equal(invalidated.review, null);

  expectInvariant(
    () =>
      reduceJobEvent(
        reviewing,
        transition({
          revision: 10,
          from: "reviewing",
          to: "validating",
          attempt: ATTEMPT_1,
          deliveryRevisionChange: valid.payload.deliveryRevisionChange,
        }),
      ),
    "reason-mismatch",
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        reviewing,
        transition({
          revision: 10,
          from: "reviewing",
          to: "validating",
          attempt: ATTEMPT_1,
          lifecycleReason: reason("delivery.changed", "The delivery revisions changed."),
        }),
      ),
    "delivery-mismatch",
  );
});

test("blocked requeue preserves prior attempt and delivery but clears evidence", () => {
  const reviewing = replayJobEvents(normalReviewReadyEvents().slice(0, 9));
  const blocked = reduceJobEvent(
    reviewing,
    transition({
      revision: 10,
      from: "reviewing",
      to: "blocked",
      attempt: ATTEMPT_1,
      lifecycleReason: reason(),
    }),
  );
  assert.deepEqual(blocked.suspension, {
    fromState: "reviewing",
    attempt: ATTEMPT_1,
    reason: reason(),
  });

  const queued = reduceJobEvent(
    blocked,
    transition({
      revision: 11,
      from: "blocked",
      to: "queued",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("blocker.resolved", "Required input is now available."),
    }),
  );
  assert.equal(queued.currentAttempt, null);
  assert.deepEqual(queued.lastAttempt, ATTEMPT_1);
  assert.equal(queued.attemptCount, 1);
  assert.deepEqual(queued.delivery, DELIVERY_1);
  assert.equal(queued.validation, null);
  assert.equal(queued.review, null);
  assert.equal(queued.suspension, null);

  const claimed = reduceJobEvent(
    queued,
    transition({ revision: 12, from: "queued", to: "claimed", attempt: ATTEMPT_2 }),
  );
  assert.deepEqual(claimed.currentAttempt, ATTEMPT_2);
  assert.equal(claimed.attemptCount, 2);
});

test("full replay rejects non-adjacent reused event and attempt IDs", () => {
  const duplicateEvent = normalReviewReadyEvents().slice(0, 3);
  duplicateEvent[2].eventId = duplicateEvent[0].eventId;
  expectInvariant(() => replayJobEvents(duplicateEvent), "duplicate-event-id");

  const reusedAttempt = [
    transition({ revision: 1, from: null, to: "discovered" }),
    transition({ revision: 2, from: "discovered", to: "queued" }),
    transition({ revision: 3, from: "queued", to: "claimed", attempt: ATTEMPT_1 }),
    transition({
      revision: 4,
      from: "claimed",
      to: "blocked",
      attempt: ATTEMPT_1,
      lifecycleReason: reason(),
    }),
    transition({
      revision: 5,
      from: "blocked",
      to: "queued",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("blocker.resolved", "The blocker was resolved."),
    }),
    transition({ revision: 6, from: "queued", to: "claimed", attempt: ATTEMPT_2 }),
    transition({
      revision: 7,
      from: "claimed",
      to: "blocked",
      attempt: ATTEMPT_2,
      lifecycleReason: reason(),
    }),
    transition({
      revision: 8,
      from: "blocked",
      to: "queued",
      attempt: ATTEMPT_2,
      lifecycleReason: reason("blocker.resolved", "The blocker was resolved."),
    }),
    transition({
      revision: 9,
      from: "queued",
      to: "claimed",
      attempt: { id: ATTEMPT_1.id, number: 3 },
    }),
  ];
  expectInvariant(() => replayJobEvents(reusedAttempt), "duplicate-attempt-id");
});

test("trusted incremental snapshots retain complete identity provenance", () => {
  let snapshot = reduceJobEvent(
    null,
    transition({ revision: 1, from: null, to: "discovered", eventId: "first-event" }),
  );
  snapshot = reduceJobEvent(
    snapshot,
    transition({ revision: 2, from: "discovered", to: "queued" }),
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        snapshot,
        transition({
          revision: 3,
          from: "queued",
          to: "claimed",
          attempt: ATTEMPT_1,
          eventId: "first-event",
        }),
      ),
    "duplicate-event-id",
  );

  const events = [
    transition({ revision: 3, from: "queued", to: "claimed", attempt: ATTEMPT_1 }),
    transition({
      revision: 4,
      from: "claimed",
      to: "blocked",
      attempt: ATTEMPT_1,
      lifecycleReason: reason(),
    }),
    transition({
      revision: 5,
      from: "blocked",
      to: "queued",
      attempt: ATTEMPT_1,
      lifecycleReason: reason("blocker.resolved", "The blocker was resolved."),
    }),
    transition({ revision: 6, from: "queued", to: "claimed", attempt: ATTEMPT_2 }),
    transition({
      revision: 7,
      from: "claimed",
      to: "blocked",
      attempt: ATTEMPT_2,
      lifecycleReason: reason(),
    }),
    transition({
      revision: 8,
      from: "blocked",
      to: "queued",
      attempt: ATTEMPT_2,
      lifecycleReason: reason("blocker.resolved", "The blocker was resolved."),
    }),
  ];
  for (const event of events) snapshot = reduceJobEvent(snapshot, event);

  expectInvariant(
    () =>
      reduceJobEvent(
        snapshot,
        transition({
          revision: 9,
          from: "queued",
          to: "claimed",
          attempt: { id: ATTEMPT_1.id, number: 3 },
        }),
      ),
    "duplicate-attempt-id",
  );
});

test("incremental reduction validates revisions, immediate duplicates, jobs, and attempts", () => {
  const discovered = reduceJobEvent(
    null,
    transition({ revision: 1, from: null, to: "discovered" }),
  );
  expectInvariant(
    () => reduceJobEvent(discovered, transition({ revision: 3, from: "discovered", to: "queued" })),
    "stale-revision",
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        discovered,
        transition({ revision: 2, from: "discovered", to: "queued", jobId: "other" }),
      ),
    "job-id-mismatch",
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        discovered,
        transition({
          revision: 1,
          from: "discovered",
          to: "queued",
          eventId: discovered.lastEventId,
        }),
      ),
    "duplicate-event-id",
  );

  const queued = reduceJobEvent(
    discovered,
    transition({ revision: 2, from: "discovered", to: "queued" }),
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        queued,
        transition({
          revision: 3,
          from: "queued",
          to: "claimed",
          attempt: { id: "wrong-number", number: 2 },
        }),
      ),
    "attempt-mismatch",
  );
});

test("evidence events require matching state, attempt, and exact delivery", () => {
  const validating = replayJobEvents(normalReviewReadyEvents().slice(0, 7));
  expectInvariant(
    () =>
      reduceJobEvent(
        validating,
        validationRecorded({
          revision: 8,
          delivery: { ...DELIVERY_1, headRevision: "other" },
        }),
      ),
    "delivery-mismatch",
  );
  expectInvariant(
    () =>
      reduceJobEvent(validating, validationRecorded({ revision: 8, attempt: ATTEMPT_2 })),
    "attempt-mismatch",
  );

  const reviewingWithoutValidation = {
    ...validating,
    state: "reviewing",
    revision: 8,
    lastEventId: "forged-state",
  };
  assert.throws(
    () => reduceJobEvent(reviewingWithoutValidation, reviewRecorded({ revision: 9 })),
    InvalidJobSnapshotError,
  );
});

test("parseJobSnapshot rejects unknown, unsupported, and inconsistent snapshots", () => {
  const valid = replayJobEvents(normalReviewReadyEvents());
  assert.deepEqual(parseJobSnapshot(valid), valid);

  for (const forged of [
    { ...valid, extra: true },
    { ...valid, snapshotVersion: 999 },
    { ...valid, attemptCount: -1 },
    { ...valid, validation: null },
    { ...valid, completion: mergeObserved({ revision: 13 }).payload.observation },
    {
      ...valid,
      delivery: { ...valid.delivery, headRevision: "forged" },
    },
  ]) {
    assert.throws(() => parseJobSnapshot(forged), InvalidJobSnapshotError);
  }
});

test("structurally valid serialized snapshots do not establish provenance", () => {
  const trusted = replayJobEvents(normalReviewReadyEvents());
  const parsed = parseJobSnapshot(structuredClone(trusted));

  assert.deepEqual(parsed, trusted);
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(
    () => reduceJobEvent(parsed, mergeObserved({ revision: 13 })),
    (error) =>
      error instanceof InvalidJobSnapshotError &&
      error.failure === "untrusted-snapshot",
  );

  const completed = reduceJobEvent(trusted, mergeObserved({ revision: 13 }));
  assert.equal(completed.state, "completed-after-human-merge");
  assert.equal(Object.isFrozen(completed.completion.actor), true);
});

test("reason and delivery changes are allowed only on semantic edges", () => {
  const discovered = replayJobEvents([
    transition({ revision: 1, from: null, to: "discovered" }),
  ]);
  expectInvariant(
    () =>
      reduceJobEvent(
        discovered,
        transition({
          revision: 2,
          from: "discovered",
          to: "queued",
          lifecycleReason: reason(),
        }),
      ),
    "reason-mismatch",
  );
  expectInvariant(
    () =>
      reduceJobEvent(
        discovered,
        transition({ revision: 2, from: "discovered", to: "blocked" }),
      ),
    "reason-mismatch",
  );

  const planning = replayJobEvents(normalReviewReadyEvents().slice(0, 4));
  expectInvariant(
    () =>
      reduceJobEvent(
        planning,
        transition({
          revision: 5,
          from: "planning",
          to: "implementing",
          attempt: ATTEMPT_1,
          deliveryRevisionChange: { from: null, to: DELIVERY_1 },
        }),
      ),
    "delivery-mismatch",
  );

  const implementing = replayJobEvents(normalReviewReadyEvents().slice(0, 5));
  expectInvariant(
    () =>
      reduceJobEvent(
        implementing,
        transition({ revision: 6, from: "implementing", to: "draft-pr", attempt: ATTEMPT_1 }),
      ),
    "delivery-mismatch",
  );
});

test("parseJobEvent rejects malformed, hidden, accessor, and unsupported input", () => {
  const valid = transition({ revision: 1, from: null, to: "discovered" });
  const hidden = { ...valid };
  Object.defineProperty(hidden, "hidden", { value: true });
  const symbolKey = { ...valid, [Symbol("hidden")]: true };
  const accessor = { ...valid };
  Object.defineProperty(accessor, "eventId", {
    enumerable: true,
    get() {
      return "getter-id";
    },
  });
  const dynamicProxy = new Proxy(valid, {
    get(target, property, receiver) {
      if (property === "eventId") return "dynamic-event";
      return Reflect.get(target, property, receiver);
    },
  });
  const throwingProxy = new Proxy(valid, {
    ownKeys() {
      throw new Error("arbitrary");
    },
  });
  const malformedCases = [
    null,
    { ...valid, extra: true },
    hidden,
    symbolKey,
    accessor,
    dynamicProxy,
    throwingProxy,
    { ...valid, eventId: "" },
    { ...valid, eventId: " ".repeat(513) },
    { ...valid, eventId: "bad\nvalue" },
    { ...valid, revision: 0 },
    { ...valid, revision: 1.5 },
    { ...valid, revision: Number.NaN },
    { ...valid, revision: Number.POSITIVE_INFINITY },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, attempt: { id: "attempt", number: 0 } },
    { ...valid, payload: { ...valid.payload, to: "unknown-state" } },
    { ...valid, payload: { ...valid.payload, extra: true } },
    {
      ...valid,
      payload: {
        ...valid.payload,
        reason: { code: "Invalid Code", summary: "No." },
      },
    },
    {
      ...valid,
      payload: {
        ...valid.payload,
        deliveryRevisionChange: { from: null, to: { id: "delivery" } },
      },
    },
  ];

  for (const value of malformedCases) {
    assert.throws(() => parseJobEvent(value), InvalidJobEventError);
  }

  assert.throws(
    () => parseJobEvent({ ...valid, eventVersion: 2 }),
    (error) =>
      error instanceof InvalidJobEventError &&
      error.failure === "unsupported-event-version",
  );
  assert.throws(
    () => parseJobEvent({ ...valid, type: "job.unknown" }),
    (error) =>
      error instanceof InvalidJobEventError && error.failure === "unknown-event-type",
  );
  assert.throws(
    () => parseJobEvent(mergeObserved({ revision: 1, actorKind: "bot" })),
    InvalidJobEventError,
  );
});

test("parsed events are detached and deeply frozen", () => {
  const input = transition({
    revision: 6,
    from: "implementing",
    to: "draft-pr",
    attempt: ATTEMPT_1,
    deliveryRevisionChange: { from: null, to: { ...DELIVERY_1 } },
  });
  const parsed = parseJobEvent(input);
  input.eventId = "mutated";
  input.payload.to = "failed";
  input.payload.deliveryRevisionChange.to.headRevision = "mutated";

  assert.equal(parsed.eventId, "event-6");
  assert.equal(parsed.payload.to, "draft-pr");
  assert.equal(parsed.payload.deliveryRevisionChange.to.headRevision, "head-1");
  for (const nested of [
    parsed,
    parsed.attempt,
    parsed.payload,
    parsed.payload.deliveryRevisionChange,
    parsed.payload.deliveryRevisionChange.to,
  ]) {
    assert.equal(Object.isFrozen(nested), true);
  }
});

test("replay rejects proxy, accessor, sparse, and extra-property histories", () => {
  const event = transition({ revision: 1, from: null, to: "discovered" });
  const proxy = new Proxy([event], {
    get(target, property, receiver) {
      return Reflect.get(target, property, receiver);
    },
  });
  const accessor = [event];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      return event;
    },
  });
  const sparse = [];
  sparse.length = 1;
  const extra = [event];
  extra.extra = true;

  for (const history of [proxy, accessor, sparse, extra]) {
    assert.throws(() => replayJobEvents(history), InvalidJobEventError);
  }
});

test("empty histories fail deterministically", () => {
  expectInvariant(() => replayJobEvents([]), "empty-history");
});

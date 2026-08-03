import assert from "node:assert/strict";
import test from "node:test";

import {
  IllegalTransitionError,
  JOB_STATES,
  JOB_TRANSITIONS,
  isTerminalJobState,
  reduceJobState,
} from "../dist/core/index.js";

const expectedTransitions = {
  discovered: ["queued", "blocked", "failed", "cancelled"],
  queued: ["claimed", "blocked", "failed", "cancelled"],
  claimed: ["planning", "blocked", "failed", "cancelled"],
  planning: ["implementing", "blocked", "failed", "cancelled"],
  implementing: ["draft-pr", "blocked", "failed", "cancelled"],
  "draft-pr": ["validating", "blocked", "failed", "cancelled"],
  validating: ["reviewing", "changes-requested", "blocked", "failed", "cancelled"],
  reviewing: [
    "validating",
    "changes-requested",
    "finalizing",
    "blocked",
    "failed",
    "cancelled",
  ],
  "changes-requested": ["fixing", "blocked", "failed", "cancelled"],
  fixing: ["validating", "blocked", "failed", "cancelled"],
  finalizing: ["validating", "review-ready", "blocked", "failed", "cancelled"],
  "review-ready": [
    "validating",
    "completed-after-human-merge",
    "blocked",
    "failed",
    "cancelled",
  ],
  blocked: ["queued", "failed", "cancelled"],
  failed: [],
  cancelled: [],
  "completed-after-human-merge": [],
};

function transition(from, to) {
  return Object.freeze({ type: "job.transition", from, to });
}

function replay(events) {
  return events.reduce((state, event) => reduceJobState(state, event), null);
}

test("the normal lifecycle reaches the human-merge terminal state", () => {
  const states = [
    "discovered",
    "queued",
    "claimed",
    "planning",
    "implementing",
    "draft-pr",
    "validating",
    "reviewing",
    "finalizing",
    "review-ready",
    "completed-after-human-merge",
  ];
  const events = states.map((to, index) =>
    transition(index === 0 ? null : states[index - 1], to),
  );

  assert.equal(replay(events), "completed-after-human-merge");
});

test("a review finding follows the fix and revalidation loop", () => {
  const events = [
    transition(null, "discovered"),
    transition("discovered", "queued"),
    transition("queued", "claimed"),
    transition("claimed", "planning"),
    transition("planning", "implementing"),
    transition("implementing", "draft-pr"),
    transition("draft-pr", "validating"),
    transition("validating", "reviewing"),
    transition("reviewing", "changes-requested"),
    transition("changes-requested", "fixing"),
    transition("fixing", "validating"),
    transition("validating", "reviewing"),
    transition("reviewing", "finalizing"),
    transition("finalizing", "review-ready"),
  ];

  assert.equal(replay(events), "review-ready");
});

test("blocked work resumes conservatively by re-entering the queue", () => {
  assert.equal(
    replay([
      transition(null, "discovered"),
      transition("discovered", "queued"),
      transition("queued", "claimed"),
      transition("claimed", "blocked"),
      transition("blocked", "queued"),
    ]),
    "queued",
  );
});

test("the exported allowlist is immutable and every edge is enforced", () => {
  assert.deepEqual(JOB_TRANSITIONS, expectedTransitions);
  assert.equal(Object.isFrozen(JOB_TRANSITIONS), true);

  for (const targets of Object.values(JOB_TRANSITIONS)) {
    assert.equal(Object.isFrozen(targets), true);
  }

  for (const from of [null, ...JOB_STATES]) {
    const allowed = new Set(from === null ? ["discovered"] : expectedTransitions[from]);

    for (const to of JOB_STATES) {
      if (allowed.has(to)) {
        assert.equal(reduceJobState(from, transition(from, to)), to);
      } else {
        assert.throws(
          () => reduceJobState(from, transition(from, to)),
          (error) =>
            error instanceof IllegalTransitionError &&
            error.failure === "illegal-transition",
          `${from ?? "<none>"} -> ${to}`,
        );
      }
    }
  }
});

test("completion is available only from review-ready", () => {
  for (const state of JOB_STATES) {
    if (state === "review-ready") {
      assert.equal(
        reduceJobState(state, transition(state, "completed-after-human-merge")),
        "completed-after-human-merge",
      );
      continue;
    }

    assert.throws(
      () => reduceJobState(state, transition(state, "completed-after-human-merge")),
      IllegalTransitionError,
    );
  }
});

test("a stale transition fails without mutating the event", () => {
  const stale = transition("queued", "claimed");

  assert.throws(
    () => reduceJobState("discovered", stale),
    (error) =>
      error instanceof IllegalTransitionError &&
      error.failure === "stale-source" &&
      error.current === "discovered",
  );
  assert.deepEqual(stale, {
    type: "job.transition",
    from: "queued",
    to: "claimed",
  });
});

test("terminal states cannot advance", () => {
  for (const state of ["failed", "cancelled", "completed-after-human-merge"]) {
    assert.equal(isTerminalJobState(state), true);
    assert.deepEqual(JOB_TRANSITIONS[state], []);
  }
});

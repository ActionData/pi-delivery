export const JOB_STATES = Object.freeze([
  "discovered",
  "queued",
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
  "blocked",
  "failed",
  "cancelled",
  "completed-after-human-merge",
] as const);

export type JobState = (typeof JOB_STATES)[number];

/**
 * Low-level adjacency input. This primitive does not validate durable event
 * identity, revisions, attempts, reasons, delivery evidence, or merge proof.
 * Use reduceJobEvent/replayJobEvents for the authoritative job aggregate.
 */
export interface JobTransitionEvent {
  readonly type: "job.transition";
  readonly from: JobState | null;
  readonly to: JobState;
}

const transitionTable = {
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
  // Resume is a conservative requeue. Durable reconciliation must inspect any
  // existing branch, PR, and effects before the job can be claimed again.
  blocked: ["queued", "failed", "cancelled"],
  failed: [],
  cancelled: [],
  "completed-after-human-merge": [],
} as const satisfies Record<JobState, readonly JobState[]>;

for (const targets of Object.values(transitionTable)) {
  Object.freeze(targets);
}

export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> =
  Object.freeze(transitionTable);

export const TERMINAL_JOB_STATES = Object.freeze([
  "failed",
  "cancelled",
  "completed-after-human-merge",
] as const satisfies readonly JobState[]);

export type TransitionFailure = "stale-source" | "illegal-transition";

export class IllegalTransitionError extends Error {
  readonly failure: TransitionFailure;
  readonly current: JobState | null;
  readonly event: JobTransitionEvent;

  constructor(
    failure: TransitionFailure,
    current: JobState | null,
    event: JobTransitionEvent,
  ) {
    const renderedCurrent = current ?? "<none>";
    const message =
      failure === "stale-source"
        ? `Transition expected ${event.from ?? "<none>"}, but current state is ${renderedCurrent}.`
        : `Transition from ${event.from ?? "<none>"} to ${event.to} is not allowed.`;

    super(message);
    this.name = "IllegalTransitionError";
    this.failure = failure;
    this.current = current;
    this.event = event;
  }
}

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(
    state as (typeof TERMINAL_JOB_STATES)[number],
  );
}

export function canTransition(
  from: JobState | null,
  to: JobState,
): boolean {
  if (from === null) {
    return to === "discovered";
  }

  return JOB_TRANSITIONS[from].includes(to);
}

/**
 * Validate state adjacency only. In particular, this function can validate
 * review-ready -> completed-after-human-merge without proving a merge. The
 * authoritative durable boundary is reduceJobEvent/replayJobEvents.
 */
export function reduceJobState(
  current: JobState | null,
  event: JobTransitionEvent,
): JobState {
  if (event.from !== current) {
    throw new IllegalTransitionError("stale-source", current, event);
  }

  if (!canTransition(event.from, event.to)) {
    throw new IllegalTransitionError("illegal-transition", current, event);
  }

  return event.to;
}

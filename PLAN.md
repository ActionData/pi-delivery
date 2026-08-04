# pi-delivery plan

**Status:** Phase 0/1 implementation

**License:** MIT

**Initial delivery target:** GitHub pull requests

**Issue sources:** GitHub Issues, Linear, and Jira Cloud

## Resolved scaffold decisions

- npm package name: `@actiondata/pi-delivery` (publication rights still require verification);
- minimum Node.js version: `22.19.0`;
- package manager: npm `10.9.7` with a committed lockfile;
- implementation language: strict TypeScript `5.9.3`, NodeNext ESM;
- test runner: credential-free `node:test`;
- initial compatibility target: Pi `0.83.0` with `pi-subagents` `0.40.0`, pending a dedicated compatibility probe;
- SQLite implementation: Node 22's built-in `node:sqlite`, with explicit configured paths and Git-common-directory derivation both supported.

## Vision

`pi-delivery` will be an open-source Pi package and durable backlog runner that carries an approved, PR-sized issue from a configured issue tracker through planning, implementation, validation, independent review, remediation, and a human-review-ready GitHub pull request.

The workflow uses [`pi-subagents`](https://github.com/nicobailon/pi-subagents) as its agent-execution substrate. Agents reason about and change code; deterministic software owns claims, leases, lifecycle transitions, credentials, retries, validation gates, review evidence, and GitHub mutations.

The default experience is generic-first. Projects should work with generic agents and inherited `AGENTS.md` or `CLAUDE.md` context. Project-specific agents are optional role overrides introduced only when repeated evidence shows that generic roles are insufficient.

## Desired outcome

A project maintainer can:

1. install the package;
2. run a guided initialization skill;
3. select GitHub Issues, Linear, or Jira as the authoritative backlog;
4. configure the candidate query, validation, review, and authority boundaries;
5. run one issue or start a durable backlog runner; and
6. receive a tested, independently reviewed, human-ready GitHub pull request.

The initial workflow never merges or deploys.

## Core decisions

1. Build a standalone Pi package named `@actiondata/pi-delivery`; publishing remains gated on npm ownership and release review.
2. Use `pi-subagents` through its supported tool and stable v1 RPC/event surface rather than importing private internals.
3. Separate the issue source from the code-delivery target:
   - `IssueTracker`: GitHub Issues, Linear, or Jira;
   - `Forge`: GitHub repositories, branches, checks, and pull requests.
4. Put lifecycle decisions in a deterministic state machine, not agent prompts.
5. Use a shared engine with:
   - a foreground/headless CLI and durable daemon runner;
   - a thin Pi extension for control and visibility;
   - an onboarding skill;
   - generic package-owned workflow roles.
6. Use SQLite and an append-only event journal for a single trusted runner host in 1.0.
7. Treat tracker statuses, labels, and comments as human-facing projections, not atomic locks.
8. Bind validation and review evidence to immutable base and head commit identifiers.
9. Require fresh-context independent agent reviews and invalidate them after every new commit.
10. Require a human merge decision; additional third-party human approval is configurable and repository policy remains authoritative.
11. Support an existing authenticated GitHub user as the baseline mutation actor; GitHub Apps and dedicated bot identities remain optional hardening choices, not installation requirements.

## Reference implementation

[ActionData/shipyard#2](https://github.com/ActionData/shipyard/pull/2) is the initial project-specific reference. It demonstrates useful patterns that should be preserved:

- an explicitly bound mutation identity, with a dedicated least-privilege identity as optional hardening;
- environment and tool allowlists;
- single-writer worktrees;
- exact-SHA PR lifecycle transitions;
- complete diff evidence;
- structured review rounds;
- stale-approval invalidation;
- human-only merge;
- credential-free CI; and
- behavioral policy tests.

The generic package must not copy Shipyard-specific repository names, models, agents, labels, users, product invariants, or Cloudflare policies into its core.

## Architecture

Begin as one npm package with explicit internal boundaries:

```text
pi-delivery/
├── src/
│   ├── core/             # State machine, effects, invariants, reconciliation
│   ├── store/            # SQLite events, snapshots, leases, and outbox
│   ├── trackers/         # GitHub Issues, Linear, and Jira adapters
│   ├── forge/github/     # Git, PRs, checks, diffs, and lifecycle projections
│   ├── runtime/pi/       # Pi SDK and pi-subagents compatibility boundary
│   ├── git/              # Worktrees, branches, repository and path policy
│   ├── validation/       # Named CI gates and optional controlled commands
│   ├── review/           # Review dispatch, attestations, rounds, findings
│   ├── config/           # Schema, validation, migration, and redaction
│   ├── daemon/           # Candidate polling and job scheduling
│   └── extension.ts      # Thin Pi control extension
├── agents/               # Generic hardened workflow agents
├── skills/delivery-init/ # Guided project onboarding
├── schema/               # Public configuration schema
├── templates/            # PR and GitHub workflow templates
├── tests/
└── bin/pi-delivery.mjs
```

Split components into separate npm packages only after independent reuse is demonstrated.

## Runtime ownership

### Durable runner owns

- polling and candidate selection;
- claims, leases, and fencing tokens;
- state transitions and retries;
- worktree and branch ownership;
- tracker and GitHub credentials;
- tracker, branch, and PR mutations;
- validation and review gates;
- reconciliation after crashes or ambiguous API responses.

### Agents own

- repository reconnaissance;
- implementation planning;
- implementation;
- evidence-based review;
- focused remediation.

### Pi extension owns

- status and queue visibility;
- enqueueing an approved issue;
- pause, resume, cancel, and reconcile requests;
- supplying a required human decision;
- surfacing blockers and review-ready PRs.

The extension is not a second scheduler. If the runner is unavailable, the extension reports that state instead of advancing jobs itself.

## Durable state machine

Normal path:

```text
discovered
  -> queued
  -> claimed
  -> planning
  -> implementing
  -> draft-pr
  -> validating
  -> reviewing
  -> changes-requested
  -> fixing
  -> validating
  -> reviewing
  -> finalizing
  -> review-ready
```

Suspended or terminal states:

```text
blocked
failed
cancelled
completed-after-human-merge
```

Every transition is produced by a pure reducer from persisted events. Illegal transitions, stale evidence, and a second writer fail before external mutation.

Persist at least:

- provider connection, immutable issue ID, human key, URL, and revision;
- normalized issue snapshot and authorization decision;
- repository identity and default branch;
- job, run, attempt, and agent invocation IDs;
- lease owner, expiration, heartbeat, and fencing token;
- expected base SHA;
- worktree, branch, local head, and dirty-state metadata;
- PR number, base SHA, and head SHA;
- validation policy and results;
- review input/output and agent-configuration digests;
- structured findings and dispositions;
- retry classification and blocker reason;
- every intended and completed external effect.

## External-effect protocol

Every state-changing external operation follows:

```text
persist effect intent
  -> execute
  -> read current external state
  -> reconcile
  -> persist completion or ambiguity
```

Each effect has a stable idempotency key, job ID, attempt ID, and current fencing token. A timeout is not treated as failure until remote state has been reconciled.

This protocol applies to:

- tracker comments, labels, and transitions;
- branch pushes;
- PR creation and edits;
- lifecycle projections;
- review publication;
- readiness and review requests.

## State storage and leases

Use SQLite in WAL mode, initially under the Git common directory so linked worktrees share one store:

```text
<git-common-dir>/pi-delivery/state.sqlite
```

Store:

- append-only events;
- derived job snapshots;
- leases and fencing tokens;
- attempts and runtime identifiers;
- webhook receipts and polling cursors;
- idempotent effect intents and transactional outbox records.

A claim requires an owner/run ID, expiration, heartbeat, and monotonically increasing fencing token. Every mutation verifies the current token.

Provider labels, statuses, and comments make ownership visible but do not provide the lock. Version 1.0 supports one active scheduler host per repository; distributed scheduling requires a transactional remote store and is deferred.

## Generic agent workflow

Default logical roles:

```text
scout
  -> planner
  -> generic implementer
  -> deterministic validation
  -> fresh generic reviewers
  -> generic implementer fix pass
  -> deterministic validation
  -> fresh re-review
```

Default review invocations:

- correctness, regression, and maintainability;
- tests and acceptance criteria.

Risk-triggered generic review invocations:

- security and trust boundaries;
- UX, accessibility, and responsive behavior;
- migrations and data lifecycle;
- CI, infrastructure, or workflow permissions.

The package may use appropriate bundled `pi-subagents` roles where their capabilities fit. It should provide generic hardened implementer/reviewer definitions where an unattended authority boundary requires stricter tools than a bundled role provides. These are reusable package agents, not project-specific agents.

Project-specific agent files are never required. A project may later override any logical role without changing the workflow.

## Repository context

Every agent invocation combines:

1. inherited `AGENTS.md` or `CLAUDE.md` project instructions;
2. the normalized issue contract;
3. configured source-of-truth documents;
4. relevant reconnaissance and planning artifacts;
5. exact base/head identifiers;
6. current validation and review evidence.

The controller always sets `cwd` to the correct repository or worktree. Fresh review means no implementation conversation history; inherited project instructions remain available.

The initializer should detect and reuse existing project guidance rather than generate a redundant policy document. Other documentation is read when named by configuration, named by the issue, or discovered by reconnaissance.

## Issue readiness contract

Before claiming implementation work, the runner normalizes the tracker item into:

- desired outcome;
- verified current behavior where supplied;
- scope and non-goals;
- acceptance criteria;
- dependencies and expected base;
- required validation;
- documentation and migration impact;
- side-effect authorization;
- risk classification.

If consequential required information is missing, the item transitions to `blocked` or a configured needs-clarification tracker state. Agents do not invent product, architecture, security, migration, or deployment authority.

## Tracker adapter contract

The smallest common contract should resemble:

```ts
interface IssueTracker {
  capabilities(): Promise<TrackerCapabilities>;
  listCandidates(query: NativeQuery, cursor?: string): Promise<Page<IssueSummary>>;
  getIssue(id: string): Promise<IssueSnapshot>;
  listTransitions(id: string): Promise<Transition[]>;
  addComment(id: string, comment: SemanticComment, operationId: string): Promise<CommentRef>;
  applyLabels(id: string, patch: LabelPatch, operationId: string): Promise<void>;
  transition(id: string, transitionId: string, operationId: string): Promise<void>;
  linkDelivery(id: string, link: PullRequestLink, operationId: string): Promise<void>;
}
```

Claims belong to the runner's transactional store, not the provider adapter.

Configuration uses provider-native candidate queries. The package should not attempt to translate GitHub queries, Linear GraphQL filters, and Jira JQL into a supposedly lossless common language.

### GitHub Issues

- Support the existing authenticated `gh` user as the first-alpha baseline; also permit a GitHub App installation token or dedicated fine-grained token when available.
- Bind every run to the observed GitHub login, configured repository, and verified repository permissions before mutation.
- Exclude pull requests returned by issue-list APIs.
- Prefer additive label operations over replace-all updates.
- Link PRs with an idempotently marked comment and optional native issue relationship.
- Never add auto-closing keywords unless explicitly configured.

### Linear

- Use the GraphQL API and immutable issue/workflow-state IDs.
- Preserve a configured provider-generated branch name when available.
- Map normalized lifecycle projections to explicit workspace/team state IDs.
- Link the GitHub PR through supported attachments/links or an idempotent comment.
- Support a controlled API key first; retain an OAuth-compatible credential boundary.

### Jira Cloud

- Discover candidates through configured JQL.
- Discover and invoke transition IDs instead of assigning status text.
- Render comments using Atlassian Document Format.
- Link PRs through configured remote links/comments unless richer development integration is available.
- Support controlled email/API-token credentials first; retain an OAuth 2.0-compatible boundary.

### Polling and webhooks

Polling with an overlapping updated-time window is authoritative in the first release. Persist cursors only after processing a complete page and deduplicate by immutable provider IDs.

Signed webhooks can later reduce latency, but they remain hints. Store and deduplicate raw delivery receipts, acknowledge quickly, refetch current issue state, and retain polling to repair missed or out-of-order events.

## Git and worktree policy

The controller creates one persistent issue worktree and one durable branch, for example:

```text
pi/github/123-short-title
pi/linear/ENG-123-short-title
pi/jira/ABC-123-short-title
```

Rules:

- exactly one writer per job and PR;
- no default-branch push;
- no amend, squash, rebase, or force-push after PR publication;
- no merge or deployment operation;
- in authenticated-user mode, use controller-invoked GitHub HTTPS transport backed by the configured `gh` credential; reject SSH, non-GitHub push targets, and ambient credential-helper selection in the first alpha;
- verify the expected `gh` host/login before each push intent and post-verify the exact remote branch SHA;
- reject `.git`, `.env*`, `node_modules`, path escape, and symlink escape;
- never reset or delete an ambiguous dirty worktree automatically;
- reconcile an existing branch or PR before creating another;
- preserve additive implementation and review-fix history.

Open a draft PR after the first coherent implementation pass. Every new commit invalidates prior validation and review approval.

## Credential and execution boundary

The deterministic runner owns provider operations. Agents are not intentionally passed tracker or GitHub credentials.

- Permit the maintainer's existing authenticated `gh` identity; do not require a separately provisioned bot or GitHub App.
- Discover and record the authenticated login, verify it against configuration, and bind it to an exact repository allowlist before mutation.
- Prefer narrower or short-lived credentials when they are available, but do not make organization-level app/bot administration a prerequisite.
- Do not implement or expose runner operations for merge, administration, branch-protection bypass, Actions secrets, or deployment, even when the authenticated credential itself possesses those permissions.
- Start Pi and child processes from an environment allowlist.
- Disable ambient credential helpers, Git hooks, unapproved extensions, and unapproved skills in unattended mode.
- Treat issue text, comments, repository content, diffs, docs, tests, and tool output as untrusted prompt data.
- Do not execute repository code inside the credential-bearing orchestration process.
- Run project code in credential-free CI or an explicitly configured sandboxed/local validation process.

An existing `gh` login normally lives in the user's home directory or operating-system credential store. Because version 1.0 does not claim an OS sandbox, a child process running as the same OS user may still be able to reach that credential despite environment filtering. `doctor` must report this residual risk; unattended user-authenticated operation requires explicit human acknowledgement or external process isolation. The package must not describe worktrees, tool allowlists, or sanitized environment variables as credential isolation.

## Validation

Default to named GitHub checks for the exact current head SHA. Missing, pending, stale, cancelled, or failed required checks block review readiness.

Optional local validation is administrator-configured as argv arrays, never model-generated shell strings:

```json
{
  "command": ["npm", "test"],
  "timeoutMs": 600000
}
```

Local validation is not intentionally supplied tracker, GitHub, cloud, deployment, or model-provider credentials and runs from an environment allowlist. Without external process isolation, same-OS-user ambient credential reachability remains the documented residual risk above. Issue content cannot add or modify validation commands.

## Review evidence and remediation

Each reviewer runs in a fresh session and receives only the normalized task, inherited repository context, immutable diff/source evidence, and validation results relevant to the review.

An accepted review attestation records:

- runner-issued invocation ID;
- role, provider/model, and agent configuration digest;
- base SHA and head SHA;
- input snapshot digest;
- output digest and terminal runtime status;
- verdict;
- findings with stable ID, severity, evidence, remediation, and disposition.

The controller publishes one append-only review-round record per immutable snapshot. Publication order comes from the durable provider record, not agent timestamps.

Material findings move the job to `changes-requested`. The single writer applies focused additive commits, after which validation and all required reviews run again. Default maximum: two automated fix/re-review rounds before `blocked` escalation.

Critical security, data-loss, migration, or architecture risk cannot be accepted by an agent.

## GitHub pull-request lifecycle

Default human-facing projections:

```text
pi-status:in-progress
pi-status:reviewing
pi-status:changes-requested
pi-status:approved
pi-status:blocked
```

These labels are projections of authoritative runner events. The reconciler repairs missing, duplicate, or inconsistent projections rather than treating labels as the state database.

Every transition verifies and post-verifies repository identity, PR identity, expected source state, base/head SHA, body marker, labels, checks, and draft/readiness state.

Finalization:

1. re-read tracker, branch, PR, checks, findings, and lease;
2. verify the exact head remains unchanged;
3. update a concise decision packet;
4. publish the final control-plane evidence;
5. mark the PR ready;
6. request configured human reviewers.

The runner never merges the PR.

### GitHub actor and human handoff policy

GitHub authentication and human approval are separate concerns:

- On a maintainer-owned repository, the configured policy may require no additional third-party human approval. The authenticated maintainer makes the final merge decision after deterministic validation and independent agent review.
- On a repository governed by another organization, the runner requests configured reviewers and obeys branch protection, rulesets, CODEOWNERS, and other repository requirements. It never attempts to bypass them.
- Every PR requires a human merge decision outside the runner.
- External-approval policy is a separate dimension: it may require no additional approval, require an approval from a human distinct from both the authenticated mutation actor and PR author, or defer to stricter repository-native policy.
- Neither the authenticated mutation actor nor the PR author can satisfy a configured actor-distinct approval requirement, including when reconciling a pre-existing PR whose author differs from the current actor.
- The decision packet records the authenticated actor, PR author, unconditional human-merge boundary, configured external-approval requirement, and observed repository policy.

The authenticated maintainer may possess merge permission, but `pi-delivery` still provides no merge operation. Human merge means the person decides and performs the merge outside the runner.

## Backlog runner

Commands:

```text
pi-delivery init
pi-delivery doctor
pi-delivery candidates
pi-delivery run --once
pi-delivery serve
pi-delivery status
pi-delivery pause
pi-delivery resume <job>
pi-delivery reconcile <job>
pi-delivery cancel <job>
```

`serve` repeatedly:

1. reconciles interrupted or ambiguous work;
2. renews or expires leases;
3. polls the configured tracker;
4. normalizes and filters eligible candidates;
5. claims work transactionally;
6. executes within configured concurrency and budget limits;
7. projects state to the issue tracker and GitHub;
8. waits for new work or retry deadlines.

Initial concurrency is one active item per repository.

## Project configuration

The onboarding process writes:

```text
.pi/delivery/config.json
```

Configuration sections:

- schema version and project identity;
- GitHub repository and default branch;
- issue tracker and provider-native candidate query;
- tracker state/label/transition mappings;
- GitHub authentication mode, expected actor login, and credential reference where needed, never credential values;
- source-of-truth documents;
- branch naming and worktree root;
- validation mode and required checks;
- generic role mappings and optional overrides;
- review triggers and maximum rounds;
- human handoff policy and optional actor-distinct reviewers;
- lease, retry, concurrency, and budget limits;
- forbidden side effects and safety acknowledgements.

Reject unknown keys, literal token-like values, unsafe branch patterns, absent transition mappings, mutating reviewer roles, and local validation without explicit opt-in.

## Onboarding skill

`/skill:delivery-init` should:

1. inspect repository instructions, scripts, CI, and architecture docs;
2. infer repository, default branch, package manager, and likely checks;
3. ask which tracker is authoritative;
4. ask for the provider-native candidate query and state mappings;
5. confirm the observed GitHub actor and push, draft-PR, local-execution, and preview authority while recording that runner merge and deployment authority are unconditionally denied;
6. confirm validation, independent agent review, human merge, and any additional external-approval policy;
7. select existing `gh` authentication or request credential environment-variable names, never secret values;
8. generate configuration through a schema-validated deterministic tool;
9. run `doctor`;
10. perform a read-only candidate dry run.

No project-specific agents are generated by default. A later specialization workflow may recommend role overrides only after repeated evidence demonstrates a need.

## Pi and pi-subagents integration

`runtime/pi` owns all coupling to Pi and `pi-subagents`.

- Start a headless Pi SDK session with only approved extensions and tools.
- Load a reviewed, pinned `pi-subagents` version.
- Use its stable v1 RPC/event interface for spawn, status, control, and completion inside the Pi process.
- Persist wrapper job IDs, subagent run IDs, artifact references, and terminal results.
- Treat Pi sessions and subagent artifacts as execution observations, never queue truth.
- Probe compatibility at startup and fail closed on unsupported versions or capabilities.
- Maintain a tested Pi/`pi-subagents` compatibility matrix.

## Implementation roadmap

### Phase 0 — Specification and package skeleton

**Progress:** package scaffold and experimental public contracts landed through [issue #1](https://github.com/ActionData/pi-delivery/issues/1); runtime compatibility certification remains tracked in [issue #3](https://github.com/ActionData/pi-delivery/issues/3).

- Create standalone package structure.
- Define interfaces and state machine.
- Document security model and non-goals.
- Extract reusable invariants and behavioral fixtures from the Shipyard reference.
- Pin and audit the target Pi and `pi-subagents` versions.

**Exit gate:** Core contracts contain no Shipyard-specific identifiers or policy.

### Phase 1 — Deterministic core and fake providers

**Progress:** versioned domain events and deterministic replay landed through [issue #2](https://github.com/ActionData/pi-delivery/issues/2); the transactional SQLite journal is tracked in [issue #4](https://github.com/ActionData/pi-delivery/issues/4).

- Implement SQLite journal, snapshots, leases, fencing, and outbox.
- Implement pure reducer, invariants, retry classification, and reconciliation.
- Build fake tracker, forge, validation, and runtime adapters.
- Inject crashes before and after every external effect.

**Exit gate:** Simulated workflows resume without duplicate claims, branches, PRs, comments, reviews, or approvals.

### Phase 2 — GitHub vertical slice

- Implement GitHub Issues and GitHub forge adapters.
- Implement worktree, branch, draft PR, checks, and lifecycle projection.
- Integrate generic agent planning, implementation, review, and one fix loop.
- Add exact-SHA and complete-diff review evidence.

**Exit gate:** One real GitHub issue reaches a reviewed, human-ready PR and recovers from termination at every stage.

### Phase 3 — Runner, Pi extension, and onboarding

- Implement `run --once` and `serve`.
- Add the thin Pi control extension.
- Add `delivery-init`, `doctor`, status, pause, resume, reconcile, and cancel.
- Harden environment, identity, and package-integrity checks.

**Exit gate:** A repository with only normal `AGENTS.md` or `CLAUDE.md` guidance can be onboarded and run without project-specific agents.

### Phase 4 — Linear adapter

- Implement GraphQL polling, pagination, state mapping, comments, and PR links.
- Add rate-limit and ambiguous-mutation reconciliation.
- Run the shared adapter conformance suite.

**Exit gate:** A Linear issue completes the same GitHub PR workflow without core-engine changes.

### Phase 5 — Jira adapter

- Implement JQL polling, pagination, transition discovery, ADF comments, and PR links.
- Contract-test current Jira search, transition, and concurrency semantics.
- Run the shared adapter conformance suite.

**Exit gate:** A Jira issue completes the same GitHub PR workflow without core-engine changes.

### Phase 6 — Hardening and adoption

- Complete security and independent architecture reviews.
- Run fault-injection and provider sandbox suites.
- Add a trusted GitHub workflow that invalidates stale control-plane approval without executing PR code.
- Migrate Shipyard to consume the package while retaining optional specialized role overrides.
- Onboard a second project using only generic roles.

**Exit gate:** Two generic-agent projects and one specialized project operate successfully.

### Phase 7 — Public 1.0

- Publish schemas and compatibility guarantees.
- Add upgrade and state migration tests.
- Document credential setup, recovery, and threat model.
- Verify clean installation and packed package contents.
- Publish only after one real project per tracker completes the full workflow.

## Test strategy

Required suites:

- pure state transition and invariant tests;
- lease, heartbeat, expiry, and stale-fencing tests;
- crash injection around every external mutation;
- tracker adapter conformance tests;
- pagination, rate-limit, timeout, and ambiguous-result tests;
- temporary bare-repository worktree and branch tests;
- exact-SHA diff and stale-review tests;
- independent invocation/attestation tests;
- required-check and finalization race tests;
- path, symlink, transport, credential, and marker-forgery security tests;
- credential-free fake-provider end-to-end tests;
- opt-in live smoke tests against dedicated GitHub, Linear, and Jira sandboxes.

The default test suite requires no external credentials or network access.

## Initial non-goals

Version 1.0 does not provide:

- automatic merge;
- production deployment;
- non-GitHub code hosts;
- distributed multi-host scheduling;
- parallel writers on one PR;
- cross-repository changes;
- autonomous issue decomposition or roadmap generation;
- arbitrary issue-supplied commands;
- autonomous acceptance of critical security, migration, data-loss, or architecture risk;
- an OS sandbox;
- specialized-agent generation during normal onboarding.

## Definition of 1.0

Version 1.0 is ready when:

- GitHub Issues, Linear, and Jira pass the same adapter conformance suite;
- every remote mutation has tested crash/restart reconciliation;
- generic agents successfully operate from normal repository context files;
- stale SHA validation or review evidence cannot approve;
- exactly one writer is enforced;
- workers are not intentionally supplied tracker, GitHub, deployment, or cloud credentials, and ambient same-user reachability is either externally isolated or explicitly acknowledged;
- human merge remains mandatory;
- Shipyard consumes the package successfully;
- at least one real project per tracker completes an issue-to-reviewed-PR run.

## Open decisions

Resolve before implementation reaches the affected phase:

1. Confirm npm `@actiondata` publication ownership and trusted-publishing configuration.
2. Certify the minimum supported Pi and `pi-subagents` versions; the initial test target is Pi `0.83.0` with `pi-subagents` `0.40.0`.
3. The first dedicated test repositories/workspaces/projects for GitHub, Linear, and Jira.
4. Whether a future multi-host state store should target PostgreSQL or another transactional service.

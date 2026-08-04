# Repository instructions

`pi-delivery` is a public, generic-first delivery engine. Read [PLAN.md](./PLAN.md) for architecture and scope and [SECURITY.md](./SECURITY.md) for the authority boundary before changing code.

## Current scope

This repository is pre-alpha. It defines public configuration/lifecycle contracts and an experimental SQLite event journal; it does not yet run agents, trackers, GitHub mutations, leases, an outbox, a daemon, or a CLI.

Keep generic modules free of project-specific repository names, labels, users, models, product rules, and infrastructure policy. Project-specific behavior belongs in configuration or profiles.

## Engineering rules

- Use Node.js 22.19 or newer, npm, strict TypeScript, and ESM.
- Use `.js` specifiers for relative imports in TypeScript source compiled with `NodeNext`.
- Pin dependency versions exactly and commit `package-lock.json`.
- Keep reducers deterministic and free of clocks, credentials, network calls, storage, and model behavior.
- Add tests for every lifecycle transition or public contract change.
- Keep the default test suite credential-free and network-free.
- Do not commit generated `dist/`, package tarballs, credentials, environment files, logs, or runner state.
- Preserve one writer per worktree. Use fresh, read-only review for independent validation.
- Never add automatic merge, deployment, cloud mutation, or arbitrary commands derived from issue content.
- Agents and automation must not accept material security, migration, data-loss, or architecture risk on a human's behalf.

## Validation

Run before handing off a change:

```sh
npm ci
npm run check
git diff --check
```

`npm run check` typechecks, builds, runs `node:test`, and verifies the publish tarball allowlist.

## Change boundaries

SQLite, provider adapters, Pi/`pi-subagents` execution, worktree management, daemon behavior, and operational CLI commands require their own bounded issues and tests. Do not add placeholder runtime dependencies or empty integrations while working on the scaffold.

# pi-delivery

A generic-first Pi backlog runner for carrying GitHub, Linear, or Jira issues through implementation, validation, independent agent review, and a human-ready GitHub pull request.

> **Pre-alpha:** this repository currently provides experimental public contracts and a local SQLite event journal. It does not yet include a runner, CLI, provider integration, leases, an outbox, Pi runtime integration, or unattended operation. Nothing has been published to npm.

See [PLAN.md](./PLAN.md) for the architecture and roadmap.

## Principles

- Generic agents first; project-specific roles only when evidence justifies them.
- Repository context from `AGENTS.md` or `CLAUDE.md` is inherited when available.
- Deterministic software owns claims, credentials, lifecycle, validation, and review gates.
- Agents implement and review; they do not merge or deploy.
- Human merge remains mandatory.

## Current public contracts

The scaffold exports:

- versioned, immutable provider-neutral job events;
- deterministic snapshot reduction and complete-history replay;
- the low-level job-state adjacency primitive;
- a WAL-backed, append-only SQLite journal with optimistic revisions and complete replay;
- an experimental versioned configuration type;
- the matching draft JSON Schema.

The event reducer and complete-history replay API form the authoritative pre-alpha lifecycle boundary. They bind validation and review attestations to exact opaque base/head revisions and require an exact matching human-merge observation. Complete replay establishes private in-process snapshot provenance and historical identity uniqueness; one-step reduction accepts only snapshots returned by that reducer/replay chain. The SQLite journal restores that provenance through complete replay and treats persisted snapshots only as integrity witnesses. The state-only reducer validates adjacency without event identity, attempt, evidence, delivery-revision, or human-merge proof. The configuration shape is an incomplete placeholder: no runner accepts it, and it will be versioned before operational use. These components remain free of network, credential, tracker, forge, and model execution behavior.

## Development

Requirements:

- Node.js 22.19 or newer;
- npm 10.9.7.

Validate a clean checkout with:

```sh
npm ci
npm run check
git diff --check
```

`npm run check` runs strict TypeScript checking, builds ESM JavaScript and declarations, runs the credential-free `node:test` suite, and verifies the `npm pack` file allowlist.

See [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) for the toolchain and target Pi runtime pair. The Pi runtime pair is not yet certified. See [docs/STATE-STORAGE.md](./docs/STATE-STORAGE.md) for the SQLite journal's location, durability, migration, and trust boundaries.

## Security

Read [SECURITY.md](./SECURITY.md) before testing integrations. Do not provide this pre-alpha scaffold with real tracker, GitHub, model-provider, cloud, merge, or deployment credentials.

## License

[MIT](./LICENSE)

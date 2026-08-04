# Compatibility

`pi-delivery` is pre-alpha and has no certified runtime integration yet.

## Scaffold toolchain

| Component | Version |
| --- | --- |
| Node.js | `>=22.19.0` |
| npm | `10.9.7` |
| TypeScript | `5.9.3` |

The npm lockfile is authoritative for development dependencies.

## Target Pi runtime pair

| Component | Development target |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `0.83.0` |
| `pi-subagents` | `0.40.0` |

These versions are documented targets, not supported peer ranges or certified dependencies. The package does not yet import or execute either project. Certification requires a dedicated source review, a credential-free compatibility probe against supported public interfaces, and fail-closed tests for unsupported versions.

`pi-subagents` 0.40.0 declares broad optional Pi peer ranges and was developed against Pi 0.81.0. Do not infer Pi 0.83.0 compatibility from installation success alone.

## Core contract versioning

The authoritative pre-alpha lifecycle API uses job event version `1` and derived snapshot version `1`. It binds successful validation and accepted review evidence to an opaque delivery ID plus exact base/head revisions, invalidates that evidence after every delivery change, and permits completion only after an exact matching human-merge observation.

`parseJobEvent` and `parseJobSnapshot` validate untrusted JSON-like structures, but structural snapshot validation does not prove journal provenance. `replayJobEvents` validates the complete history, including non-adjacent event-ID and attempt-ID reuse, and returns an in-process provenance-bound snapshot. `reduceJobEvent` accepts only `null` or a snapshot returned directly by the same in-process reducer/replay module, whose private provenance also retains complete identity history. The SQLite store restores provenance by completely replaying its journal and comparing the serialized snapshot as an integrity witness; deserialization alone never establishes trust.

The `human` actor field is an attestation, not proof discoverable by the pure reducer. A future trusted forge adapter must derive it from provider evidence. The original `reduceJobState` export remains available as a low-level adjacency primitive. It does not validate durable event identity, revisions, attempts, reasons, validation/review evidence, delivery evidence, or merge observations and must not be used as an approval or persisted replay boundary.

An incompatible event or snapshot change requires a new explicit domain version and migration path; existing version-1 meaning must not be silently reinterpreted.

## SQLite storage compatibility

Storage schema version `1` uses Node `>=22.19.0`'s built-in `node:sqlite` `DatabaseSync`, SQLite application ID `0x5049444c`, WAL mode, `synchronous=FULL`, strict tables, and a fingerprinted migration ledger. No third-party SQLite package is installed. Node still marks this API experimental/active development, so the exact Node 22 compatibility floor remains tested rather than assumed.

The store accepts an explicit local database path or derives `pi-delivery/state.sqlite` from a supplied Git common directory. Complete replay remains authoritative; persisted snapshots are compared as integrity witnesses and never restore provenance by deserialization alone. Unsupported schema versions, changed migration inputs, unexpected schema objects, integrity failures, malformed events, and replay/snapshot mismatches fail without downgrade or automatic repair.

Future schema changes require ordered forward migrations. WAL storage is single-host and requires a local filesystem with SQLite locking semantics. See [STATE-STORAGE.md](./STATE-STORAGE.md).

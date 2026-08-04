# State storage

`pi-delivery` uses the built-in Node.js `node:sqlite` `DatabaseSync` API for its pre-alpha single-host job journal. Node 22.19 contains the required API, so the package adds no native npm dependency. The API remains marked experimental/active development by Node and executes synchronously; compatibility and event-loop isolation must be revisited before a supported daemon release.

## Location

Callers may supply an explicit database path or a Git common directory. The default derived location is:

```text
<git-common-dir>/pi-delivery/state.sqlite
```

Git discovery and operational configuration are not implemented by the store. Paths are trusted administrator inputs and must never be derived from issue content. Newly created database files are restricted to owner read/write permissions on platforms that support POSIX modes. Pre-existing database, WAL, SHM, and rollback-journal files must be regular, non-symlinked, owned by the current OS user, and grant no group/world permissions; administrators remain responsible for parent-directory and platform ACLs.

The database requires a local filesystem with SQLite locking and WAL support. Network filesystems are unsupported. SQLite may create adjacent `state.sqlite-wal` and `state.sqlite-shm` files; these are runtime state and must not be committed.

## Connection policy

Every connection enables or verifies:

- WAL journal mode;
- `synchronous=FULL`;
- foreign-key enforcement;
- `trusted_schema=OFF`;
- disabled extension loading and double-quoted string literals;
- strict named-parameter handling;
- BigInt reads for SQLite integers; and
- a bounded lock timeout.

`BEGIN IMMEDIATE` serializes append transactions before they read the current job revision. This is optimistic single-host concurrency control, not a lease or fencing implementation.

## Schema and migrations

Schema version `1` uses SQLite application ID `0x5049444c` (`PIDL`) and a fingerprinted migration ledger. Migrations run transactionally and never downgrade or repair an unknown store.

The schema contains:

- `job_events`: append-only canonical event JSON keyed by job and revision;
- `job_snapshots`: one derived snapshot witness per job; and
- `store_migrations`: reviewed migration names and SHA-256 SQL fingerprints.

Strict tables, foreign keys, uniqueness constraints, contiguous-revision and append-protection triggers, canonical JSON checks, exact schema validation, `quick_check`, and `foreign_key_check` detect structural or accidental corruption.

## Authority and replay

Events are authoritative. A read or restart:

1. loads every event for the job in revision order;
2. compares relational columns with strict parsed event JSON;
3. performs complete domain replay;
4. parses the persisted snapshot structurally;
5. compares the snapshot with complete replay; and
6. returns the replay result with in-process provenance.

Persisted snapshots are integrity witnesses, not trusted checkpoints or a read-performance optimization. A missing, malformed, stale, orphaned, or mismatched snapshot fails closed and is not rebuilt automatically.

Appending an event validates the expected revision, replays current history inside the write transaction, derives the next snapshot, inserts the event, and updates the snapshot before commit. Any failure rolls back both writes.

## Trust and recovery boundary

The store assumes a trusted host. It can detect malformed history and inconsistent relational/snapshot state, but it is not cryptographic tamper evidence against an attacker able to rewrite the database, migration ledger, application code, and filesystem together.

Do not copy only the main database while it is open in WAL mode. Use a closed store or a future reviewed SQLite backup operation so the database and WAL state remain consistent.

This phase intentionally omits leases, fencing tokens, outbox effects, provider cursors, webhooks, multi-host scheduling, automatic repair, and remote databases. Crash injection and complete external-effect recovery remain separate work.

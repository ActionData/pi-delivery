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

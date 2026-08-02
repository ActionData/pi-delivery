# pi-delivery

A generic-first Pi backlog runner for carrying GitHub, Linear, or Jira issues through implementation, validation, independent agent review, and a human-ready GitHub pull request.

This project is in the planning stage. See [PLAN.md](./PLAN.md) for the proposed architecture and roadmap.

## Principles

- Generic agents first; project-specific roles only when evidence justifies them.
- Repository context from `AGENTS.md` or `CLAUDE.md` is inherited when available.
- Deterministic software owns claims, credentials, lifecycle, validation, and review gates.
- Agents implement and review; they do not merge or deploy.
- Human merge remains mandatory.

## License

[MIT](./LICENSE)

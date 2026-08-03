# Security policy

`pi-delivery` is pre-alpha and has no supported release or operational runner.

Please report suspected vulnerabilities privately through GitHub's security advisory feature once enabled for the repository. Do not include credentials, tokens, private issue content, or private repository content in a public issue.

## Pre-alpha boundary

- Do not grant this repository or its tests real GitHub, tracker, model-provider, cloud, merge, deployment, or package-publication credentials.
- The default build and test suite must remain credential-free and network-free after dependency installation.
- Dependencies must use exact versions and a committed npm lockfile.
- Publishing is not authorized until package ownership, trusted publishing, packed contents, provenance, and the release process have been reviewed.
- Pi and `pi-subagents` versions listed in the compatibility document are development targets, not a supported or certified pair.

The planned runner will execute AI agents and may interact with source repositories and issue trackers. Review package source and configuration before granting access. Worktrees and tool restrictions are not an operating-system sandbox.

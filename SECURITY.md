# Security policy

## Supported versions

HarnessOrbit is an early preview. Security fixes are maintained on `main`; separate release maintenance branches have not been established. Update to the latest available fix before reporting a recurring problem.

## Report a vulnerability privately

Use this repository's **Security → Report a vulnerability** option:

[GitHub private vulnerability reporting](https://github.com/Snseam/harnessorbit/security/advisories/new)

Include the affected revision, operating system and tool versions, the expected boundary, and a minimal reproduction using dummy data. Keep tokens, provider credentials, private source code, and real agent transcripts out of the report unless they are strictly necessary; redact them when possible.

Do not disclose exploit details in public issues. If private reporting is unavailable, open an issue requesting a private security contact without including the vulnerability details. No response-time guarantee or bounty program is offered.

## Relevant boundaries

HarnessOrbit launches local coding agents and user-specified verification commands with the caller's permissions. It is not a filesystem or process sandbox. Git worktrees, allowed paths, and state locks coordinate work but do not isolate credentials, ignored untracked files, network access, or other external side effects.

Only run tasks and repositories you intend to authorize. Agent permissions remain the responsibility of the configured agent installation. Logs and state can contain source code or sensitive output; keep the state directory private and do not publish live test artifacts.

Identity confusion, unintended cross-session control, accidental replay, and incorrect acceptance of a candidate are examples of issues worth investigating as potential security problems. See [task states and recovery](docs/states.md) for the implemented guarantees and known limits.

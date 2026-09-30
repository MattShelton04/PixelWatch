# Contributing

PixelWatch is early and maintained by one person. Issues and small PRs are welcome. Please open
an issue before starting anything large.

## Ground rules

These are the same rules coding agents follow (see [`AGENTS.md`](AGENTS.md)):

- The security model in [`docs/design/01-architecture-and-security.md`](docs/design/01-architecture-and-security.md)
  §4 is non-negotiable. If a change seems to need weakening it, stop and raise it in an issue.
- The MVP is exactly milestones M0–M3 ([`08-implementation-plan.md`](docs/design/08-implementation-plan.md)).
  Don't implement anything from [`docs/design/future/`](docs/design/future/). Park ideas as
  issues labelled `later`.
- If the design docs conflict or look wrong, say so in the issue or PR and propose the minimal
  fix. Don't silently pick one. Fix the doc in the same PR as the code.
- Decisions and deliberate deviations are recorded as ADRs in [`docs/adr/`](docs/adr/) (copy
  `0000-template.md`).
- Don't fabricate test results or prototype outputs. Say what didn't run.
- No new runtime dependency in the trusted path (publisher, store, GitHub client, action)
  without an ADR.

## Before you open a PR

```sh
pnpm install --frozen-lockfile
pnpm tools:install
pnpm check
```

`pnpm check` must pass with no network access. A PR description lists what changed, what you
ran and its result, anything you didn't run, and any design-doc changes.

Workflow changes pin every action to a full commit SHA with a version comment, and must pass
`pnpm lint:workflows` (actionlint + zizmor).

## Licence

By contributing, you agree that your contributions are licensed under [Apache-2.0](LICENSE).

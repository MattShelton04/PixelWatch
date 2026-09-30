# PixelWatch

> Working name. It collides with Google's Pixel Watch, so a different name will be chosen before
> anyone outside the project pins a release.

PixelWatch is a self-hosted visual-regression review tool for public GitHub repositories. It
captures screenshots in CI, compares base against head, keeps a history site on GitHub Pages,
maintains one sticky PR comment, and publishes a machine-readable `changes.json` for people and
coding agents. There's no hosted service, GitHub App, secret or AI in CI.

## Status

**Pre-alpha. Nothing is usable yet.** The design is complete for the MVP (milestones M0–M3), and
implementation has just started. There are no releases, packages or actions to install.

- Design: [`docs/design/00-README.md`](docs/design/00-README.md)
- Plan and milestones: [`docs/design/08-implementation-plan.md`](docs/design/08-implementation-plan.md)
- Decisions: [`docs/adr/`](docs/adr/)

## Development

Requires Node ≥ 22.18 (CI uses the version in `.node-version`) and pnpm via Corepack.

```sh
pnpm install
pnpm tools:install   # pinned actionlint + zizmor into .tools/bin (network)
pnpm check           # lint, typecheck, tests, workflow lint (no network)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md).

## Security

See [`SECURITY.md`](SECURITY.md). Everything PixelWatch publishes to Pages is public.

## Licence

[Apache-2.0](LICENSE). Code ported from the PropertyScope and TracePilot prototypes is reused
with its author's permission; see [`docs/adr/0001-reference-inputs.md`](docs/adr/0001-reference-inputs.md).

# 06 · Repository, release and distribution

MVP distribution is a full-SHA-pinned reusable workflow plus a bundled JavaScript action.
The public CLI, SDKs, runner image and npm/PyPI packages are M4+. Don't publish placeholders.

## 1. Accounts

- Product repo: the owner's personal account (`OWNER/pixelwatch`). Use `OWNER` in templates
  until it's set.
- A separate free organisation holds **only** the e2e test repos (07 §4).
- Choose the final name before outside adopters pin it. GitHub redirects renamed/transferred repos
  for Git and web, but **not** for `uses:` references to actions/reusable workflows, and Pages URLs
  don't redirect. A later move means adopters must update their workflows.

## 2. Monorepo layout

Create only what the current milestone implements. No empty packages.

```text
packages/
  schemas/        # JSON Schemas (02 §1), generated TS types, validators, canonical serializer
  core/           # pure: PNG decode/encode, pixel hash, compare, merge, model, retention, projection
  store/          # local-dir and git-branch store adapters
  forge-github/   # typed GitHub API: runs, artifacts, PR association, comments, Pages
  publisher/      # orchestration: ingest job, project/deploy/comment job, site builder
  viewer/         # the one viewer app (minimal in M2, full in M3)
actions/publish/  # action.yml; dist/ exists only in release commits
.github/workflows/
  report.yml      # the reusable workflow adopters call
  ci.yml          # this repo's checks
tools/            # internal dev CLI, local simulation harness/specifications (ADR 0015), releases
testdata/         # small fixtures and goldens; no tokens or signed URLs
docs/design/  docs/adr/  docs/security/
```

**Tooling:** pnpm workspaces with a lockfile; TypeScript `strict`; ESLint (bans `innerHTML` & co);
Vitest + fast-check; esbuild; Playwright Test for the viewer; `actionlint` and `zizmor` for
workflows. Pin tool versions at M0. The core takes clock, policy and tree listings as inputs and
does no network, filesystem or process access. Deterministic CI on Linux and Windows. The
publisher runtime targets GitHub-hosted Linux, with `runs.using: node24`.

## 3. Reusable-workflow self-reference

A reusable workflow can't use `uses: ./actions/publish`: that resolves against the **caller's**
checkout. A commit also can't contain its own SHA, so "rewrite refs to the release SHA" is
impossible. Instead, use the documented job context (GitHub.com only; GHES not supported):

```yaml
# inside .github/workflows/report.yml, each job
steps:
  - uses: actions/checkout@<audited full SHA>
    with:
      repository: ${{ job.workflow_repository }}
      ref: ${{ job.workflow_sha }}
      path: _pixelwatch
      persist-credentials: false
  - uses: ./_pixelwatch/actions/publish
```

- The action runs the prebuilt `dist/index.js` from that release commit, with no `npm install`,
  build or shell step in the adopter's trusted job.
- If the job fields are missing, **fail**. Never fall back to a branch or moving tag.
- Never use the caller's `github.sha` or `github.repository` to locate product code.
- Release acceptance (spike S4, then every release) proves:
  - a caller pinned by full SHA runs exactly that commit's bundle;
  - the same holds through a nested call;
  - an **old** release still runs its own bundle after a newer one exists.

  If S4 fails, stop and redesign. Don't use moving refs.

## 4. Build outputs

- `main` holds source and lockfile, never `dist/`.
- Release tooling builds in a clean worktree, embeds the version, and creates a release commit
  with `dist/`. The workflow and the bundle live in that same commit.
- Record the source commit and reproducible-build hashes in the release notes.
- Bundle trusted dependencies. Pin, license-track and advisory-track them. Nothing executable is
  fetched at runtime from PR output or the store.

## 5. Release pipeline

1. From an approved source commit: set the version, build, run `pnpm check` plus the
   parser/race/golden suites and the bundle self-tests. Release credentials never touch PR builds.
2. Create the release commit and tag an RC (e.g. `v0.1.0-rc.1`) at its full SHA.
3. Run live e2e, fork-safety and canary checks against that exact RC SHA. Test credentials are
   separate from release credentials.
4. **Final:** rebuild at the final version (an RC build reports its RC version), create the
   final release commit, and rerun the deterministic tests, self-reference check and a live smoke
   test on it.
5. Tag and publish the final commit and document its full SHA. Never move an existing version
   tag. A moving `v0` alias is optional; the docs always recommend SHA pins.

Later, when npm/PyPI/images exist, publish them under the same logical version (npm
`1.0.0-rc.1` = PyPI `1.0.0rc1`). Record per-registry success, and never overwrite a published
version.

**Compatibility:**

- A pinned publisher refuses newer store data before writing.
- A viewer reads data N and N−1 (04 §3).
- Release notes list supported bundle/config/data versions and any migration.
- A new `dataVersion` isn't a semver major (migration is automatic), but it's called out.

Marketplace listing is optional and post-MVP.

## 6. Adopter consumption (MVP)

The docs cover:

- prerequisites and supported scope (public GitHub.com repos);
- that everything published is public;
- administrator Pages bootstrap (01 §3);
- the data branch;
- the "no existing Pages site" limitation;
- caller permissions;
- both workflows;
- bundle conversion.

All actions are pinned to full SHAs. There's a **manual quickstart** verified on a fresh test
repo (`init` is M4), and a **preflight** that checks workflow IDs, config validity, branch
ownership, Pages source, environment, permissions and base path. The preflight never changes
settings or overwrites a site.

**Upgrade:**

1. Bump the pinned SHA.
2. Read the release notes.
3. Validate config.
4. Preview migration and retention impact.
5. Deploy and verify the new generation.

Document maintenance mode, rollback with a loss preview, reprojection after a deploy failure,
and "rerun all jobs" for incomplete attempts. Uninstalling means disabling the workflows and
deciding explicitly about the data branch, the Pages deployment and backup refs. Dependabot or
Renovate SHA bumps are optional (spike S5).

## 7. Hygiene

- Licence: Apache-2.0 recommended (owner confirms). Record the origin of code reused from
  PropertyScope/TracePilot in `docs/adr/`.
- `SECURITY.md` with private vulnerability reporting and a realistic solo-maintainer support
  statement. A short `CONTRIBUTING.md` covering the AGENTS.md rules.
- Dependabot for this repo, CodeQL, dependency review.
- Protected `main`, and tag protection if the account supports it.
- No telemetry.

# Evidence: S4 reusable-workflow self-checkout (M0.5)

- Date: 2026-09-30
- PixelWatch commit: `ef39750` (no product code involved; spike code lives only in the spike repos)
- Result: **pass**. Decision: [ADR 0006](../adr/0006-s4-reusable-workflow-self-checkout.md).

## Setup

| Item | Value |
|---|---|
| Library (stands in for PixelWatch) | https://github.com/MattShelton04/pixelwatch-spike-lib, repository ID 1397667754, public |
| Caller (stands in for an adopter) | https://github.com/MattShelton04/pixelwatch-spike-app, repository ID 1397668282, public |
| Lib commit A, tag `v0.0.1` | `9c54426c3e5e46bdb6df13819e055a14376fc449`: bundle `v1`, nonce `d77ee74f0fb9ef4f`, `dist/index.js` SHA-256 `a97799e5b871a32d36517f27a26304891464e53d71a55ce79daa0177088c5d22` |
| Lib commit B, tag `v0.0.2` | `7f0ec44808846b50c31387574fac840c21ed85f2`: bundle `v2`, nonce `6667b07e0531783d`, `dist/index.js` SHA-256 `da822ac050b72ea500862a1aa21993c143e1a9e71b3bb772071af204d63fe916` |
| Caller commit | `ca07b3d2d4648f1a8753e4d59cf55df50721127a`. Contains an **impostor** `actions/publish/` at the same path as the library's bundle; it prints `bundle=IMPOSTOR` and exits 0. |
| Runner | GitHub-hosted `ubuntu-24.04`, image 20260920.314.1, runner 2.337.0 |
| Actions settings (both repos) | allowed actions `selected` (GitHub-owned; the app also allows `MattShelton04/pixelwatch-spike-lib/*`), `sha_pinning_required: true`, default token `read`, Actions can't approve PRs, fork PR approval `all_external_contributors` |

Both lib commits and tags were pushed before the first run (11:05Z), so every run of the old
pin A happened while the newer B existed.

`report.yml` (lib) has two jobs with the exact 01 §4.2 permission sets. Each job:

1. runs a guard before any checkout: `job.workflow_repository` must be `owner/repo` and
   `job.workflow_sha` 40 lowercase hex, else fail;
2. checks out `job.workflow_repository`@`job.workflow_sha` into `_pixelwatch` with
   `persist-credentials: false`, then fails unless `git rev-parse HEAD` equals `job.workflow_sha`;
3. runs `uses: ./_pixelwatch/actions/publish`, which prints and outputs its bundle version, nonce
   and file hash.

The caller's `assert` jobs compare the called workflow's outputs with the expected bundle,
nonce, repository and SHA and fail on any mismatch.

## Runs (all attempt 1, event `workflow_dispatch`, all conclusions as listed)

| Case | Caller workflow | Run ID | Jobs (ID) | Observed | Result |
|---|---|---|---|---|---|
| Foreign caller, SHA-pinned to B | `s4-pin-b.yml` → `report.yml@7f0ec44…` | 36706474440 | ingest 109857806326, project 109857806184, assert 109857860568 | both jobs: `job.workflow_sha=7f0ec44…`, checked out `7f0ec44…`, `PWSPIKE bundle=v2 nonce=6667b07e0531783d sha256=da822ac0…` | pass |
| **Old** pin A after B exists | `s4-pin-a.yml` → `report.yml@9c54426…` | 36706493124 | ingest 109857864982, project 109857864681, assert 109857920971 | both jobs: `job.workflow_sha=9c54426…`, `PWSPIKE bundle=v1 nonce=d77ee74f0fb9ef4f sha256=a97799e5…` | pass |
| Nested in the library | `s4-nested-lib.yml` → `outer.yml@7f0ec44…` → `./.github/workflows/report.yml` | 36706504065 | outer/probe 109857903983, outer/inner/ingest 109857904450, outer/inner/project 109857904510, assert 109857938980, assert-outer-probe 109857938904 | outer probe `job.workflow_ref=…/outer.yml@7f0ec44…`; inner jobs `job.workflow_ref=…/report.yml@7f0ec44…`, bundle `v2` | pass |
| Nested in the caller | `s4-nested-app.yml` → `./.github/workflows/wrap.yml` → `report.yml@9c54426…` | 36706509879 | wrap/report/ingest 109857921242, wrap/report/project 109857921597, assert 109857968063 | `job.workflow_sha=9c54426…`, bundle `v1` | pass |
| Negative control | `s4-naive-control.yml` → `naive.yml@7f0ec44…` (default checkout + `uses: ./actions/publish`) | 36706515828 | naive 109857937487, assert 109858166621 | checkout fetched `MattShelton04/pixelwatch-spike-app` at `ca07b3d…`; `PWSPIKE bundle=IMPOSTOR nonce=caller-code` | pass (the hazard is real and the assertions detect it) |
| Direct (non-reusable) job | `s4-direct.yml` | 36706519711 | direct 109857945914 | `job.workflow_repository=MattShelton04/pixelwatch-spike-app`, `job.workflow_sha=ca07b3d…`, `job.workflow_ref=…/s4-direct.yml@refs/heads/main`, `job.workflow_file_path=.github/workflows/s4-direct.yml` | recorded |
| Guard self-test (lib) | `guard-selftest.yml` | 36706524252 | 6 guard cases 109857973622–109857974095 | blank repo, blank SHA, both blank, SHA = `main`, SHA = `v0.0.1`, 7-char SHA: the guard failed in every case before any checkout | pass |

In every called job, the caller's own values pointed at the caller, never at the library:

```text
github.repository=MattShelton04/pixelwatch-spike-app github.sha=ca07b3d2d4648f1a8753e4d59cf55df50721127a
github.workflow_ref=MattShelton04/pixelwatch-spike-app/.github/workflows/s4-pin-b.yml@refs/heads/main
github.workflow_sha=ca07b3d2d4648f1a8753e4d59cf55df50721127a
job.workflow_repository=MattShelton04/pixelwatch-spike-lib
job.workflow_sha=7f0ec44808846b50c31387574fac840c21ed85f2
job.workflow_ref=MattShelton04/pixelwatch-spike-lib/.github/workflows/report.yml@7f0ec44808846b50c31387574fac840c21ed85f2
```

## Extra: GitHub's `uses: $/…` self-repository syntax

GitHub added `uses: $/<path>` on 2026-07-30 (changelog "Reference same-repository actions with
self-repository syntax"): it "resolves to your workflow's own repository at the exact commit
that is running, with no checkout required". zizmor 1.30.1 recommends it (`self-repository`
audit). The same runs tested it in separate lib workflows (`selfref.yml`, `outer-dollar.yml`):

| Case | Run / job | Observed | Result |
|---|---|---|---|
| Foreign pin B, `uses: $/actions/publish` with an empty workspace | 36706474440 / 109857806088 | `bundle=v2`, SHA-256 `da822ac0…`; `ls -la` showed an empty workspace | pass |
| Old pin A | 36706493124 / 109857864841 | `bundle=v1`, SHA-256 `a97799e5…` | pass |
| Nested: `outer-dollar.yml@B` → `uses: $/.github/workflows/report.yml` | 36706504065 / 109857904507, 109857904395 | inner jobs: `job.workflow_ref=…/report.yml@7f0ec44…`, bundle `v2` | pass |

The caller's IMPOSTOR never ran through `$/`.

## Per-job token permissions (log section "GITHUB_TOKEN Permissions")

Caller job grants the 01 §3 union (`actions: read, contents: write, pull-requests: write,
pages: write, id-token: write`); the called jobs got exactly their own sets:

| Job (run 36706474440) | Logged permissions |
|---|---|
| `report / ingest` | Actions: read, Contents: write, Metadata: read, PullRequests: read |
| `report / project` | Contents: read, Metadata: read, Pages: write, PullRequests: write |
| `selfref` (`permissions: {}`) | Metadata: read |

`id-token: write` isn't listed in this section (OIDC isn't a `GITHUB_TOKEN` scope). S2's deploy
through `deploy-pages` is the evidence that the OIDC token works (ADR 0005).

## Tooling observations

- actionlint 1.7.12 (our pinned version) reports `job.workflow_repository`, `job.workflow_sha` and
  `job.workflow_ref` as undefined properties, and rejects `uses: $/…`. M2.5's `report.yml` needs
  a newer actionlint or a narrow ignore before `pnpm lint:workflows` accepts it.
- zizmor 1.30.1 raises `self-repository` (low) on every `uses: ./…` in a workflow.

Logs of these runs expire about 90 days after 2026-09-30 (the GitHub default for public repos).

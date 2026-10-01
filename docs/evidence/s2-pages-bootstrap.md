# Evidence: S2 Actions Pages bootstrap, readiness and repair (M0.5)

- Date: 2026-09-30 (runs 11:08Z–11:47Z)
- PixelWatch commit: `ef39750` (no product code involved; spike code lives only in the spike repos)
- Result: **pass, with one design correction** (readiness is per-vantage-point, see "CDN
  staleness"). Decision: [ADR 0005](../adr/0005-s2-actions-pages-bootstrap-and-readiness.md).
- Machine-readable timings: [recordings/s2/timings.json](recordings/s2/timings.json)

## Setup

| Item | Value |
|---|---|
| Site repository | https://github.com/MattShelton04/pixelwatch-spike-app, repository ID 1397668282, public, created 2026-09-30T11:04:25Z with no Pages and no environments |
| Served URL | https://mattshelton04.github.io/pixelwatch-spike-app/pixelwatch/ |
| Deploy workflow | `s2-pages.yml` (`workflow_dispatch`): build → `actions/upload-pages-artifact@fc324d3…` (v5.0.0) → `actions/deploy-pages@368f825…` (v5.0.1) → readiness. One job, `environment: github-pages`, permissions `contents: read, pages: write, id-token: write`, concurrency group `pixelwatch-pages-spike` with `cancel-in-progress: false` |
| Production-shape workflow | `s2-via-lib.yml` calls `MattShelton04/pixelwatch-spike-lib/.github/workflows/pages.yml@eee3ea73742ebd928c8eda15ec27a71d30c97e27` (`v0.0.3`): self-checkout (ADR 0006), same build/deploy/readiness from the library's own scripts |
| App commits | `ca07b3d` (initial), `f2ec7bf` (readiness summary under `bash -e`), `85376fe` (3-consecutive readiness), `e4e9b82` (`s2-via-lib.yml`) |
| Runner | GitHub-hosted `ubuntu-24.04`, images 20260920.314.1 to 20260927.320.1, runner 2.337.0 |

The site is synthetic. `scripts/build-site.mjs` writes, under `pixelwatch/`:
- `site.json` with `generation` = SHA-256 of canonical `{storeTip, releaseCommit, configCommit,
  projectionVersion: 1}`;
- `api/v1/pr/<n>/latest.json` with `{schemaVersion, prNumber, runKey, headSha, generation}` for
  PRs 1 (and 2 from G4 on);
- a 4×4 PNG at `blobs/<ab>/<sha256>.png` and an `index.html`.

The same inputs give byte-identical files. Readiness (`scripts/probe.mjs ready`) is ADR 0004:
- `site.json` names the expected generation;
- each PR's `latest.json` names the expected run key and generation;
- every fetched body's SHA-256 equals the built bytes;
- a bounded GET of the PNG succeeds.

A 200 alone never counts. G1–G6 accepted the first passing poll. From G7 on (app `85376fe`), ready
means **3 consecutive** passing polls, 5 s apart.

## Bootstrap

1. **Before Pages was enabled** (run 36706718710, app `ca07b3d`): the first job that named
   `environment: github-pages` **auto-created** the environment (ID 23105020439, 11:08:47Z) with no
   branch policy. `deploy-pages` then failed: `Failed to create deployment (status: 404) …
   Ensure GitHub Pages has been enabled`. Readiness saw 36 × 404 and reported `stored; deployment
   pending`. Environment deployment 6757843330 ended `failure`.
2. `POST /repos/{owner}/{repo}/pages` with `build_type: workflow` enabled Pages (read back:
   `build_type: workflow`, `https_enforced: true`, `public: true`). Enabling Pages **added** a
   custom deployment branch policy `main` (ID 61516644) to the existing environment by itself.
   Nothing else was changed on the environment.
3. **G1** (run 36706957444, app `f2ec7bf`) succeeded: environment deployment 6757884105;
   `deploy-pages` reported success at 11:11:30.26Z; readiness passed 0.49 s later.
4. **Non-default branch** (run 36710573750, dispatched on `spike/not-main`): rejected before any
   step ran, `Branch "spike/not-main" is not allowed to deploy to github-pages due to environment
   protection rules.` Environment deployment 6758526952 went `waiting` → `failure`.

## Runs

All attempt 1. "Success" is `deploy-pages`' `Reported success!` log line. "Runner ready" is from
that moment. Env deployment = the numeric `github-pages` environment deployment ID.

| Label | Run | Case | Env deployment (final state) | Generation | Runner readiness |
|---|---|---|---|---|---|
| — | 36706718710 | before Pages enabled | 6757843330 (`failure`) | `d0367a0c…` (never served) | not ready: 36 × 404 → `stored; deployment pending` |
| G1 | 36706957444 | bootstrap | 6757884105 (`success`) | `f3496c1f…` | 0.49 s, 1 poll |
| G2 | 36707088718 | staleness series | 6757908762 (`success`) | `2e6f7273…` | 0.85 s, 1 poll |
| G3 | 36707226919 | staleness series | 6757933016 (`success`) | `14b82f43…` | 65.5 s, 14 polls; 14 stale-generation 200s, 1 × 404 first |
| G4 | 36707464032 | staleness series; adds PR 2 | 6757978874 (`success`) | `f16cb6e2…` | 10.4 s, 3 polls; 2 stale 200s |
| G5 | 36707613955 | staleness series | 6758005032 (`success`) | `e5612fb4…` | 41.3 s, 9 polls; 12 stale 200s |
| G6 | 36707826645 | staleness series | 6758041648 (`success`) | `f5263d20…` | 20.7 s, 5 polls; 4 stale 200s |
| G7 | 36709383413 | 3-consecutive rule | 6758319968 (`success`) | `c55634a8…` | 10.5 s (first pass 0.39 s). Pages reported `updating_pages` for 1 min 37 s before success. |
| G8 | 36709690836 | **F1**: deploy fails (`artifact_name: no-such-artifact`) | 6758374397 (`failure`) | `3a2f312f…` | not ready: old generation still served (36 stale 200s, 12 × 404 for the new PNG) → `stored; deployment pending` |
| G8 | 36709898713 | F1 repair, same store tip | 6758410938 (`success`) | `3a2f312f…` (same) | 10.4 s (first pass 0.24 s) |
| G9 | 36710020123 | **F2**: run cancelled during deploy | 6758431621 (`error`) | `2c0a1457…` | 10.6 s (first pass 0.54 s), then the job concluded `cancelled` |
| G9 | 36710156102 | F2 repair, same store tip | 6758455357 (`success`) | `2c0a1457…` (same) | first pass 0.29 s, then **16 regressions after passing**; 3 consecutive only at 100.9 s (21 polls, 22 stale 200s) |
| G10 | 36710481440 | production shape: lib `pages.yml@eee3ea7` (job 109870822497) | 6758511494 (`success`) | `a9b9c3cd…` | 10.3 s (first pass 0.21 s) |

### Failure and repair

- **F1, deploy fails.** `deploy-pages` failed with `No artifacts named "no-such-artifact" were
  found for this workflow run`. The previous generation stayed served, and readiness timed out
  with `stored; deployment pending (repair: rerun this workflow with the same store_tip)`. The
  repair dispatch with the same store tip rebuilt the **same generation** `3a2f312f…`. The built
  manifests of the failed and repair runs (file list, SHA-256 and byte count of every file) are
  byte-identical. The repair became ready.
- **F2, cancel during deploy.** The cancel was requested at about 11:40:58Z, as the deploy step
  started. It didn't interrupt anything:
  - every step finished `success`, including `deploy-pages` (`Reported success!` at 11:41:05Z)
    and readiness (11:41:16Z);
  - the job concluded `cancelled` and environment deployment 6758431621 ended `error`;
  - `GET /repos/{owner}/{repo}/pages/deployments/85376fe…` returned `{"status":"succeed"}` at the
    time, and G9 was served.

  A truly interrupted deploy wasn't produced. What was shown: a `cancelled` job and an `error`
  environment deployment can still have deployed. The repair with the same store tip rebuilt G9
  and became ready.
- **Deployment IDs.** `deploy-pages` names a Pages deployment by its build version, which is the
  workflow commit SHA (`Created deployment for 85376fe…, ID: 85376fe…`). So the ID repeats for
  every deploy from the same commit (G7–G9 all `85376fe…`). By 2026-10-01, the same
  `GET …/pages/deployments/85376fe…` returned `{"status":""}`. The numeric environment deployment
  ID is unique per run.

## CDN staleness

Every response carried `cache-control: max-age=600`. A second vantage point polled from the
owner's machine every 2 s, 11:10:54Z–11:52:38Z (1,236 polls, one Fastly POP, `x-served-by …-WSI`).
It fetched `site.json`, a cache-busted `site.json?cb=…`, `pr/1/latest.json` and `pr/2/latest.json`.
The runner's polls came from different POPs (for example, `…-CHI` in the F2 repair).

Observed:
- **Generations went backwards after the newer one had been served** at the same vantage point:
  - `site.json` showed G3 → G2 → G4 → G3 → G4 and G6 → G5 → G6;
  - during the F2 repair, `site.json` showed G9 → G7 → G9 → G7 → G9;
  - 389 polls served a file older than one that same file had already served.
- **The cache-busted copy regressed too**, in step with the canonical `site.json` (`x-cache: MISS`,
  `age: 0`). A query string doesn't reach a fresh origin.
- **Files disagreed:** 266 polls saw more than one generation across the four files. For example,
  `pr/1/latest.json` served G2 at 11:22:43Z, **8 min 50 s** after G3 replaced it, while `site.json`
  was already G6.
- **The runner's "ready" was not global:**
  - The runner declared G6 ready at 11:20:05Z (single-poll rule). The local POP still served an
    older file in some poll until 3 min 29 s after G6's deploy success.
  - The F2 repair's 3-consecutive "ready" at 11:44:07Z was followed locally by older files until
    11:45:32Z.
- **Convergence:** after the last deploy (G10, 11:45:38Z), the local POP served only G10 from the
  first poll for the remaining 7 min.

Per generation, from deploy success to the next deploy's success:

| Gen | Window | Local polls with an older file | Last older file after success |
|---|---|---|---|
| G1 | 67 s | 0 | — |
| G2 | 76 s | 0 | — |
| G3 | 139 s | 17 | 136.5 s |
| G4 | 94 s | 37 | 73.6 s |
| G5 | 118 s | 2 | 115.6 s |
| G6 | 1006 s | 104 | 209.2 s |
| G7 | 209 s | 0 | — |
| G8 | 67 s | 13 | 25.2 s |
| G9 (F2 + repair) | 273 s | 92 | 266.7 s |
| G10 | 421 s (end of log) | 0 | — |

The windows for G1–G5 and G8 ended before the next deploy, so they don't show how long staleness
would have lasted. The longest observed was a superseded file served 8 min 50 s after its
replacement, inside the 600 s `max-age`.

## Raw data

Run logs, readiness artifacts and the local observer's full log are in the owner's git-ignored
`.reference/m0.5-spikes/evidence/s2/`. The Actions logs expire about 90 days after 2026-09-30.
`timings.json` here keeps:
- per-run generations and deployment timestamps;
- environment deployment statuses;
- the runner result lines;
- the local timeline of generation changes, every regression poll, and the per-generation
  summary above.

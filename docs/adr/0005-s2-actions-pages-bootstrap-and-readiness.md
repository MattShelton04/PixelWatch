# ADR 0005: S2 Actions Pages bootstrap, readiness and repair

- Status: accepted
- Date: 2026-10-01
- Task / spike: M0.5 / S2

## Context

03 §7 deploys the served tree with `actions/upload-pages-artifact` + `actions/deploy-pages` into
the `github-pages` environment. It then polls until the served files match what was built (ADR
0004), and repairs a failed deploy by reprojecting the same store. Until now this rested on
GitHub's documentation only (`platform-facts.md`, "S2 pending").

Evidence: [docs/evidence/s2-pages-bootstrap.md](../evidence/s2-pages-bootstrap.md) and
[recordings/s2/timings.json](../evidence/recordings/s2/timings.json).

The spike ran 14 runs on 2026-09-30 in `MattShelton04/pixelwatch-spike-app` (repository ID
1397668282), all attempt 1:
- bootstrap: 36706718710 (before Pages was enabled) and 36706957444 (G1);
- staleness series: 36707088718, 36707226919, 36707464032, 36707613955 and 36707826645;
- 3-consecutive readiness: 36709383413;
- failed deploy and repair: 36709690836 and 36709898713;
- cancelled run and repair: 36710020123 and 36710156102;
- the production-shape call into `pixelwatch-spike-lib` `pages.yml@eee3ea7`: 36710481440;
- the non-default-branch rejection: 36710573750.

Environment deployment IDs are listed in the evidence.

Observed:

- **Bootstrap.**
  - A job naming `environment: github-pages` before Pages was enabled auto-created the
    environment with no branch policy. `deploy-pages` then failed with `404 … Ensure GitHub Pages
    has been enabled`.
  - `POST /pages` with `build_type: workflow` enabled Pages and added a custom branch policy
    `main` to the existing environment by itself.
  - From then on, a dispatch from another branch was rejected by the environment before any step
    ran.
- **Production shape works.** Deploying from a foreign-called, SHA-pinned reusable workflow
  worked, with `environment: github-pages` and the Pages OIDC token inside the called job.
- **Readiness checks are needed.** ADR 0004's checks caught stale-generation 200s and cached
  404s that a status check would have accepted.
- **Repair is idempotent.**
  - After a deliberately failed deploy (F1), the old generation stayed served and readiness
    reported `stored; deployment pending`.
  - Repair with the same store tip rebuilt the same generation with byte-identical files and
    became ready.
- **A cancelled job can still have deployed.**
  - A cancel requested as the deploy step started (F2) didn't stop it: every step succeeded and
    the new generation was served.
  - The job still concluded `cancelled`, and the environment deployment ended `error`.
- **Deployment IDs repeat.** `deploy-pages` identifies a deployment by the workflow commit SHA,
  so the ID repeats across deploys from one commit, and its status endpoint later returned an
  empty status. The numeric environment deployment ID is unique.
- **Readiness is not global.**
  - Pages served `cache-control: max-age=600`. A second vantage point (the owner's machine, one
    CDN POP, 2 s polls) saw generations go **backwards** after the newer one had been served.
  - It saw files from **different generations** at the same moment.
  - It saw a superseded `latest.json` up to **8 min 50 s** after its replacement.
  - A cache-busting query string regressed too.
  - The runner declared ready while that POP still served older files: up to 3 min 29 s after
    deploy success with the single-poll rule. After the F2 repair's 3-consecutive ready, it took
    another 85 s.
  - The runner itself saw 16 regressions after a first passing poll in the F2 repair.

The last point contradicts an implicit assumption in 03 §7 and ADR 0004: that once readiness
passes, readers see the new generation. On 2026-09-30 the owner left the choice of fix to the
agent ("do whatever you think is best"). The minimal fix below keeps the mechanism and changes
only what "ready" claims.

## Decision

1. **Ready = the full ADR 0004 check passes on 3 consecutive polls at least 10 s apart**, within
   the bounded timeout. Any failing poll resets the count.
   - A single passing poll isn't ready: in the spike, single passes were followed by
     regressions.
   - No N-poll rule makes readiness global, so N stays small. The spike used 5 s spacing; 10 s
     samples more edges at little cost.
2. **Readiness means "ready as observed from the runner".**
   - The job summary says so, and nothing claims global visibility.
   - Comments are still posted after readiness. Readers on a stale edge are covered by the
     comment's generation stamp (05 §2) and the viewer's single cache-busting reload, then static
     fallback (04 §2).
   - This is recorded as a residual risk.
3. **Record the numeric environment deployment ID** in the job summary, not the Pages deployment
   ID, which is a build-version SHA.
4. **Deploy failure.**
   - The projector treats a failed or cancelled deploy step as "stored; deployment pending",
     whatever GitHub's job or deployment state says. Repair reprojects the same store tip. The
     spike shows that's idempotent.
   - Readiness, not the job conclusion, decides whether a generation is served.
5. **Bootstrap order for adopter docs and preflight** (M3.8 quickstart, 06 preflight):
   - enable Pages with source **GitHub Actions** first;
   - then check that the `github-pages` environment allows only the default branch.

   A report run before Pages is enabled creates the environment with no branch policy and fails
   the deploy with a 404. The publisher still never changes settings itself (01 §3).

## Consequences

- 03 §7 step 4 carries the 3-consecutive rule and the "as observed from the runner" wording. ADR
  0004 points here.
- 07 §4 adds two sub-cases to `sim-cdn-stale-generation`:
  - the edge goes stale again after a pass;
  - files from mixed generations.

  It also adds to `sim-deploy-fails`: a cancelled job whose deploy completed. The simulated CDN
  must be able to serve an older generation after a newer one, per file.
- Threat model:
  - R4.5-07's S2 evidence row becomes `recorded`, pointing here.
  - §7 gains a residual-risk row: other readers can see an older or mixed generation for minutes
    after readiness.
- `platform-facts.md`: the two Pages rows' "Live" column points here.
- M2.3's acceptance ("no comment before ready") is unchanged. Its readiness tests use the new
  rule.
- Not covered: Pages' 10-minute deploy timeout, a deploy actually interrupted mid-upload, custom
  domains, and private-repo Pages.

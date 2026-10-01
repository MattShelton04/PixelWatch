# Platform facts the design relies on

These were checked against primary docs on 2026-09-28/30. Platforms change: re-check a fact
before building on it, and record live observations as ADRs/evidence. "Live: pending" means only
the documentation was checked.

| Fact | Design impact | Source | Live |
|---|---|---|---|
| Pages: 1 GB site, 1 GB recommended repo, 10-min deploy timeout, soft 100 GB/month; the 10 builds/hour limit doesn't apply to custom Actions workflows | Budgets (03 §1) | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | — |
| "Commits pushed by a GitHub Actions workflow that uses the `GITHUB_TOKEN` do not trigger a GitHub Pages build." | Actions deployment instead of branch serving (03 §7) | https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site | Not tested; the Actions deploy path it leads to: ADR 0005 |
| Custom Pages deploy needs `pages: write`, `id-token: write`, the `github-pages` environment, and a Pages artifact | Report job permissions (01 §4.2) | https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages | ADR 0005 (also inside a foreign-called reusable workflow; environment auto-created on first reference; enabling Pages adds a `main` branch policy; responses carry `max-age=600`) |
| `job.workflow_repository`, `job.workflow_sha`, `job.workflow_ref` identify the reusable workflow's own source (not on GHES) | Self-checkout (06 §3) | https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context | ADR 0006 (`job.workflow_ref` is a branch ref in direct runs; use only `job.workflow_sha`) |
| `workflow_run` runs on the default branch with write access; GitHub warns about untrusted artifacts/caches; PR events may use merge refs | Trust split, SHA separation (01 §4) | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows | same-repo: ADR 0007; fork: M2.6 |
| `secrets: inherit` exists; a reusable workflow can't stop callers passing secrets | Capture rules are adopter requirements (01 §3) | https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows | — |
| Concurrency default: one running + one pending per group (pending replaced); `queue: max` allows up to 100 pending | No global ingestion queue (03 §7) | https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency | — |
| upload-artifact v4+: immutable, names must be unique per run; run artifact listing isn't per attempt | Attempt in artifact names (02 §6) | https://github.com/actions/upload-artifact ; https://docs.github.com/en/rest/actions/artifacts | After a full rerun only the new attempt's artifacts were listed and the old IDs returned 404 (ADR 0007); partial rerun: S3 pending |
| Reruns use the original SHA/ref and actor | Run key includes attempt | https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs | Same-repo full rerun: same event, merge SHA and run ID, new attempt (ADR 0007) |
| `--force-with-lease=<ref>:<expect>` rejects if the ref moved | Store CAS (03 §6) | https://git-scm.com/docs/git-push | Local test done; S7 pending |
| `runs.using: node24` supported | Action runtime | https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax | — |
| Matrix max 256 jobs; `max-parallel` limits concurrency only | Future sharding | https://docs.github.com/en/actions/reference/limits | — |
| Standard public Ubuntu runners: 4 vCPU / 16 GB | Worker sizing | https://docs.github.com/en/actions/reference/runners/github-hosted-runners | — |
| Origin = scheme + host + port; project Pages sites of one owner share an origin | Viewer security (04 §4) | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy | — |
| External-script hash CSP needs matching `integrity`; meta CSP can't set `frame-ancestors` | Entry pages (04 §1, §4) | https://www.w3.org/TR/CSP3/ | M3 browser test |
| Camo proxies images; no published size/format/TTL contract | PNG preview + text fallback (05 §3) | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls | S1 pending |
| Reusable workflow/action refs and Pages URLs don't redirect after rename/transfer | Choose the name early (06 §1) | https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository | — |
| PNG allows far more than RGB/RGBA8 non-interlaced | Restricted profile + normalize on the capture side (02 §5) | https://www.w3.org/TR/png-3/ | — |
| Default lossless WebP may change RGB under alpha 0; `exact` preserves it; max 16383 px per side | If WebP is added later | https://developers.google.com/speed/webp/docs/api | — |
| Playwright doesn't recommend caching browser binaries | Future capture | https://playwright.dev/docs/ci#caching-browsers | — |
| npm `1.0.0-rc.1` vs Python `1.0.0rc1` spelling | Future multi-registry releases | https://packaging.python.org/en/latest/specifications/version-specifiers/ | — |
| Future research: Chromium DOMSnapshot/CSS protocol, WCAG resize/reflow/text-spacing, VISER (Althomali et al. 2019), ReFLAIR (FSE 2026), Web Animations and Playwright clock | `future/layout-findings.md`, `future/motion-and-flows.md` | https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOMSnapshot.pdl ; https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html ; https://philmcminn.com/publications/althomali2019.pdf ; https://seal.ics.uci.edu/publications/2026_FSE.pdf ; https://playwright.dev/docs/clock | — |

## Local Git experiment (orphan-commit transfer)

Git 2.47.3, a local bare remote, four random 512 KiB blobs, then one new 512 KiB blob:

| Sequence | Second pack received |
|---|---|
| Fresh `--depth 1` fetch + parentless commit | 524,805 bytes |
| Fresh `--depth 1` fetch + parented commit (control) | 524,833 bytes |
| Parentless commit **without** fresh fetch (control) | 2,622,593 bytes |

A stale lease was rejected. Old objects remained after the ref rewrite. GitHub behaviour is S7.

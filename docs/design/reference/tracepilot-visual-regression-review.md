> **Background only (not normative).** Lessons from TracePilot written before the PixelWatch design. Where it differs from `docs/design/`, the design wins. For example, `concurrency.queue: max` now exists in GitHub docs, but PixelWatch avoids a global queue anyway (03 §7).

# TracePilot visual regression: issues and improvements

Written 2026-09-28 while porting the TracePilot setup (`scripts/visual/`, `.github/workflows/visual-*.yml`)
to PropertyScope. Items are ordered by how much I'd prioritise them. "Verify" means I read the code
but didn't reproduce the problem, so check it before acting.

## Likely bugs or risks

1. **`concurrency.queue: max` in `visual-report.yml` (verify).** Workflow concurrency documents only
   `group` and `cancel-in-progress`. If `queue` is ignored, the report job gets GitHub's default
   behaviour: at most one running and one pending run per group. A third publication arriving while
   one runs and one waits **replaces the pending run**, so that PR or main run is never published.
   Either confirm `queue` is honoured, or drop the global queue and make the publisher itself
   concurrency-safe. PropertyScope does the second: it fetches, resets to `origin/gh-pages`,
   rebuilds the tree, and pushes with `--force-with-lease`, retrying up to 5 times. The
   concurrency group is then per branch, so nothing is dropped.

2. **`gh-pages` history grows without bound.** Retention prunes runs and content-addressed images
   from the *tree*, but every deleted PNG stays in git history. Each clone of the repository, and
   each publish's fetch, carries every screenshot ever published. PropertyScope's publisher
   replaces the branch with one root commit of the current tree once it passes 150 commits, using
   `commit-tree` and a `--force-with-lease` push. Pages serves the tree, so nothing visible changes.

3. **Pushes aren't retried.** `publish.mjs` fetches `--depth=1`, builds and pushes `HEAD:gh-pages`
   once. With item 1 fixed or not, any other writer to `gh-pages` (a manual fix, another workflow)
   makes the job fail instead of rebasing.

4. **Fork pull requests may never get a comment (verify with a fork).** PR association uses
   `GET /commits/{sha}/pulls`. For fork heads this often returns nothing, because the commit
   belongs to the fork. The fallback that works is `GET /pulls?state=open&head=<fork owner>:<branch>`
   using `workflow_run.head_repository.owner.login` and `head_branch`, followed by a check that the
   PR's `head.sha` equals the run's head.

5. **Artifact download sends the token to the storage redirect (verify on your Node version).**
   `fetch()` follows the 302 from `/actions/artifacts/{id}/zip` to blob storage automatically.
   Recent undici strips `Authorization` on cross-origin redirects, but that depends on the runtime
   version. Make it explicit: request with `redirect: "manual"`, then fetch the `Location` URL
   without the header. PropertyScope does this with a no-redirect opener.

6. **Viewport-only screenshots miss below-the-fold changes.** `page.screenshot()` without
   `fullPage` captures only 1440×960. A change further down a long page is invisible, and the
   comparison says "unchanged". Capture the full page with a height cap (PropertyScope: full page,
   clipped at 6000 px, noted when clipped), and let the pixel code pad different heights
   (height change = changed).

7. **The failure screenshot swallows its own error.** `capture.mjs` saves the failure image with
   `.catch(() => {})`. When that fails too, there's no diagnostic and no note. At least record
   "failure screenshot unavailable: <reason>" in the view's errors.

## Determinism gaps

8. **`crypto.randomUUID` isn't seeded.** `Math.random` is replaced, but anything generating IDs with
   `crypto.randomUUID()` (request IDs, keys shown in error panels, React keys that leak into the
   DOM) varies between captures. PropertyScope replaces it with a counter-based v4 UUID in the
   same init script.

9. **No masking for genuinely measured values.** There's no way to hide a value that is correct but
   non-deterministic (latency, durations, "last checked N ms ago"). The options are a flaky view or
   removing the view. A per-case `mask: [selectors]` list, painted a flat colour by Playwright's
   `mask`/`maskColor` and recorded in the view's notes, is small and honest. Keep masks rare and
   visible in the gallery.

10. **Injecting inline styles conflicts with a strict CSP.** `addStyleTag({ content })` and
    Playwright's own `caret: "hide"` add inline `<style>` elements. They're silently blocked under
    `style-src 'self'` (TracePilot's Tauri CSP or a future web build). PropertyScope serves the
    freeze stylesheet from the page's own origin via route interception
    (`/__visual-regression__/still.css`), then uses `addStyleTag({ url })` and `caret: "initial"`.
    It deliberately avoids `bypassCSP`, so real CSP regressions still fail views.

## Maintainability

11. **Legacy migration code is now dead weight.** `pages-store.mjs` `migrateLegacyRun()` (and the
    report re-render path) exists to upgrade reports published before the shared image store.
    Retention is 20 + 20 runs, so every legacy run has long since been pruned. Remove the migration
    and its tests, or gate it behind a one-off script.

12. **Viewport dimensions are hard-coded in several places.** `1440×960` appears in the capture
    policy, the gallery template header text, the history header, the comment footer and
    `gallery-check.mjs`. Changing the viewport means a hunt. Export one policy constant and derive
    the text from it.

13. **Two runtimes in the trusted publisher.** The publisher is Node, but artifact extraction is a
    separate `extract.py` launched with `execFileSync("python3", ...)`. That works on
    `ubuntu-24.04`, but it's two languages to audit for one security boundary. Either port the
    extractor to Node (a zip reader over bounded buffers) or move the whole publisher to Python.

14. **The base is re-captured on every run.** Every PR run renders the merge base again, even
    though the same main commit was already captured by the main-branch run. You could look up
    the retained main run with `sha == base` and reuse its images, but only when the harness,
    lockfile and browser revision also match (store those in `entry.json`). Otherwise fall back to
    capturing. It saves about half the minutes, at the cost of more code. It's worth doing only if
    minutes matter.

## Small things

15. The comment footer hard-codes "dark, 100% scale". Derive it from the capture policy with the
    viewport (item 12).
16. `runUrl` links a specific attempt, but the history entry keeps only the latest attempt, so older
    attempt links in comments go stale after a rerun. That's fine, but the gallery could say which
    attempt it shows.
17. Consider a `changes.json` schema version bump policy. Agents and scripts consume it, so field
    renames should be additive.

## What worked well and was kept

- The untrusted capture / trusted `workflow_run` publisher split, with the harness taken from the
  merge commit.
- Merge-base comparisons for PRs, including the merge commit's first parent when main moved.
- Content-addressed images shared across runs, and rendering from trusted templates only.
- Stable screenshots (two identical consecutive captures), the Chromium determinism flags, and the
  fixed clock.
- One sticky comment edited in place, with stale-attempt checks.
- Thresholded difference analysis, tile-based regions, grouping of identical changed areas, and
  1:1 close-ups.

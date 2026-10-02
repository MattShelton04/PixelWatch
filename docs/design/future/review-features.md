# Future · Review features: variants, flake detection, attribution, local parity, baseline reuse

**Scope:** existing viewer interaction parity is M3; new variant execution, baseline reuse
and capture planning are M5; flake/attribution/approvals are M6. Public CLI commands here are
future M4+ interfaces. None is an M0 package/schema blocker. Claims of precision or speed are
hypotheses until measured on the actual supplied corpus; **verify** before publishing them as
product guarantees. Canonical MVP identities/states are in `../02-contracts.md`, not the sketches below.

This file expands the use cases worth keeping from the first plan, with enough design to build
from.

## 1. Multi-resolution and other variants

### 1.1 Model

- A **variant** is a named set of capture settings: viewport, device scale factor, colour scheme,
  locale, reduced motion, browser engine, or zoom.
- **Axes** combine variants into a matrix. `[desktop, tablet, mobile] × [light, dark]` gives six
  variant keys, such as `mobile+dark`.
- A capture's identity is `(providerId, viewId, variantId)`. History, timelines and flake scores use that full tuple. `mobile+dark` is a display label; an encoded variant ID must meet the active schema (e.g. `mobile-dark`), not bypass it.
- Variant definitions live in `views.yml`. Their display order and labels live in `config.json`.

### 1.2 Viewer

- **Variant switcher:** a chip row above the image. Keyboard `v` cycles.
- **Grid mode:** every variant of one view side by side, scaled to a common height, each with its
  change badge. This is where "the mobile layout broke but desktop is fine" becomes obvious.
- **Matrix overview** for a run: views as rows, variants as columns, each cell coloured by
  classification.
- Changes are counted per capture. The run header also says "7 views changed (11 captures)".

### 1.3 PR comment

- Group by view, not by capture. Show which variants changed: "`f1-overview`: mobile, mobile+dark".
- The expanded preview uses the variant with the largest change.

### 1.4 Cost control

Every variant multiplies capture time and storage (storage is covered in `../03-storage-and-publishing.md`).

| Mechanism | How |
|---|---|
| Tiered sets | `defaultVariants: [desktop]` for PRs; `variantSets.full` on main pushes, nightly, or when the PR has the label `pixelwatch:full` |
| Per-view variants | Only views with responsive layouts opt into `mobile` |
| Affected-only | Skip variants and views whose sections' `paths` weren't touched (section 3.5) |
| Sharding | Parallel jobs per variant or view subset (see capture-and-sharding.md) |
| Baseline reuse | Base captures come from the stored main snapshot (section 5) |

### 1.5 Other axes worth supporting

| Axis | Values | Notes |
|---|---|---|
| Browser engine | Chromium, Firefox, WebKit | Catches engine-specific breakage; each engine is its own baseline |
| Locale / direction | `en-AU`, `ar` (RTL) | Catches truncation and mirroring bugs |
| Reduced motion / forced colours | `prefers-reduced-motion`, `forced-colors: active` | Accessibility regressions |
| Zoom / text scale | 200 % | Real users with large text |
| Auth state | anonymous, member, admin | Implemented as hooks selecting storage state |

## 2. Flake detection

A flaky view shows a change when nothing changed. It's the biggest threat to trust in the tool,
so detect it at three levels and quarantine it instead of hiding it.

### 2.1 In-run: recapture on change

With `stability: { recaptures: 2 }`, after the head capture the runner recaptures every view
whose pixel hash differs from the base (the base hashes come from the reused baseline, or from
the base job's manifest via the plan in capture-and-sharding.md).

- **Head ≠ head′:** the view is non-deterministic in this environment. It's marked `unstable`,
  with the region(s) that varied recorded.
- **Head = head′ ≠ base:** the change is at least reproducible, so it's a real change or an
  environment difference.
- **Cost:** only changed views are recaptured, typically 0–5.

### 2.2 Cross-run: A→B→A on main

In the main stream, if a capture changes at run *k* and changes back to the previous hash at *k+1*,
with no attributed file changes (section 3), it is a **flake heuristic**, not proof: legitimate reverts, data changes and incomplete source mapping also produce A→B→A. Keep a per-capture **flake
score**: an exponentially weighted rate of changes that aren't explained by file changes.

### 2.3 Region fingerprints

Record the bounding boxes of unstable regions. If the same region flickers repeatedly, the
viewer suggests a fix, "Region x=1120 y=40 240×24 varied in 6 of the last 20 runs; overlapping
element `header .last-updated`. Add it to `mask`?", and offers a copyable YAML snippet.

### 2.4 Quarantine

Captures with a flake score above a threshold are shown as **unstable**:

- They're still visible, in a separate group.
- They're excluded from "changed" counts and from any gate.
- The comment lists them once, collapsed.

Quarantine ends automatically after N consistent runs.

### 2.5 Determinism probe (local and CI)

`pixelwatch probe --runs 5` captures everything five times and prints a table of views that
varied, with regions and overlapping elements. Run it when adopting and after upgrading
Playwright. PropertyScope's "29/29 identical across two runs" check, made a command.

## 3. Change attribution: why did this view change?

Four complementary techniques, from cheap to precise.

### 3.1 Static path mapping (cheap, v1)

- `sections[].paths` globs in the recipe map files to sections: a PR touching `student-3/**`
  explains changes in `feature-3` views.
- Cross-cutting files (`shared/**/*.css`, design tokens) map to `*`.
- The comment shows, per changed section, the matched changed files. Changes *without* any
  matching file are flagged "unexplained". That catches both flakes and surprising coupling.

### 3.2 Element hit-testing (moderate, high value)

- At capture time, the runner writes `elements.json` per capture: bounding boxes for elements
  with stable identifiers (test-ID, id, role+name, landmark) and a short CSS path. It stays small
  if it's limited to ~500 elements, by visibility and size.
- The trusted side intersects changed regions with those boxes: "Region 2 overlaps `nav >
  [data-testid=brand]` and `h1 'Property data'`."
- The viewer highlights the element outline on hover, and the comment lists the top elements per
  view.

### 3.3 Computed-style diff (precise, opt-in)

- For elements that overlap a changed region, record a whitelist of computed styles at capture
  time: font, size, weight, line-height, colour, background, margin, padding, gap, border,
  radius, box-shadow, width and height.
- Base and head are compared by element identity, which gives the reviewer
  `.card-title: font-size 14px → 15px; color #263b33 → #1f2f29`.
- This is a promising attribution aid; element matches and causal relevance require validation, and values/labels remain untrusted capture metadata.

### 3.4 Coverage-based source mapping (Chromium, opt-in)

- Record CSS and JS coverage while capturing each view (`page.coverage.startCSSCoverage`). Then
  map the used ranges back through source maps to source files.
- That gives, per view, *the set of source files observed by the selected coverage instrumentation*. Intersected with the
  PR's changed files, it yields "this view uses `Button.tsx` and `tokens.css`, both changed in this
  PR".
- It also powers **affected-only capture** (section 3.5).
- **Limits:**
  - Server-rendered HTML and data changes aren't covered.
  - It needs source maps in the served build.
  - It's Chromium-only.

### 3.5 Affected-only capture (built on 3.1 and 3.4)

- The plan step (see capture-and-sharding.md) intersects the changed files with each view's source set, from the latest
  main snapshot's coverage plus the static paths. It skips views with no intersection, and
  uncaptured views may display their old baseline only with an explicit **not captured / assumed** label; they must not increment measured unchanged counts or satisfy a completeness gate.
- **Safety rails:**
  - It's always off on main.
  - It's off when shared or global files change (lockfiles, tokens, the harness itself).
  - The run header states "31 views assumed unchanged (not captured)".
  - The label `pixelwatch:full` overrides it.

### 3.6 Commit attribution on main (bisect, optional)

- A main push with several commits (a merge train or batched pushes) that changed a view can
  trigger `bisect: true`. That's a follow-up job capturing only the changed views at intermediate
  commits.
- Binary search is valid only for a monotone predicate across the selected ordered history. Visual hashes can change and revert; without that assumption use a bounded linear search or report an unverified candidate interval.
- The timeline shows a tested candidate commit or interval and links provenance. Do not attribute an exact first regression/author without confirming preceding states and the history assumptions.

### 3.7 Semantic side-channel: accessibility snapshot diff

- Capture `locator("body").ariaSnapshot()` (Playwright YAML of the accessibility tree) with each
  view. Diff it as text alongside the pixels.
- **What it tells a reviewer:**
  - Pixel change with no aria change: no change detected in this accessibility snapshot; this does **not** prove the change is purely visual or semantically harmless.
  - Aria change with little pixel change: content or semantics changed, such as a missing label
    or a renamed button.
  - Aria change on a view that is otherwise "unchanged": an invisible accessibility regression.
    That's surfaced separately.
- It's cheap (text) and very useful for coding agents.

## 4. Local parity

The goal: "what I see locally is what CI will post". Three layers:

1. **Same runner.** `pixelwatch capture` and `pixelwatch compare` are the CI code paths. The
   viewer from `pixelwatch serve` is the same app build as the site.
2. **Controlled environment, not guaranteed identical pixels.** Fonts, antialiasing and GPU paths differ by OS. `--in-docker` runs capture in
   the pinned image
   (`mcr.microsoft.com/playwright:v<version>-noble` plus the project's fonts layer), which is the
   image the reusable CI workflow uses by default. The environment tuple (image digest, browser
   build, fonts hash) is recorded in every run's capture claims.
3. **Same baseline.**
   - `pixelwatch pull main` downloads the latest main snapshot whose environment tuple matches the
     local one, straight from the public site. That's just static files: a main run's head side
     (`data/v1/runs/…`) plus blobs.
   - A developer can then compare the working tree against CI's baseline without capturing base
     at all.
   - If the tuple doesn't match (the developer isn't using Docker), the CLI refuses by default,
     or an explicit diagnostic override labels results cross-environment and excludes them from a pass/gate. Do not silently raise thresholds to hide environment differences.

Local workflows:

| Command | Does |
|---|---|
| `pixelwatch baseline save` | Capture the current checkout as the local baseline (what `dev.py ui visual` does first) |
| `pixelwatch baseline compare` | Capture the working tree, compare, open the viewer |
| `pixelwatch compare --against main` | Pull CI's main snapshot, capture the working tree, compare |
| `pixelwatch compare --against origin/main --capture-base` | Capture both locally (git worktree for base) |
| `pixelwatch watch --view f1-overview` | Re-capture one view on file change and live-update the viewer: a visual TDD loop |
| `pixelwatch probe` | Determinism check (section 2.5) |

## 5. Baseline reuse (M5)

Reuse can avoid base execution on an eligible hit; it does not necessarily halve total CI
minutes because setup, other jobs, head work and publishing remain. Measure hit rate and
end-to-end minutes. MVP always captures base/head using the existing adapters.

A future cache key includes selected base commit, harness/recipe/lockfile hashes, immutable
runner image, OS/architecture/browser build, fonts, locale/timezone, viewport/device scale,
variant configuration and relevant fixture-data version. Same Docker image is a strong control,
not a universal pixel-equivalence guarantee across architectures, GPUs or unpinned data.
Record these fields and diagnose mismatches; don't silently change thresholds.

Only an independently identified, trusted **default-branch capture source** is eligible for a
shared baseline. A PR's freshly submitted base image does not become trusted baseline material
merely because it claims a main SHA. Keep capture claims distinct from authenticated source
metadata. Recompute repository/base association independently and validate referenced snapshot
membership, environment compatibility and integrity. A matching head-supplied tuple is not
proof that the capture used that environment or rendered that commit.

When the head harness changes, recapture base with that harness; label any new-route/base setup
failure as failed/incomparable, not added. Cache miss means capture, not arbitrary fallback to a
nearby snapshot. Publication is eventually available: missing cached baseline is a normal miss.
A local download uses an explicit configured public origin, bounded fetches and validated paths;
pure comparison consumes already materialized bytes without network access.

This remains an advisory comparison system under the untrusted-capture split, not an attested
regression gate. Approval/gating work requires a separate permission/provenance design and is
not needed for M0–M3.

## 6. Other ideas worth recording

- **Approval memory:** a reviewer can mark a changed capture "expected" in the viewer. The viewer
  has no backend, so this produces a copyable `/pixelwatch approve f1-overview@mobile` PR comment
  that the trusted workflow (`issue_comment`, write-permission check) records against the head SHA.
  It feeds the optional gate.
- **Per-section owners:** `owners: ["@student-3"]` per section (or read from CODEOWNERS). The
  comment mentions only the owners of sections that changed. That's useful for PropertyScope's
  one-student-per-feature layout.
- **Agent output:** superseded by [comments-studio-and-skills.md](comments-studio-and-skills.md) and `../02-contracts.md` §7.
  It covers the stable `api/v1` + `changes.json`, CLI `--json`, MCP, setup and review skills, and the parked AI-review discussion (no AI reviewer in CI).
- **Design-token drift report:** combining 3.3 across all views gives "these 14 colours in use
  aren't in the token set". It's cheap once computed styles exist.

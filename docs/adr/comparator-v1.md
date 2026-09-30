# ADR: Comparator v1

- Status: accepted
- Date: 2026-09-30
- Task / spike: M0.6 (02 §9)

## Context

02 §9 requires the v1 comparator to be taken from PropertyScope's source, not invented, and
pinned by outputs recorded by **running** the prototype. M1.3 ports it. This ADR is the spec that
port is judged against.

**Source** (ADR 0001): <https://github.com/MattShelton04/41026ASDProject> at
`6378d8be5b1f418f72279e04b3de23d761b426d3`:

- `scripts/visual/pixels.py`: constants (lines 20–24), `align` (47–60), `channel_delta`
  (63–66), `_regions` (69–101), `analyse` (104–131) and `classify` (134–142);
- `scripts/visual/report.py`: `_compare` (129–179), and the per-view states in `build_report`
  (263–289).

TracePilot's `scripts/visual/pixels.mjs` (at `067cfcd…`) is an independent JavaScript
implementation of the same algorithm. It's used only as a cross-check.

**Owner decisions (2026-09-30):**

1. **Binding.** The recorded outputs are binding parity goldens for M1.3, except for the deltas
   listed below. Any further delta needs an ADR and a new comparator version (08 §9: "never loosen
   a golden silently").
2. **Committed data.** JSON recordings plus three small real crops. No full-size images (07 §3).
3. **Hidden RGB.** v1 compares alpha-normalized pixels (D1).
4. **Width change.** `changed` with reason `dimensions` and no `diff` (D2).
5. **Real inputs with changes.** PR #123's screenshots turned out to be byte-identical on both
   sides, so real changes come from two TracePilot runs (ADR 0001, M0.6 addendum). PR #123 stays
   recorded as the 42-view unchanged case.

## Decision

### Algorithm (normative)

Inputs are two decoded images as unpremultiplied RGBA8. RGB input gets alpha 255.

1. **Normalize (D1).** Set RGB to 0 wherever alpha is 0, exactly as the 02 §3 pixel hash does
   (`normalizeRgba` in `packages/core/src/pixel-hash.ts`).
2. **Widths differ (D2).** The result is `changed`, reasons `[dimensions]`, and there's no diff.
   Stop.
3. **Align.** Canvas width W = the shared width. Canvas height H = max(base height, head height).
   Pad the shorter image at the bottom with rows of `(0,0,0,0)`. The pad is never resized or
   shifted.
4. **Delta.** For each pixel, delta = the max over R, G, B, A of |base − head|.
5. **Analyses.** For each threshold t in `[0, 8, 16, 32]`, a pixel counts as changed when
   **delta > t** (strict). Record:
   - `changedPixels`;
   - `bounds`: the box of changed pixels, with `pixels = changedPixels`, present only when
     changedPixels > 0;
   - `regions` and `regionCount`.
6. **Regions.**
   - Split the canvas into 8×8 tiles anchored at (0, 0). Tiles at the right and bottom edges may
     be partial.
   - A tile is active if it contains at least one changed pixel. Group active tiles into
     8-connected components.
   - Each component becomes a region: the box of its **changed pixels** (not the tiles), with
     `pixels` = its changed-pixel count.
   - Sort by pixels descending, then y, x, width and height ascending. Keep the first 12, and
     `regionCount` is the total number of components.
7. **Classify:**
   - base height ≠ head height → `changed`, `[dimensions]`;
   - t0 changedPixels = 0 → `unchanged`, `[]`;
   - t0 changedPixels ≤ 128 and t8 changedPixels = 0 (so max delta ≤ 8) → `subtle`, `[pixels]`;
   - otherwise → `changed`, `[pixels]`.

The policy is data (`COMPARATOR_V1` in `tools/prototype-goldens/mapping.ts`: thresholds, subtle
limits, tile, maxRegions). `config@1` only carries `comparator.version: 1`, so the version fixes
the policy. With D1, for equal sizes, t0 = 0 exactly when the pixel hashes are equal, which is what
`checkResult` requires of `unchanged`.

The minimum image is 1×1 (02 §5), so `totalPixels` ≥ 1. Zero or missing sizes are rejected
before comparing and are never scored.

### Mapping to run@1

- `diff.totalPixels` = W × H (the padded canvas).
- `analyses` come in threshold order. Each `threshold` is taken from its position. The prototype
  reuses its t0 dict (which says `threshold: 0`) for every threshold when nothing changed, and
  that quirk isn't carried.
- `changedPpm` = `changedPpm(changedPixels, totalPixels)`. The prototype's float `percent`
  (`round(…, 4)`) isn't stored.
- `regions`/`regionCount` are always present when a diff is, including `[]`/`0`.
- A diff is present whenever both sides are captured with equal widths, including `unchanged`.

### Side states (02 §4, ADR 0003) and what the prototype did

The prototype only knows `incomplete` (no usable head) and `base unavailable` (no usable base).
v1 splits those by 02 §4 precedence. Evidence: `build_report` on mutated copies of the PR #123
inputs (`state-probes.json`).

| Probe (mutated view) | Prototype | v1 (bundle side → result) |
|---|---|---|
| Head PNG deleted | `incomplete` | `failed`/`image-missing` → `failed` |
| Head case `failed` | `incomplete` | `failed`/`capture-error` → `failed` |
| Base case `failed` | `base unavailable` | `failed` |
| Case dropped from head manifest | `incomplete` | `missing`/`unit-missing` → `missing`, or `absent` → `removed` with a `revisionCatalog` |
| Case dropped from base manifest | `base unavailable` | `missing`, or `added` with a `revisionCatalog` |
| Whole base part missing (stack) | `base unavailable` ×13 | `missing`/`part-missing` → `missing` |
| Head PNG 1441 px wide | `incomplete` | compared: `changed`/`dimensions` (D2) |
| No base revision at all | `base unavailable` | `none` → `incomparable`/`no-baseline` |

v1 reasons:
- `missing` lists its causes (`part-missing`, `unit-missing`);
- `failed` is `capture-failed`;
- `no-baseline` is added whenever the base is `none`, whatever the status;
- `added`, `removed` and `unchanged` have none.

Reasons follow the schema's enum order.

### Deltas from the prototype

| ID | Prototype | v1 | Why | Fixtures |
|---|---|---|---|---|
| D1 | Delta includes RGB under alpha 0 | Normalize first | `unchanged` ⇔ equal pixel hash (02 §4, `checkResult`). No effect on any recorded real image: all are opaque | `hidden-rgb` (prototype `changed`, v1 `unchanged`), `hidden-rgb-then-visible` (prototype `changed` Δ70, v1 `subtle` Δ1) |
| D2 | Only 1440 px wide, 200–6000 px tall (`pngsafe.py`); anything else is `incomplete`, and different widths raise a numpy broadcast `ValueError` | Any 02 §5 size; different widths → `changed`/`dimensions`, no diff | PixelWatch isn't tied to one viewport. Width padding could exceed the 16,000,000-pixel `totalPixels` bound | `width-change` (prototype error recorded); probe `head-png-width-1441` |

Each D1 expected result is the prototype's own output on the normalized input, which is recorded
as `prototypeOnNormalized`. It isn't hand-written.

### Clarifications (not deltas: every recording agrees)

- **Region tie order.** The prototype orders exact ties in (pixels, y, x) by Python set iteration.
  v1 adds width, then height. `region-sort-tie` (two 7-pixel regions both starting at (0, 0))
  recorded the same order v1 gives. Any recording whose order differs fails generation.
- **Height change with zero delta.** A head that grows by fully transparent rows compares equal
  on the canvas but is still `changed`/`dimensions` (`height-grow-transparent`).

### Not in v1 output

These prototype outputs aren't run@1 fields:
- the heatmaps and the difference image;
- `merge_areas` (gap 24) review areas;
- focus and preview crops;
- `area_key` and `group_shared_changes` (`sameAs`/`sharedWith`).

All of them can be derived from the stored data (top-12 regions at t0 and t8, plus `labels.group`),
because the prototype also derives them from the truncated top 12. They're recorded under
`prototype.review` for the M2/M3 comment and viewer work.

v1 never emits `environment-mismatch` or `alignment`: `config@1` has no environment policy.
Adding one is a later ADR.

### Recorded goldens

`tools/prototype-goldens/record.py` runs the prototype's own code at the pin under its own
environment. On 2026-09-30 that was: Windows 11 (10.0.22621), CPython 3.12.13, numpy 2.5.2 and
Pillow 11.3.0 (versions from its `uv.lock`), with uv 0.12.1. Install and run:

```sh
cd .reference/propertyscope
uv sync --locked --only-group visual --no-build   # wheels only: nothing built, no scripts run
uv run --no-sync python ../../tools/prototype-goldens/record.py --prototype . \
    --tracepilot ../tracepilot --artifacts ../artifacts --work ../m06 --out ../../testdata
node tools/prototype-goldens/expected.ts           # from the repo root
```

Two consecutive runs of the final harness produced byte-identical files. The harness refuses a
prototype checkout that isn't at the pin or has local changes, and it checks every zip against its
ADR 0001 digest.

| Input | Run by | Result |
|---|---|---|
| PropertyScope PR #123 (run 36405830015), 42 views | `build_report`, the CI publisher path | 42 × `unchanged`. Base and head PNGs are byte-identical |
| TracePilot run 36287837535 (push), 64 views | `report._compare` + `pngsafe` per pair | 1 `changed` (`settings-pricing`, 252 px), 1 `subtle` (`config-injector`, 44 px), 62 `unchanged` |
| TracePilot run 36301239732 (PR), 101 views | same | 5 `changed` (`rich-tool-*`, 729–4607 px), 96 `unchanged` |
| 47 tiny cases (1×1 to 64×64) | `report._compare` on arrays | covers all 8 results and every edge (below) |
| 3 real crops (1440×256 bands) | `report._compare` | 1 `subtle`, 2 `changed` |

**Cross-check.** On all 165 TracePilot views, PropertyScope's comparator matches TracePilot's
own published result (`gh-pages` `visual/runs/<id>/changes.json` at `2f21af1…`) in both status
and exact changed-pixel count. TracePilot computed those on its CI runners, so the Windows
recording agrees with an independent implementation on another platform.

**Tiny cases cover:**
- all 8 statuses, and the precedence of missing > failed > incomparable/added/removed;
- delta 1/8/9/16/17/32/33/255, |Δ|, and the max across channels;
- alpha-only changes of 8 and 9, alpha 0→1, and hidden RGB;
- the subtle limit at 128 vs 129 pixels;
- height grow, height grow with zero delta, height shrink, and a width change;
- 1×1 images;
- regions: tile boundary, diagonal, gap, clipping, per-threshold regions, sort order, ties, and
  16 regions → 12 kept.

Committed files (SHA-256):

| File | SHA-256 |
|---|---|
| `testdata/comparator/tiny/cases.json` (generated input) | `c5456368ab4f78f183b2d69febe35497f7ed2848705831c7d7b8fc32ccc83d31` |
| `testdata/comparator/tiny/prototype.json` | `f7eb5a32402ac77fd85367bdcff3e8c517e088c3e28e25bb6f1e5f0f8869f27b` |
| `testdata/comparator/propertyscope-pr123/prototype.json` | `76e8a46ef9e4ad8e5c599ea7e445884ff974d9f6d7512929a7be7e514cecd4ed` |
| `testdata/comparator/propertyscope-pr123/state-probes.json` | `1159fd1f8ee10a6824b746b8ced6dd90d72d14d56da60fc5ce7b7973aaa07672` |
| `testdata/comparator/tracepilot-36287837535/prototype.json` | `3503f719ea2f1d0bd265551cf65daccbe738808e508ea9113f30e84c5ea36fd0` |
| `testdata/comparator/tracepilot-36301239732/prototype.json` | `e14831bcab0a67bf9ea8ec875a3469d475814f448503ca604e0cba2e18cfcff1` |
| `testdata/comparator/crops/crops.json` | `8d721b6f04ba618b4dd5a2b4a4683e74dd3dde778af3d3fb8f3491a1bfecfb32` |
| `testdata/pixel-hash/vectors.json` | `66aba0e4a0a3b247a637e022b1fb87ed62453e705cea8ff4f36f7b5c15e45a14` |

The crop PNG hashes are in `crops.json`. `tiny/expected.json` and `crops/expected.json` are
generated from the files above, and a test fails if they're stale.

## Consequences

- **M1.3 must reproduce all of the following:**
  - `tiny/expected.json` and `crops/expected.json` exactly, in `pnpm check`;
  - every compared view of the three full-size recordings, mapped with
    `comparedResult` (`tools/prototype-goldens/expected.ts`).

  The full-size inputs live only in `.reference/` and are never committed, so that last check is
  local, like `tools/check-reference-conversion.ts`. The GitHub copies expire on 2026-10-11/12;
  after that it needs the owner's backup of `.reference/artifacts/`. The crops keep real-pixel
  parity in CI.
- M1.1/M1.2 should decode the real PNGs and crops and match the recorded `pixelHash` values.
  Those come from Pillow plus an independent Python hash.
- `packages/core` now exists with the pixel hash only (M1.2 adds blob reuse). The fixed vectors
  in `testdata/pixel-hash/vectors.json` come from the independent Python implementation.
- 02 §9 points here. ADR 0001 has an M0.6 addendum for the TracePilot inputs. 08 M0.6 names them.

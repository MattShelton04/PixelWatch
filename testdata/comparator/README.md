# Comparator-v1 goldens (recorded, binding)

The spec is `docs/adr/comparator-v1.md`. Everything here except `tiny/cases.json` is **recorded
output** from running PropertyScope's comparator at `6378d8be…`, or is generated mechanically from
that recording. Nothing is hand-written. Never edit these files by hand.

| Path | What | Made by |
|---|---|---|
| `tiny/cases.json` | 48 small hand-built inputs (1×1 to 64×64). Images are a fill colour plus `[x, y, w, h, rgba]` rectangles. Side-state cases declare their 02 §4 result | `tools/prototype-goldens/tiny-cases.ts` |
| `tiny/prototype.json` | The prototype's `report._compare` on each captured pair (plus on the alpha-normalized pair where that differs, for D1). Python pixel hashes per side | `record.py` |
| `tiny/expected.json` | comparator-v1 run@1 results (the M1.3 target) | `tools/prototype-goldens/expected.ts` |
| `propertyscope-pr123/prototype.json` | `build_report` on PR #123 (run 36405830015): 42 × unchanged. Input file hashes, dimensions and pixel hashes | `record.py` |
| `propertyscope-pr123/state-probes.json` | `build_report` on mutated copies of those inputs: the prototype's own states | `record.py` |
| `tracepilot-<run>/prototype.json` | `report._compare` on every pair of TracePilot runs 36287837535 and 36301239732, with TracePilot's own published result per view | `record.py` |
| `crops/*.png`, `crops/crops.json` | Three real 1440×256 base/head bands (1 subtle, 2 changed) and the prototype's result on them | `record.py` |
| `crops/expected.json` | comparator-v1 results for the crops | `expected.ts` |
| `../pixel-hash/vectors.json` | Fixed 02 §3 vectors from an independent Python implementation | `record.py` |

## Regenerating

Only regenerate when the recording method changes. A change in the comparator's **meaning**
needs a new ADR and comparator version instead.

Recording needs the reference inputs in `.reference/` (ADR 0001 and its addenda):

```sh
cd .reference/propertyscope
uv sync --locked --only-group visual --no-build
uv run --no-sync python ../../tools/prototype-goldens/record.py --prototype . \
    --tracepilot ../tracepilot --artifacts ../artifacts --work ../m06 --out ../../testdata
cd ../..
node tools/prototype-goldens/tiny-cases.ts   # only if the cases changed (then re-record)
node tools/prototype-goldens/expected.ts
```

`packages/core/test/comparator-goldens.test.ts` fails if `cases.json` or either `expected.json`
is stale, if a required edge or state loses its fixture, or if any recording stops fitting run@1.
It also requires the core comparator to reproduce both `expected.json` files exactly. Full-size
parity is local only: `node tools/check-reference-compare.ts` (needs `.reference/`).

# ADR 0010: Simplification pass before M1.5

- Status: proposed
- Date: 2026-10-02
- Task / spike: between M1.4 and M1.5

## Context

M0–M1.4 delivered working, tested code. A review before M1.5 found machinery that costs code,
CPU or contract surface without protecting anything the security model (01 §4) asks for. Each
item below says what it was, why it doesn't earn its keep, and what replaces it. None of them
weakens a 01 §4 rule. Where a threat-model row pointed at removed code, the row now points at the
check that still enforces the rule.

## Decision

### 1. Config is JSON (supersedes ADR 0009)

The adopter config is `.pixelwatch/config.json`, read through the same strict JSON parser and
schema validation as every other document (`parseDocument("config", bytes)`).

- ADR 0009 wrote a 380-line YAML subset parser, plus differential tests against the `yaml`
  package, to make sure a document means the same under YAML 1.1 and 1.2. JSON has no such
  ambiguity, and we already have a hardened parser for it. The config is about ten lines.
- The `theme` fallback is gone. An invalid setting fails like any other (02 §10 only said it
  *may* fall back).
- Removed: `packages/core/src/config/`, its tests, and the `yaml` devDependency.

### 2. One inflate pass for PNGs and ZIP entries

Both readers inflated everything twice: once to validate while discarding the output, then again
to extract. Every image therefore cost four inflations (two for its ZIP entry, two for its PNG).

- **PNG:** `decodePng` checks the chunk structure, allocates the output buffer the checked header
  sizes (≤ 64 MiB), and inflates once into it. The scanline byte count is still enforced during
  inflation, so overflow, truncation, trailing data and bad filter bytes are refused without ever
  writing past the buffer. `inspectPng` is gone.
- **ZIP:** `openZip` checks structure, names and layout without inflating, and charges every
  entry's declared size to the per-ingestion budget. `readEntry` holds inflation to exactly that
  size and checks the CRC. A lying header fails instead of expanding, so budgeting declared sizes
  bounds memory exactly as counting inflated bytes did.
- The only thing given up is "no image-sized allocation for a hostile file": a header that claims
  4000×4000 now gets its 64 MiB buffer before its data is found short. That allocation is bounded
  by the header checks and the one-image-at-a-time worker budget, so 01 §4.3 ("before and during
  allocation") still holds. 02 §5's Inflation row says so.

### 3. Existing blobs aren't decoded again

`storeBlob` used to read every existing blob, decode it and recompute its pixel hash before reusing
it. In a typical run most images are unchanged, so that roughly doubled decode work, to guard
against corruption of a publisher-owned branch whose objects Git already checksums. Now
`BlobPool` is `has(path)` and `add(path, bytes)`: an existing blob is reused untouched, a new one
is the canonical encoding. `verifyBlob` and `BlobError` are gone. Blobs are still never
overwritten (R4.3-09).

### 4. Bundle images are `<viewId>.<variantId>.png`

A captured unit's image used to be `u-<SHA-256 of the canonical unit-key JSON>.png`, and
`bundle.json` repeated that name in a `file` field that a semantic check then recomputed. The
hash protected nothing: IDs are already `[a-z0-9][a-z0-9_-]{0,63}`, safe as file names, and a
part has exactly one provider.

- The entry name is `<viewId>.<variantId>.png`. IDs never contain a dot, so the name is
  unambiguous, and the ZIP allowlist is `UNIT_FILE_PATTERN` in `@pixelwatch/schemas`.
- bundle@1's captured unit has no `file` field; the name is derived. The `file-name-mismatch`
  check, `unitKeyDigest` and the old `unitFileName` hashing are gone.
- The converters take a `variantId` (default `desktop`), so each capture width or theme is its
  own variant instead of every screenshot being filed under one hard-coded desktop setting.
- bundle@1 hasn't shipped, so this is an in-place change with no migration. The hostile ZIP
  corpus was regenerated with `node tools/zip-corpus/generate.ts`.

### 5. No snapshot records

snapshot@1 was a per-revision manifest keyed by the SHA-256 of its canonical JSON. Its content
(units, side states, claims, parts) is already in run@1, and because it embedded its own run's
part provenance, two runs never produced the same snapshot ID, so it deduplicated nothing.

- snapshot@1, its fixtures and semantic check, run@1's `snapshots` field and the canonical
  encoder's `omit` option are gone. `data/v1/snapshots/` isn't written.
- Later baseline reuse (`future/review-features.md` §5) reads a main run's head side.

### 6. Idempotency by run key; streams are derived

- **No ingestion digest.** run@1's `ingestionDigest` and the per-part archive SHA-256s are gone;
  parts carry the API's `artifactId`. A completed attempt's artifacts can't change, so the run
  key already identifies the input, and the "same key, different digest" conflict could only
  fire on a publisher bug. A run key already in `store.json` is a no-op, never an overwrite
  (R4.5-04 is unchanged in effect).
- **No stored streams.** `store.json` already lists every run with its stream, in history order,
  so `data/v1/streams/*.json` was a second, mutable copy of the same index. The projector
  generates stream@1 from `store.json`; the store branch holds only `store.json`, runs and blobs.

## Consequences

- Less contract surface for M1.5: build a run from an `Ingestion` plus the envelope, append it to
  `store.json`, and treat an existing run key as done.
- bundle@1 and run@1 change in place. Neither has shipped, so no data migration is needed.
- The PNG and ingest benches and the real-capture check were rerun after §§2–6
  (`docs/evidence/m1.1-png-bench.md`, `m1.4-ingest-bench.md`, `m1.4-reference-ingest.md`). On this
  machine, real decode went from 55 to 36 ms, the maximum ingestion from 21.1 to 17.2 s, and the
  real captures from 21.7 to 16.6 s (PropertyScope) and 49.9 to 41.0 s (TracePilot). The
  64 MiB-header PNG bomb now peaks at 169 MiB RSS instead of 90 (§2's trade-off), within the
  512 MiB budget.

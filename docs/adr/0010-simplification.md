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

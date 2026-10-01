# ADR 0003: Schema details and prototype → `bundle@1` mapping

- Status: accepted
- Date: 2026-09-30
- Task / spike: M0.3

## Context

M0.3 freezes the 02 §1 schemas and writes `bundle@1` converters for PropertyScope and TracePilot
(ADR 0001). 02 leaves some details open, and the prototypes' output doesn't map 1:1 onto 02 §4.
The owner decided the four open questions on 2026-09-30. The rest are details this ADR fixes so
later milestones don't re-decide them.

## Decision

### Owner decisions

1. **Added/removed.** Neither prototype records explicit absence. A converter takes an optional
   `revisionCatalog`: the view IDs that the captured revision's own case inventory declares.
   - Not captured and **not** in the catalog → `absent` (`not-in-revision-catalog`).
   - Everything else that wasn't captured → `failed`.
   - Without a catalog, `absent` is never emitted, so `added`/`removed` are never inferred from an
     error (02 §4).
2. **Percentages.** Diff analyses store integers: `changedPixels`, `totalPixels`, and
   `changedPpm = round-half-up(1e6 × changedPixels / totalPixels)`. Validation recomputes
   `changedPpm` and rejects a mismatch. No floats appear in any document.
3. **TracePilot reference data.** Run 36314265418 is an additional reference input (ADR 0001
   addendum).
4. **Identity.**
   - `variantId` is `desktop` for both prototypes.
   - PropertyScope providers are `fixture` and `stack`, one part per provider (shard 1/1).
   - TracePilot's provider is `fixture`, sharded as its manifest says (`i/n`).
   - `viewId` is the prototype case ID.

### Prototype status mapping

| Prototype | `bundle@1` unit |
|---|---|
| `captured` + PNG inside the 02 §5 profile | `captured` |
| `captured`, no PNG | `failed` / `image-missing` |
| `captured`, PNG outside the profile | `failed` / `image-invalid` |
| `failed` | `failed` / `capture-error` |
| `incomplete`, or TracePilot `missingFixtures` | `failed` / `capture-incomplete` |
| any other status | `failed` / `unknown` |
| not captured, not in `revisionCatalog` | `absent` / `not-in-revision-catalog` |

- A capture the prototype itself flagged as incomplete is not trustworthy enough to compare, so
  it becomes `failed`, never `captured`.
- Diagnostic screenshots of failed cases are never included.
- An invalid or duplicate case ID, an unknown manifest schema, a provider/revision mismatch, or
  more than 2000 cases **throws**. Dropping a unit would hide work.
- Labels (`group` = section, `state`, `route` = path) and messages are bounded: ≤ 256 code
  points for labels, ≤ 2048 UTF-8 bytes for messages. Control characters become spaces.
- The manifest's own `sha256` per image is ignored. Hashes are computed from pixels later.
- PNGs pass through with only ancillary chunks (and a truecolour PLTE) stripped (02 §2 "strips
  metadata"; 02 §5 allows only IHDR, IDAT and IEND). No re-encoding happens: all 294 reference
  PNGs are already plain 8-bit RGB IHDR/IDAT/IEND.

### Schema details 02 leaves open

- **Side state `none`.** 02 §4's `incomparable` includes "no usable baseline (e.g. initial
  commit)", but there is no side state for "this revision doesn't exist". Result sides are
  `captured | absent | failed | missing | none`. `none` is only valid on the base side and always
  carries reason `no-baseline`. With a captured head the result is `incomparable`. A missing or
  failed head still wins by precedence. `none` + `absent` isn't a unit.
- **Canonical key order** (02 §3 "keys sorted") is by Unicode **code point**, not UTF-16 code
  unit. Only non-BMP keys can tell the two apart; tests pin such a case.
- **Canonical numbers** are safe integers only (no `-0`). Strings are escaped as
  `JSON.stringify` escapes them. Lone surrogates are rejected.
- **`deviceScaleFactor`** is an integer 1–8. That follows from the integer-only rule. A
  fractional DPR (e.g. 1.5) needs a schema version bump.
- **Run keys.** The `import-<sha256>` form is accepted by the `RunKey` pattern, but `run@1` has no
  import source envelope yet. That's added with legacy import (M3.5), not guessed now.
- **History order** (`store@1` run index) is `sourceCreatedAt`, then numeric source run ID, then
  numeric attempt, compared as BigInt.
- **`changes@1`** image URLs must be `https:`, with no query and no dot segments.
  `source.captureClaimsTrusted` is the constant `false`.

## Consequences

- `packages/schemas` implements all of the above. The fixtures under `testdata/schemas/` cover
  each rule.
- M1 (publisher) must supply `revisionCatalog` from the **captured revision's own** checked-out
  inventory, or accept that removed views show as `failed`/`missing` rather than `removed`.
- M1.3's comparator writes `changedPpm` with the formula above.
- 02 §2–§4 carry a one-line pointer to this ADR.

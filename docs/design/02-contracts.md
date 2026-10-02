# 02 · Canonical MVP contracts

This file is the single source of truth for M0–M3 data contracts. M0.3 turns it into JSON Schemas
with valid/invalid fixtures and generated TypeScript types. Don't freeze schemas for M4+
features (recipes, findings, flows) now.

## 1. Schema inventory

General rules: every persisted object declares its schema version and is validated before use.
No unknown keys (unless a named, bounded extension field is added deliberately). Duplicate JSON
keys are rejected.

| Schema | Contents |
|---|---|
| `bundle@1` | `schemaVersion: 1`; source claims; `revision: base\|head`; provider; shard index/count; complete declared unit catalog; per-unit result. No publishing decisions. |
| `config@1` | Allowed source workflow IDs/events; providers and fixed shard counts (at most 128 shards in total, so base and head parts fit `run@1`'s 256 `parts`); base policy (01 §4.4); comparator policy/version; store branch and prefix; retention and byte limits; comment on/off; theme preset |
| `store@1` | Ownership marker, repository ID, data version, transaction counter, run index. No app code. |
| `run@1` | Run key; authenticated source envelope; capture claims; config/release/comparator versions; ingestion digest; base and head snapshot refs; results; coverage; ordering fields |
| `snapshot@1` | Revision claim, normalized capture environment, sorted unit entries with explicit side states |
| `stream@1` | Ordered bounded run-key list plus latest pointer. Only `main` and `pr-<number>` in the MVP. |
| `site@1` | Base path, release/data/API versions, data references, generation, theme preset. No code URLs. |
| `changes@1` | Public agent projection (§7), not internal store objects |

Product version, each schema version, the store `dataVersion`, the API version and the
comparator version are different things. Version them separately.

## 2. The bundle (level 0: bring your own screenshots)

The MVP has internal converters for PropertyScope and TracePilot capture output. Any conversion
or re-encoding happens **on the untrusted capture side**. The publisher only accepts §5's PNG
profile; it never installs an image library or runs project scripts.

A converter:

- emits a complete per-part catalog with an explicit state for every unit (§4);
- names each image file `u-<digest>.png`, where digest is SHA-256 of the canonical unit-key JSON
  (§3), and includes no other files;
- strips metadata and non-image payloads;
- records optional CSS-space capture geometry (viewport, device scale, crop origin, full-page vs
  element). Actual pixel dimensions come from decoding, never from the manifest. A 390 px CSS
  viewport at device scale 3 gives a 1170 px wide image.

Only aligned images are compared. A size change is `changed` with reason `dimensions`, never
silently resized.

The prototype → `bundle@1` mapping (status mapping, `revisionCatalog` for absence, identity) is
in ADR 0003.

## 3. Identity and hashing

- **Unit key:** `(providerId, viewId, variantId)`. Each ID matches `[a-z0-9][a-z0-9_-]{0,63}`.
  Display labels are separate bounded text. Serialize the key as a three-element JSON array for
  hashing; never join with a delimiter.
- **SHA-256 strings:** 64 lowercase hex. Git commit OIDs are validated as Git OIDs, not as content
  hashes.
- **GitHub numeric IDs:** nonzero decimal **strings**. Compare numerically, never lexically or as
  floats.
- **Run key:** `<sourceRunId>-a<sourceAttempt>`. A publisher retry is not a new attempt. Imported
  history uses `import-<sha256>`.
- **Canonical JSON for hashing:** UTF-8, keys sorted recursively, no whitespace, finite integers
  only, arrays in order, no Unicode normalization of values, and the object's own ID/digest field
  excluded. Tests pin the exact bytes and hashes.
- **Pixel hash:**

  ```text
  pixelHash = SHA256( UTF8("pixelwatch:rgba8:v1\0") || U32BE(width) || U32BE(height) || rgba )
  ```

  `rgba` is row-major, top-to-bottom, tightly packed, **unpremultiplied RGBA8**. RGB input gets
  alpha 255. Set RGB to 0 **only where alpha = 0**. No premultiplication, no colour transforms.
  Fixed test vectors must cover: dimension byte order, hidden RGB under alpha 0, alpha 1 and 254,
  RGB vs RGBA equivalence, and different dimensions with the same byte count. Changing
  normalization later needs a new domain string (`v2`) and a migration.
- **Snapshot ID:** SHA-256 of the canonical snapshot payload (sorted units, pixel hashes, claimed
  environment, provenance references), excluding its own ID. Unit arrays are sorted by the three
  ASCII IDs.
- **Derived images** (comment previews, thumbnails): named by SHA-256 of their encoded bytes.

ADR 0003 fixes the details: code-point key order, safe integers only, history order.

## 4. Coverage and result states

Each side of a cataloged unit is exactly one of:

- `captured`: one file;
- `absent`: explicit catalog absence, with a reason;
- `failed`: capture/setup failed, with a bounded error category.

A unit missing from a catalog, or a whole missing part, is **missing**, not `absent`.

Every compared unit has exactly one result, decided in this precedence order:

| Result | Rule |
|---|---|
| `missing` | A required part or side entry is unavailable |
| `failed` | Both sides accounted for, at least one failed |
| `incomparable` | Captured, but violates environment/alignment policy, or no usable baseline (e.g. initial commit) |
| `added` / `removed` | One side captured, the other explicitly `absent`. Never inferred from an error. |
| `unchanged` | Both captured, identical dimensions and pixel hash |
| `subtle` / `changed` | Both captured and comparable but different; comparator thresholds decide. Dimension changes are `changed` with reason `dimensions`. |

- Both sides `absent` isn't a unit, and is rejected if listed.
- The eight counts always sum to `results.length`.
- A missing part whose catalog is unknown goes in `missingParts` with an **unknown** unit count,
  never an invented zero.
- The summary reports `declaredUnits`, `accountedUnits`, `missingParts` and
  `coverage: complete-declared | incomplete | unknown`.
- "complete-declared" means the PR's own catalog was fully accounted for. It never claims the app
  was fully covered.
- `unstable` and `assumed-unchanged` are future states, not MVP.

ADR 0003 adds the base-side state `none` (no baseline revision) and integer `changedPpm` for
diff percentages.

## 5. Ingress profile and hard limits

These are product defaults. M0 fixtures must show both real adapters fit within them. Raising a
limit needs a measured memory bound, never disabling the check.

| Resource | Limit / behaviour |
|---|---|
| Artifact download | ≤ 128 MiB compressed each, ≤ 256 MiB per source attempt; 60 s request timeout; bounded retries; never log signed URLs |
| Archive | ZIP only, single disk, stored/deflate entries. No encryption, ZIP64, links or special files. ≤ 4096 entries and ≤ 512 MiB total expanded per ingestion. |
| Entry names | Exactly `bundle.json` and `u-<64 hex>.png`, flat ASCII. No separators, drive prefixes, NUL or dot paths. No duplicates or case-fold collisions. |
| JSON | ≤ 1 MiB each, nesting ≤ 32, ≤ 2000 units total. Labels ≤ 256 code points / 1024 bytes. Errors ≤ 2048 bytes. No duplicate keys or non-integer numbers. |
| PNG size | ≤ 32 MiB encoded; each dimension 1–16383; ≤ 16,000,000 pixels; one decode/compare at a time within a 512 MiB worker budget. The budget is enforced by the decoder's own allocation bound (sized from the checked header) and verified by recorded peak RSS. Worker `resourceLimits` cap only the V8 heap; the worker adds isolation, a timeout and cancellation. |
| PNG profile | Signature; one IHDR; contiguous IDATs; one final IEND; valid CRCs; 8-bit RGB or RGBA; compression/filter method 0; non-interlaced; only IHDR, IDAT and IEND chunks (no PLTE, ancillary or unknown chunks); no trailing bytes |
| Inflation | Expected scanline byte count computed from checked dimensions and enforced during inflate. Reject extra data, truncation, bad filter bytes and overflow **before** allocating decoded buffers. |
| Work | 10-minute hard timeout per ingestion; cancellable per artifact and image. Excess work is refused, never published as a partial pass. |

- Stream entries and count actual decompressed bytes, not ZIP metadata. Validate central/local
  header consistency and reject duplicates before extraction. The ZIP reader is part of the
  trusted computing base: vendor or pin it, and test it.
- A malformed part is rejected. Valid sibling parts may still form an explicitly incomplete run.
- The publisher re-encodes decoded pixels to canonical PNG. It never copies the uploaded file.
- APNG and metadata are outside the profile; other encoders must normalize before upload.
- ADR 0008 records the exact archive layout accepted (including upload-artifact's data
  descriptors) and which failures reject a part versus refuse the whole ingestion.

## 6. Artifacts and merging (MVP)

Artifact name:

```text
pixelwatch-b1-a<attempt>-<base|head>-<provider>-s<index>-of<count>
```

Attempt, index and count are decimal without leading zeros. Index is 1-based and ≤ count. Count
must equal the trusted config's shard count for that provider. `bundle.json` repeats revision,
provider and shard identity; all of it must agree with the name and the authenticated envelope.

Merge procedure:

1. List **all pages** of artifacts for the validated source run (bounded). Select only expected
   names for the selected attempt. Download by returned artifact ID only.
2. Reject duplicate names/part keys and conflicting unit entries. Never pick "newest".
3. Validate every part against the same run/attempt, revision policy, schema and provider
   config. Parts own disjoint unit keys per revision.
4. `missingParts = expectedParts(config) − receivedValidParts`. Missing catalogs mean unknown
   unit counts. A listed unit without a result is `missing`.
5. The union of catalogs is the **declared** set. Omitted or failing work is never `unchanged`.
6. Persist part diagnostics and coverage in the run and in `changes.json`.

ADR 0008 fixes the details: conflicting parts are all rejected, a side no valid part lists is
`part-missing` or `unit-missing`, and units absent on both sides are excluded with a diagnostic.

**Rerun rule:** only **Re-run all jobs** produces a new complete attempt. Never mix parts across
attempts. A failed-jobs-only rerun yields an incomplete attempt with an instruction to rerun
all. Mixed-attempt reconstruction is M5.

## 7. Agent API: `changes@1`

Paths under the site prefix:

```text
api/v1/index.json                    # API/schema version, repository, streams
api/v1/runs/<runKey>/changes.json    # immutable per run analysis
api/v1/pr/<number>/latest.json       # small mutable pointer: run key, head SHA, generation
llms.txt                             # explains versions, trust, coverage; links the schema
```

Each result carries the unit identity, one status, reasons, base/head image URLs (when present),
dimensions, diff measurements and optional region bounds. The document also carries source
(corroborated) vs claims (untrusted), comparator version, coverage and counts. Features not run
are absent with a capability flag, never empty arrays implying a pass. URLs are built from the
configured origin/prefix and IDs only.

Illustrative abridged example (not schema-complete):

```json
{
  "schemaVersion": 1,
  "runKey": "101-a1",
  "source": { "repositoryId": "1", "workflowId": "2", "runId": "101", "attempt": "1",
              "event": "pull_request", "prNumber": "3",
              "association": "corroborated", "captureClaimsTrusted": false },
  "coverage": { "status": "complete-declared", "declaredUnits": 4, "accountedUnits": 4,
                "missingParts": [] },
  "counts": { "missing": 0, "failed": 1, "incomparable": 0, "added": 0, "removed": 0,
              "unchanged": 2, "subtle": 0, "changed": 1 },
  "results": [
    { "providerId": "fixture", "viewId": "home",   "variantId": "desktop", "status": "unchanged" },
    { "providerId": "fixture", "viewId": "search", "variantId": "desktop", "status": "changed" },
    { "providerId": "stack",   "viewId": "home",   "variantId": "desktop", "status": "unchanged" },
    { "providerId": "stack",   "viewId": "map",    "variantId": "desktop", "status": "failed" }
  ]
}
```

`llms.txt` explains; it doesn't instruct agents to run commands. Reanalysis creates a new
analysis version and never rewrites an existing `changes.json` URL.

## 8. Source envelope and idempotency

The publisher builds the envelope itself: repository ID, workflow ID, source run ID and attempt,
event, source-created timestamp, workflow ref/SHA from GitHub, resolved PR association (or none),
corroborated base/head commits, config SHA, release SHA. It requires a completed run of the
configured workflow and an allowed event. `workflow_run` payload data must match the REST
response; a mismatch fails safely.

- **Ingestion digest:** covers the capture-source identity plus sorted validated artifact content
  hashes. It excludes the publisher release, config, current PR head, URLs and timestamps.
- Same run key + same digest → no-op. Same run key + different digest → conflict, reported,
  never overwritten.
- A retry under a newer publisher returns the existing result unchanged. Reanalysis is a separate
  explicit operation.
- **History order:** source-created time, then numeric run ID, then numeric attempt. Publisher
  finish time doesn't count.

## 9. Comparator policy (M0 input gate)

The exact prototype thresholds, pixel-difference formula, alpha handling, tile/region grouping
and boundary behaviour must be taken **from the PropertyScope source** (`scripts/visual/pixels.py`,
`report.py`) and recorded in `docs/adr/comparator-v1.md`, with golden outputs produced by
**running the prototype** on real bundles. Don't invent a "parity" algorithm or new defaults. An
owner-approved deliberate change gets a new comparator version and an explicit golden delta.
The core receives the policy as data. Test zero/missing denominators, dimension changes and
incomplete comparisons. Thresholds never turn missing or failed into unchanged.

Confirmed against the source in `docs/adr/comparator-v1.md`: thresholds `[0, 8, 16, 32]` (a
pixel changes when its max RGBA channel Δ > t), subtle = ≤ 128 changed pixels and max Δ ≤ 8,
regions from 8-connected 8 px tiles (top 12 kept). The ADR lists the two approved deltas: pixels
are alpha-normalized as for the pixel hash, and a width change has no diff. Grouping of identical
changed areas is presentation, derived from stored regions, and not part of the run.

## 10. Trusted config parsing

- The config is `.pixelwatch/config.json` at the recorded default-branch commit. It goes through
  the same strict JSON parser and schema validation as every other document
  (`parseDocument("config", bytes)`): duplicate keys, non-integer numbers and anything over 1 MiB
  are refused. JSON has none of YAML's version-dependent scalars, so there is no subset parser
  (ADR 0010 supersedes ADR 0009).
- Unknown versions, unsafe paths/URLs/limits, source-policy errors and any other invalid setting
  stop **before any store write, deployment or comment**. Nothing falls back to a default.
- Unknown `bundle` schema versions produce an actionable unsupported-input diagnostic.

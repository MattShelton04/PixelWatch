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
| `run@1` | Run key; authenticated source envelope; capture claims per side; config/release/comparator versions; parts by artifact ID; results with both side states; coverage. Self-contained: there are no separate snapshot records. |
| `stream@1` | Ordered bounded run-key list plus latest pointer, **projected** from `store.json`'s run index, never stored. Only `main` and `pr-<number>` in the MVP. |
| `site@1` | Base path, release/data/API versions, data references, generation, theme preset. No code URLs. |
| `changes@1` | Public agent projection (§7), not internal store objects |
| `api-index@1` | `api/v1/index.json`: API and schema versions, repository, generation, streams with their latest runs (§7, ADR 0013) |
| `pr-pointer@1` | `api/v1/pr/<number>/latest.json`: run key, head SHA, generation (§7, ADR 0004, ADR 0013) |

Product version, each schema version, the store `dataVersion`, the API version and the
comparator version are different things. Version them separately.

## 2. The bundle (level 0: bring your own screenshots)

The MVP has internal converters for PropertyScope and TracePilot capture output. Any conversion
or re-encoding happens **on the untrusted capture side**. The publisher only accepts §5's PNG
profile; it never installs an image library or runs project scripts.

A converter:

- emits a complete per-part catalog with an explicit state for every unit (§4);
- names each captured unit's image `<viewId>.<variantId>.png` (the provider is the part's own;
  IDs never contain a dot, so the name is unambiguous), and includes no other files;
- converts each capture setting (viewport, device scale, theme) as its own variant. Nothing
  assumes one viewport width;
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
  Display labels are separate bounded text. IDs never contain a dot, so `<viewId>.<variantId>`
  is an unambiguous file name.
- **SHA-256 strings:** 64 lowercase hex. Git commit OIDs are validated as Git OIDs, not as content
  hashes.
- **GitHub numeric IDs:** nonzero decimal **strings**. Compare numerically, never lexically or as
  floats.
- **Run key:** `<sourceRunId>-a<sourceAttempt>`. A publisher retry is not a new attempt. Imported
  history uses `import-<sha256>`.
- **Canonical JSON for hashing:** UTF-8, keys sorted recursively, no whitespace, finite integers
  only, arrays in order, no Unicode normalization of values. Tests pin the exact bytes and hashes.
  Only the generation ID (03 §3) and import run keys hash canonical JSON.
- **Pixel hash:**

  ```text
  pixelHash = SHA256( UTF8("pixelwatch:rgba8:v1\0") || U32BE(width) || U32BE(height) || rgba )
  ```

  `rgba` is row-major, top-to-bottom, tightly packed, **unpremultiplied RGBA8**. RGB input gets
  alpha 255. Set RGB to 0 **only where alpha = 0**. No premultiplication, no colour transforms.
  Fixed test vectors must cover: dimension byte order, hidden RGB under alpha 0, alpha 1 and 254,
  RGB vs RGBA equivalence, and different dimensions with the same byte count. Changing
  normalization later needs a new domain string (`v2`) and a migration.
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
| Entry names | Exactly `bundle.json` and `<viewId>.<variantId>.png`, flat ASCII. No separators, drive prefixes, NUL or dot paths. No duplicates or case-fold collisions. |
| JSON | ≤ 1 MiB each, nesting ≤ 32, ≤ 2000 units total. Labels ≤ 256 code points / 1024 bytes. Errors ≤ 2048 bytes. No duplicate keys or non-integer numbers. |
| PNG size | ≤ 32 MiB encoded; each dimension 1–16383; ≤ 16,000,000 pixels; one decode/compare at a time within a 512 MiB worker budget. The budget is enforced by the decoder's own allocation bound (sized from the checked header) and verified by recorded peak RSS. Worker `resourceLimits` cap only the V8 heap; the worker adds isolation, a timeout and cancellation. |
| PNG profile | Signature; one IHDR; contiguous IDATs; one final IEND; valid CRCs; 8-bit RGB or RGBA; compression/filter method 0; non-interlaced; only IHDR, IDAT and IEND chunks (no PLTE, ancillary or unknown chunks); no trailing bytes |
| Inflation | Expected scanline byte count computed from checked dimensions and enforced during inflate. The only image-sized allocation is the output buffer the checked header sizes; extra data, truncation, bad filter bytes and overflow are rejected without ever writing past it. |
| Work | 10-minute hard timeout for source verification, downloads and image analysis per ingestion; cancellable per artifact and image. Excess work is refused, never published as a partial pass. Check cancellation before each new store CAS attempt; recover/report an already-sent push under the store's bounded recovery rules (ADR 0025). |

- Budget declared entry sizes, and hold inflation to exactly the declared size, so a lying header
  fails instead of expanding past it. Validate central/local header consistency and reject
  duplicates before extraction. The ZIP reader is part of the
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
api/v1/schemas/<kind>-1.json         # the release's JSON Schemas for the API documents
llms.txt                             # explains versions, trust, coverage; links the schemas
```

Each result carries the unit identity, one status, reasons, base/head image URLs (when present),
dimensions, diff measurements and optional region bounds. The document also carries source
(corroborated) vs claims (untrusted), comparator version, coverage and counts. Features not run
are absent with a capability flag, never empty arrays implying a pass. URLs are built from the
configured origin/prefix and IDs only.

ADR 0013 fixes the details: `changes.json` is a pure, canonical projection of one run and the
site location; "policy" is `comparator` (the version names the whole policy) plus
`capabilities`; `parts` carries the part diagnostics (§6 step 6); `source.baseBranchSha` is
exposed for pull requests; `latest.json` names the PR stream's latest run in history order.

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
event, original run-created timestamp, optional independently corroborated workflow ref/SHA,
resolved PR association (or none),
corroborated base/head commits, config SHA, release SHA. It requires a completed run of the
configured workflow and an allowed event. `workflow_run` payload data must match the REST
response; a mismatch fails safely.

- **Commits** (run@1 `source.commits`, 01 §4.3). Each SHA has its own field, and no field is ever
  filled in from another one or from a claim:
  - `head`: the target;
  - `base`: the selected baseline;
  - `baseBranch`: the event's base-branch commit (ADR 0007), pull requests only.
  The workflow SHA is optional `workflowSha`; unavailable workflow provenance is omitted with
  a summary diagnostic, never filled from another SHA or claim (ADR 0016). With no `base`, every base side is `none`, and no base part
  is expected (ADR 0011).
- **Stream** (ADR 0011). Only the envelope decides a run's stream:
  - `push` joins `main`;
  - `pull_request` with a corroborated association joins `pr-<number>`;
  - every other run (no association, an ambiguous one, or `workflow_dispatch`) is stored and in
    history but joins no stream, so no comment ever shows it.

- **Idempotency is by run key.** A run key already in `store.json` is a no-op: the stored run is
  returned unchanged and never overwritten, whatever publisher release or config the retry has.
  A completed attempt's artifacts can't change, so the key identifies the input; there is no
  content digest to compare (ADR 0010). Reanalysis is a separate explicit operation.
- **History order:** original `runs/{id}.created_at`, then numeric run ID, then numeric attempt (ADR 0016). Publisher
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
  For selected expected parts they refuse the whole ingestion before sibling image admission;
  name-excluded artifacts remain unopened (ADR 0016).

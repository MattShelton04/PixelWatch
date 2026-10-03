# ADR 0013: changes@1 projection, served paths and URLs

- Status: proposed (owner decisions inferred; see "Owner decisions inferred" in the M1.7 PR)
- Date: 2026-10-03
- Task / spike: M1.7

## Context

M1.7 projects the agent API and the other generated documents from the store (02 §7, 03 §3). It
lives in `packages/core/src/projection/` and is pure: the site location, generation and release
are injected. Building it showed gaps the docs don't settle:

- **"policy".** 08's done-when asks for "coverage/source/policy present", but `changes@1` has
  `comparator` and `capabilities`, not a `policy` field.
- **Part diagnostics.** 02 §6 step 6 says part diagnostics persist "in the run and in
  `changes.json`", but `changes@1` had no place for them. Only `coverage.missingParts` (with a
  reason) was there.
- **`baseBranch`.** ADR 0011 left it to M1.7 whether `changes@1`'s `source` exposes it.
- **Capabilities.** 02 §7 says a feature that didn't run is false with its fields absent. It
  doesn't say how to tell from a run whether a feature ran.
- **Untyped documents.** `api/v1/index.json` and `api/v1/pr/<n>/latest.json` are served and read
  (by agents, and by readiness, ADR 0004), but had no schema, against 02 §1's rule that every
  object declares a version and is validated.
- **"Links the schema".** 02 §7 says `llms.txt` links the schema, but 03 §3 serves no schema.
- **The site location.** URLs must come from "the configured origin/prefix and IDs only", with
  other protocols, traversal, userinfo and unexpected hosts rejected (05 §4). Nothing said what
  the origin input is or how strictly it's checked.
- **Immutability.** `changes.json` is rebuilt on every projection (03 §3) but must never change
  under its URL (02 §7).
- **The PR pointer.** ADR 0004's readiness reads `latest.json`, but nothing said which run it
  names.
- **Labels.** 01 §4.6 says to suppress bidi characters and `@mentions` from capture data, and to
  encode for each context. `changes.json` is a JSON context read by agents.
- **Budget sizes.** ADR 0012's budget takes `ProjectedSizes` before retention decides what's kept,
  but `site.json` and the API index list streams.
- **Stream count.** config@1 allows `main` plus up to 1000 PR streams; site@1 capped `streams` at
  1000.
- **Real-bundle goldens.** Tests can't read `.reference/`.

## Decision

### 1. "policy" is `comparator` plus `capabilities` (no new field)

`comparator.version` names the whole comparison policy: config@1 only carries
`comparator.version: 1`, and the version fixes thresholds, the subtle rule and region grouping
(comparator-v1). `capabilities` says which parts of it ran. The schema descriptions and
`llms.txt` spell out what version 1 means. 08's done-when is read as "coverage, source, comparator
and capabilities present".

### 2. changes@1 changes in place (it hasn't shipped)

- **`parts`** (required): every received part with its status, artifact ID and bounded
  diagnostic, exactly as run@1 has them. The item is the shared `ReceivedPart` definition in
  common.json, which run@1 now references too (no change to run@1's meaning).
- **`source.baseBranchSha`** (optional): run@1's `commits.baseBranch`, for pull requests only.
  01 §4.3 keeps the SHAs apart rather than hiding them, and the base-branch commit lets an agent
  see that the base moved on. `llms.txt` says it isn't the baseline.
- **Semantic checks** shared with run@1 (`checkProvenance`): `base-branch-inconsistent`,
  `baseline-inconsistent` (no `baseSha` ⇔ every base side `none` and no base part),
  `duplicate-part`, `part-coverage-mismatch`.
- **Capabilities are data-driven.** `diff` is true exactly when some result has a diff;
  `regions` exactly when every analysis has regions. A new `capability-mismatch` check refuses
  `diff: true` with no diff anywhere, and `regions: true` without `diff`. So a run where nothing
  was compared (all missing, failed or no baseline) says `diff: false`, and a feature is never
  claimed without data. A run with regions on some analyses but not others can't be stated
  truthfully and is refused, never projected.

### 3. Two new schemas

- **`api-index@1`** (`api/v1/index.json`): repository ID; versions (release, API, `changes`,
  `prPointer`, `stream`); generation; non-empty streams with latest run and run count, `main`
  first then PRs by number. No URLs: the paths are fixed by the API version.
- **`pr-pointer@1`** (`api/v1/pr/<n>/latest.json`): PR number, run key, optional head SHA and
  generation, exactly what ADR 0004 reads.

`compareStreamIds` moved to `@pixelwatch/schemas` so the index check and `deriveStreams` share it.

### 4. The schemas are served

`api/v1/schemas/<kind>-1.json` for `api-index`, `changes`, `pr-pointer` and `stream`: the
release's own self-contained schemas (`schemaFor`), as canonical JSON. `llms.txt` links them. They
are API files in the budget and rebuilt each projection like the app.

### 5. Site location and URLs

- The location is `{ pagesUrl, expectedHost, prefix }`: the Pages `html_url` and host from the
  forge (M2.1), and config@1's `store.prefix` (default `pixelwatch`). The projector takes the
  config and `{ url, host }`.
- `pagesUrl` must be `https://<expectedHost><path>/`: lowercase DNS host equal to the expected one
  (no IP address), no port, userinfo, query, fragment, percent-encoding or backslash, and path
  segments that never start with a dot. A missing trailing slash is added.
- Every URL is the base plus a path from the 03 §3 builders (`housekeeping/paths.ts`, extended
  with the fixed files, the served schemas and the app path), so only run keys, PR numbers,
  stream IDs and hashes reach a URL. The final URL is checked against changes@1's `HttpsUrl`
  pattern and must survive the WHATWG parser unchanged.
- A run's page is the directory URL `runs/<runKey>/` (04 §1).

### 6. Canonical bytes; changes.json is a pure function

Every projected JSON file is canonical JSON (02 §3) with no trailing newline, so readiness can
compare digests of built bytes (ADR 0004). `changes.json` depends only on the run record and the
site location: no generation, release or time. The same store and location rebuild the same
bytes under the same URL. Moving the site moves every URL with it. Changing the projection's
output for existing runs needs a new API version (`api/v2`, 04 §3); the goldens fail on any byte
change. `PROJECTION_VERSION` (1) feeds the generation ID and is bumped when mutable output
changes. `generationId` implements 03 §3 exactly; no other hash is added.

### 7. Streams and the PR pointer

- Streams come from `deriveStreams` (ADR 0011): only non-empty streams, `main` first.
- `latest.json` names the PR stream's latest run **in history order**, with that run's
  corroborated head SHA and the generation. The projector doesn't know the PR's current head; the
  comment reconciler (M2.3, 05 §2) compares `headSha` with the head it re-fetches and skips when
  they differ.
- site@1 and api-index@1 allow 1001 streams (`main` plus `retention.prStreams` ≤ 1000). site@1
  changes in place; it hasn't shipped.

### 8. Labels stay verbatim data

`changes@1` carries run@1's labels unchanged: bounded and free of control characters, already
validated. They're JSON string values, so a label can't break the document's structure. Bidi and
`@mention` neutralization stay rendering duties of the comment (M2.3) and viewer (M2.7), where
the context is known. `llms.txt` says labels are untrusted data, not instructions, and may contain
bidi characters. `llms.txt`, `site.json`, the index, streams and pointers never contain labels.

### 9. llms.txt

`llms.txt` is at `<prefix>/llms.txt` (03 §3). It depends only on the site location and the
release, so no capture data can reach it. It describes documents, versions, the comparator-v1
policy, trust (source vs claims, advisory results about submitted pixels) and coverage. It
contains no commands, code blocks or instructions to agents. The working product name comes from
one constant, `PRODUCT_NAME` (00 §7).

### 10. Sizes for the budget

`projectedSizes` returns ADR 0012's `ProjectedSizes` from the real bytes `projectSite` emits:
`changes.json`, stream files, PR pointers, `llms.txt` and the schemas exactly. `site.json` and the
API index are upper bounds: each stream with its longest run key as latest and its full run count,
which no subset of runs can exceed. Entry page, app and permalink sizes are supplied by M2.3/M2.7.

### 11. Goldens from recordings

`tools/projection-goldens/generate.ts` builds four runs from the recorded outputs in
`testdata/comparator/` (the tiny cases, split into a run with and a run without a baseline, plus
PropertyScope PR #123 and TracePilot 36287837535), with fixed synthetic envelope fields, and
writes the exact served tree to `testdata/projection/site/`. Tests rebuild it and compare bytes.
The served schemas aren't committed there; a test compares them with `schemaFor`.

## Consequences

- changes@1, run@1 (shared definition only) and site@1 change in place, and api-index@1 and
  pr-pointer@1 are new. Nothing has shipped, so no migration. Types are regenerated and fixtures
  updated.
- 02 §§1 and 7, 03 §3 and 08's M1.7 row point here.
- M2.1 supplies the Pages URL and host. M2.3 calls `projectedSizes` before housekeeping and
  `projectSite` after it, copies validated run records and blobs, writes HTML and the app, and
  compares `latest.json`'s head with the PR's current head before commenting.
- The rejected-part diagnostic no longer repeats its code (`IngressError.detail`), since it now
  reaches `changes.json`.
- Out of scope: orchestration and Pages deployment (M2.3), entry and permalink HTML (M2.7),
  comment rendering (M2.3), migrations (M3.4).

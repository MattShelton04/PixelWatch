# Threat model (M0.4)

This file maps every rule of the normative security model
([01 §4](../design/01-architecture-and-security.md#4-security-model-normative)) to a trust boundary,
the threat it stops, and the named test or manual evidence that proves it (07 §6). It never
weakens 01 §4. If this file and 01 disagree, 01 wins and this file is fixed in the same PR.

Status on 2026-10-03 (main @ `1b8b3fb` plus M1.8): `packages/schemas`, the pixel hash, the
restricted PNG codec, the canonical blob pool, comparator-v1, bounded ZIP ingestion, the
fixed-part merge, trusted config parsing, runs and the store run index, retention, GC and
budget planning, the `changes@1` projection with its served paths and URLs, and the internal
`pixelwatch-dev compare` (M1.8, ADR 0014) are implemented. Most checks below are therefore **planned**. A planned check is never counted as
green. M0.5 recorded live evidence for S2, S4 and same-repo S11 (ADRs 0005–0007). Fork identity
stays `evidence-planned` with M2.6 (owner decision, 2026-09-30).

`tools/threat-model.test.ts` keeps this file honest. It runs in `pnpm check` and fails when:

- a rule has no check;
- a boundary has no rule;
- a `passing` row points at a file or test title that doesn't exist;
- a planned row has no owning task.

## 1. Status vocabulary

| Status | Meaning |
|---|---|
| `passing` | The test exists and runs in `pnpm check`. It may cover only part of the rule; the invariant column says which part. |
| `planned` | Not written yet. The owner task writes it at the path given, or moves it and updates this row in the same PR. |
| `recorded` | Manual evidence exists at the path given. |
| `evidence-planned` | Manual evidence the owner task or spike must record (usually under `docs/evidence/`, 07 §7). |

When a task lands a planned test, it flips the row to `passing` in the same PR, with the real
path and test title. Trusted-path PRs name the rule IDs they touch (08 §10).

## 2. Assets and actors

**Assets:**

- the store branch `pixelwatch-data`;
- the served Pages site and its shared origin `owner.github.io`;
- the sticky PR comment;
- the report job's write-capable `GITHUB_TOKEN` and Pages OIDC token;
- the pinned release code;
- adopter config;
- the adopter's default branch and other refs, which `contents: write` could reach.

**Actors:**

| Actor | Trust |
|---|---|
| PR author (same-repo or fork) and everything their PR runs | Hostile. Controls capture code, harness, artifacts, labels and claims. |
| Other workflows in the adopter repo | Outside PixelWatch's control. They can post as the same `github-actions[bot]`. |
| Repository administrator | Trusted, but can weaken their own capture workflow (R4.1-04). |
| GitHub platform (API, Actions, Pages, Camo) | Trusted for identity; fallible for timing, caching and outcomes. |
| CDN, browser and Camo caches | Can serve stale bytes or cached 404s. |
| Site visitor / external agent | Reads public data. Other sites on the same origin may be hostile. |

## 3. Trust boundaries

| ID | Boundary | What crosses it |
|---|---|---|
| TB1 | PR code → capture job | Untrusted code runs with a read-only token and no secrets |
| TB2 | Capture artifacts → ingest job | ZIPs, `bundle.json` and PNGs: untrusted data |
| TB3 | GitHub API → ingest job | The source envelope: run, attempt, workflow, event, PR association, commits |
| TB4 | Default-branch config → publisher | Trusted policy, parsed as bounded data |
| TB5 | Release self-checkout → publisher | The code that holds the write tokens |
| TB6 | Store branch ↔ publisher (Git) | Store objects read back as data; CAS writes |
| TB7 | Concurrent ingestors ↔ store tip | Racing CAS pushes |
| TB8 | Projectors ↔ deploy/readiness/comment | Racing projections, deployments and comment writes |
| TB9 | Publisher → Pages served tree | Generated HTML/JSON plus validated PNGs on a shared origin |
| TB10 | Publisher → PR comment | Markdown built from untrusted labels, posted under a bot identity |
| TB11 | Served data → viewer/browser | JSON and PNGs rendered by the pinned app; origin-shared storage |
| TB12 | CDN/Camo caches → readiness | Possibly stale generations, 404s and images |
| TB13 | Toolchain and parsers (TCB) | Node, Git, zlib, the ZIP/JSON/schema parsers, and build tools |
| TB14 | Repository settings | Settings the code can't enforce (M0.2) |

## 4. Rules

IDs are `R<01 section>-<n>`. Rules marked ADR 0004 are the owner's 2026-09-30 decisions that
close gaps between 03 §7, 05 §2 and the frozen `site@1`.

<!-- rules:begin -->
| ID | Rule | Boundary | Threat | Control |
|---|---|---|---|---|
| R4.1-01 | Capture runs PR code only on `pull_request`/`push` with `contents: read`, no secrets, no environments, no `pull_request_target`, hosted runners only | TB1, TB14 | Elevation: PR code gains write tokens | Capture template; config refuses `pull_request_target` as a source event; fork approval setting |
| R4.1-02 | Capture doesn't persist checkout credentials | TB1 | Disclosure of the read token to later steps or artifacts | `persist-credentials: false` in the template |
| R4.1-03 | Capture never receives publishing credentials via caches, artifacts, outputs, logs or fixtures | TB1, TB5 | Elevation through a default-branch cache or artifact that the PR can read | Report job writes no caches or artifacts for capture; test credentials never reach PR events |
| R4.1-04 | An admin can weaken their own capture workflow; docs say so and claim no guarantee | TB1, TB14 | Repudiation: false assurance | Template header and adopter docs |
| R4.2-01 | Publisher runs on `workflow_run` from the default branch at a full-SHA-pinned release | TB5, TB14 | Tampering: a moving ref swaps publisher code | SHA pins, repo-level SHA-pin requirement, zizmor `hash-pin` |
| R4.2-02 | Publisher never checks out a PR tree, runs a project script or artifact binary, installs adopter dependencies, evaluates a recipe, or restores a PR-writable cache | TB2, TB5 | Elevation: PR code runs with write tokens | `report.yml` has no such steps; lint and live hostile PR |
| R4.2-03 | Publisher loads its own bundle from `job.workflow_repository`/`job.workflow_sha`; missing fields fail; never a branch, a moving tag, or the caller's `github.sha`/`github.repository` | TB5 | Tampering: caller code runs as the publisher | Self-checkout (06 §3), spike S4 |
| R4.2-04 | Config is read at one recorded default-branch commit. The projector reads it at the default-branch head resolved after taking the lock and records it in the generation (ADR 0004). | TB4, TB8 | Tampering: PR-supplied or stale policy | Config commit recorded in run and generation |
| R4.2-05 | Unknown policy, schema or data versions fail before any store write, deployment or comment | TB4, TB6 | Tampering/DoS: misread data rewrites history | Version check before anything else; refusal before mutation |
| R4.2-06 | Per-job permissions: ingest `actions: read, contents: write, pull-requests: read`; project `contents: read, pages: write, id-token: write, pull-requests: write` | TB5, TB14 | Elevation: blast radius of a compromised step | Per-job `permissions` in `report.yml`; top-level `permissions: {}` |
| R4.2-07 | Deploy and comment run in one job under one per-site concurrency group, `cancel-in-progress: false`; the group name is stable across releases | TB8 | Tampering: read-check-write race between deploy and comment | One project job; one group |
| R4.2-08 | The TCB is pinned, advisory-tracked and tested with bounded hostile input | TB13 | Tampering via dependency or parser bug | Lockfile, pinned tool digests, Dependabot, CodeQL, dependency review, hostile corpora |
| R4.3-01 | The envelope is corroborated through the API: numeric repository ID, configured workflow **ID**, run ID + attempt, allowed event/ref, PR/commit association. `workflow_run` payload must match REST. | TB3 | Spoofing: a look-alike workflow or forged run | Forge verification; config stores workflow IDs, not names |
| R4.3-02 | Artifact claims (PR number, URL, SHA, environment, plan hash) never choose a write target, token destination, ref, PR or storage path | TB2, TB6, TB10 | Tampering: capture redirects writes or comments | Targets come from the envelope; `captureClaimsTrusted: false` |
| R4.3-03 | Source workflow SHA, PR head SHA, base-branch SHA, selected baseline SHA and captured-target claim are kept separate | TB3 | Spoofing: merge ref or default-branch SHA mistaken for the PR head | Separate envelope fields; S11 recordings |
| R4.3-04 | Ambiguous association (none or several PRs) → unassociated run with a diagnostic, no comment; never the first PR | TB3, TB10 | Tampering: a comment on the wrong PR | Association states in `run@1`; forge tests |
| R4.3-05 | Download only by API-returned artifact ID, HTTPS only, with capped redirects, time and bytes | TB2, TB3 | DoS/tampering via redirects or oversized downloads | Forge download client |
| R4.3-06 | `Authorization` is stripped on every cross-origin redirect (`redirect: "manual"`) | TB3 | Disclosure: the token is sent to the blob host | Manual redirect handling |
| R4.3-07 | Tokens and signed URLs are never logged | TB3, TB13 | Disclosure in public logs | Redacting logger; log assertions |
| R4.3-08 | Archives, JSON and PNGs are validated before and during allocation (02 §5) | TB2, TB4, TB13 | DoS: bombs, overflow, duplicate keys; tampering: prototype pollution | Strict JSON parser, bounded ZIP, bounded PNG decoder |
| R4.3-09 | Accepted pixels are re-encoded to canonical PNG; the raw artifact file is never served | TB2, TB9 | Tampering: polyglot or metadata-carrying files | Own encoder; blob named by pixel hash |
| R4.3-10 | Never publish HTML, SVG, JS, CSS, XML, source maps, HARs, traces or attachments from capture | TB2, TB9 | Tampering: active content on the shared origin | Entry-name allowlist; served-tree allowlist |
| R4.3-11 | Diffs and hashes are authoritative only about submitted pixels; reports are advisory, with no mandatory gate | TB2 | Repudiation: over-trusted results | `captureClaimsTrusted: false`; docs and `llms.txt` wording |
| R4.3-12 | Missing, failed or omitted work is never `unchanged`: side states decide first (02 §4), and pixel thresholds only judge two captured sides (02 §9) | TB2 | Tampering: an omitted or failed capture shown as a pass | Side-state precedence before any comparison; a comparison is refused for any other unit; the policy's first threshold must be 0 |
| R4.4-01 | PR run: target = PR head commit, baseline = merge base with the event's base-branch commit | TB3 | Spoofing: the wrong baseline hides a change | Envelope-derived source policy |
| R4.4-02 | Default-branch push: target = pushed commit, baseline = first parent | TB3 | Same | Same |
| R4.4-03 | Initial commit has no baseline → `incomparable` | TB2 | Tampering: a missing baseline shown as a pass | Base side `none` + `no-baseline` |
| R4.4-04 | Never silently substitute "latest main snapshot" for the baseline | TB3, TB6 | Tampering: the wrong baseline | Baseline chosen only from the envelope |
| R4.4-05 | The same head harness captures base and head; this is a technique, not proof | TB1 | Repudiation: over-trusted results | Documented limitation |
| R4.4-06 | A PR whose base can't be corroborated → unassociated with a diagnostic; a stale identifiable run may enter history but never replaces the current head's comment | TB3, TB8, TB10 | Tampering: an old result shown as current | Head check before every comment write |
| R4.4-07 | Live same-repo/fork/synchronize/rerun identities are recorded (S11) before M2 exits | TB3 | Spoofing: the design misreads real payloads | Spike S11 evidence |
| R4.5-01 | Only the configured, marked data branch is writable. Refuse the default branch, unmarked branches, foreign repository markers and any other ref. | TB6, TB14 | Tampering: `contents: write` isn't ref-scoped, so a bug could push elsewhere | Store adapter refusal; branch protection on the default branch |
| R4.5-02 | Git objects are read as data (`cat-file`/`ls-tree`) with hooks, filters and submodules disabled and a sanitized environment; tree content never runs | TB6, TB13 | Elevation via hostile tree content or Git config | Sanitized isolated Git dir |
| R4.5-03 | Store writes are CAS with an explicit expected-SHA lease: no blind force, no rebase, no global Actions concurrency group for ingestion | TB7 | Tampering/DoS: lost or dropped runs | `--force-with-lease=<ref>:<sha>`; bounded recompute-retry |
| R4.5-04 | An uncertain push outcome is resolved by refetching and looking for the run key. A run key already stored is a no-op: the stored run is never overwritten. | TB6, TB7 | Tampering: duplicate or overwritten runs | Idempotency (02 §8) |
| R4.5-05 | The served tree is built only from allowlisted validated data plus the pinned release's app; store files are never copied as active files; app hashes in the store are never trusted | TB6, TB9 | Tampering: stored-XSS through the store | Fresh build directory; `site@1` has no code URLs or hashes |
| R4.5-06 | Projection → deploy → readiness → comment reconciliation is serialized, and the store is read after taking the lock | TB8 | Tampering: a stale generation or comment | Project job order (§6) |
| R4.5-07 | Readiness: served `site.json` has the expected `generation`; each PR to be commented has `api/v1/pr/<n>/latest.json` naming the expected run key and generation; each fetched body's SHA-256 equals the built bytes. The whole check passes on 3 consecutive polls ≥ 10 s apart. HTTP 200 alone isn't readiness (ADRs 0004, 0005). | TB8, TB12 | Tampering: a comment links to content not yet served | Bounded readiness poll |
| R4.5-08 | "Stale generation" means an older store tip, which is never deployed. A reordered older release may deploy once. It can't lose data or roll back a comment, and `site.json` shows its release (ADR 0004). | TB8 | Tampering: a downgrade window | Store read after lock; residual risk §7 |
| R4.6-01 | No tokens, credentials, approvals or private data in viewer storage; stored preferences are validated on every read | TB11 | Disclosure/tampering across the shared origin | Viewer storage rules (04 §4) |
| R4.6-02 | Viewer uses a hash CSP + SRI on pinned app bytes, no service worker, no dynamic script loading | TB9, TB11 | Tampering: script injection or app swapping | Generated entry pages |
| R4.6-03 | Meta CSP can't set `frame-ancestors`; framing is not prevented | TB11 | Tampering: clickjacking | Documented residual (§7); no action in the viewer needs a click to be safe |
| R4.6-04 | Untrusted values are encoded for their exact context; the DOM is built with text nodes; no `innerHTML` with data | TB10, TB11 | Tampering: XSS or Markdown injection | ESLint sink ban; context encoders |
| R4.6-05 | Links use validated destinations (HTTPS, configured origin/prefix, no traversal or userinfo) and `noopener` | TB9, TB10, TB11 | Tampering: `javascript:` or off-site links | URL builders; `changes@1` URL pattern |
| R4.6-06 | Control/bidi characters and `@mentions` from capture data are suppressed | TB10, TB11 | Spoofing: text reordering or unwanted pings | Label bounding and sanitizing |
| R4.6-07 | Only a comment with the exact marker **and** the publishing bot's numeric author ID is edited; required warnings are never dropped | TB10 | Tampering: editing a human's comment; hiding warnings | Marker + author check; size budget reserves warnings |
| R4.6-08 | More than one comment matching marker + author → edit none and record a diagnostic (ADR 0004) | TB10 | Spoofing: another bot workflow seeds a marker | Ambiguity refusal |
| R4.6-09 | A stale run never replaces a newer head's report | TB8, TB10 | Tampering: comment rollback | Head re-fetch immediately before writing |
| R4.6-10 | Instructions in labels, screenshots, findings or `changes.json` are never followed | TB2, TB10 | Tampering: prompt injection of agents or tooling | No instruction fields; `llms.txt` explains, never instructs |
| R4.7-01 | Everything published is public and copyable; Camo is a proxy, not confidentiality; adopters use synthetic data and masks | TB9 | Disclosure | Adopter docs |
| R4.7-02 | No raw DOM, traces, auth state or failed-capture logs are published by default; diagnostics are opt-in, redacted, bounded, and not Pages data | TB2, TB9 | Disclosure | Bounded error categories; served-tree allowlist |
| R4.7-03 | Deleting a branch tip or backup isn't secure erasure | TB6, TB9 | Disclosure: false assurance of deletion | Documented limitation |
| R4.7-04 | A deploy timeout is reported as "stored, deployment pending", never "published"; summaries record store commit, deployment outcome and repair steps, without secrets | TB8, TB12 | Repudiation: misleading status | Separate stored/deployed/served/commented statuses |
<!-- rules:end -->

## 5. Verification

"Where" is a repo path. For a `passing` row with a title, the title is the exact `it(...)` text in
that file. Fixture paths under `testdata/schemas/*/invalid/` are run by
`packages/schemas/test/schemas.test.ts` (each fixture must fail with the code in its name).
Planned paths are provisional (§1).

<!-- verification:begin -->
| Rule | Layer | Status | Where | Invariant | Owner |
|---|---|---|---|---|---|
| R4.1-01 | lint | passing | `tools/lint-workflows.test.ts` › "grants only contents: read at the top level and nowhere else" | The capture template has exactly one `permissions:` block, `contents: read`, and no `write` anywhere | M0.2 |
| R4.1-01 | lint | passing | `tools/lint-workflows.test.ts` › "uses no secrets, environments or pull_request_target" | The capture template references no secrets or environments and never uses `pull_request_target` | M0.2 |
| R4.1-01 | unit | passing | `testdata/schemas/config/invalid/schema.event-pull-request-target.json` | `config@1` refuses `pull_request_target` as an allowed source event | M0.3 |
| R4.1-01 | evidence | recorded | `docs/security/repo-settings.md` | Rows 10–12: fork PR approval for all external contributors, read-only default token, Actions can't approve PRs (this repo) | M0.2 |
| R4.1-01 | live | planned | `tools/live/scenarios/pr-fork.ts` | A real fork PR's capture run has `contents: read`, no secrets, and the trusted report still publishes | M2.6 |
| R4.1-02 | lint | passing | `tools/lint-workflows.test.ts` › "never persists checkout credentials" | Every checkout in the capture template sets `persist-credentials: false` | M0.2 |
| R4.1-03 | unit | passing | `tools/live.test.ts` › "refuses every pull_request event, even with all settings" | Live test credentials are refused on any `pull_request*` event | M0.1 |
| R4.1-03 | lint | planned | `tools/lint-workflows.test.ts` › report workflow block | `report.yml` has no `actions/cache`, no cache-enabled setup action, and no `upload-artifact` except the Pages artifact; self-checkout has `persist-credentials: false` | M2.5 |
| R4.1-03 | live | planned | `tools/live/scenarios/pr-fork-hostile.ts` | A hostile fork PR that dumps env, caches and artifacts finds no publishing credential | M2.6 |
| R4.1-04 | evidence | recorded | `docs/templates/pixelwatch-capture.yml` | The template header says PixelWatch can't enforce capture settings and that weakening them voids fork safety | M0.2 |
| R4.1-04 | evidence | evidence-planned | `docs/evidence/quickstart.md` | Adopter docs state the admin-weakening limitation; checked in the clean-repo quickstart | M3.8 |
| R4.2-01 | lint | passing | `zizmor.yml` | `pnpm lint:workflows` enforces the `hash-pin` policy for every `uses:` in this repo's workflows and templates | M0.1 |
| R4.2-01 | lint | passing | `tools/lint-workflows.test.ts` › "zizmor flags the insecure fixture offline" | zizmor reports `unpinned-uses`, `dangerous-triggers`, `artipacked`, `template-injection` and `excessive-permissions` on the insecure fixture | M0.1 |
| R4.2-01 | evidence | recorded | `docs/security/repo-settings.md` | Row 8: the repository requires full-length SHA pins; rows 2–3: protected `main` and version tags | M0.2 |
| R4.2-01 | evidence | recorded | `docs/adr/0007-s11-same-repo-identity.md` | Same-repo: every `workflow_run` report job ran at `refs/heads/main` and the default-branch tip, never at the PR head or merge ref (8 report runs) | S11 |
| R4.2-01 | lint | planned | `tools/lint-workflows.test.ts` › report workflow block | The adopter report template triggers only on `workflow_run` (+ `workflow_dispatch`), calls `report.yml@<40-hex>` with no `secrets: inherit` | M2.5 |
| R4.2-02 | lint | planned | `tools/lint-workflows.test.ts` › report workflow block | `report.yml` checks out only `job.workflow_repository`@`job.workflow_sha`, never `workflow_run.head_sha`/`head_branch`, and has no `run:` step executing adopter files | M2.5 |
| R4.2-02 | live | planned | `tools/live/scenarios/pr-fork-hostile.ts` | A fork PR adding scripts, a `package.json` and a poisoned cache sees none of them executed by the report | M2.6 |
| R4.2-03 | evidence | recorded | `docs/adr/0006-s4-reusable-workflow-self-checkout.md` | A foreign SHA-pinned caller, a nested call and an old pin after a newer release each ran their own bundle, not the caller's impostor; the guard failed on missing or non-SHA fields; recorded with run IDs | S4 |
| R4.2-03 | live | planned | `tools/release/self-reference.test.ts` | A foreign SHA-pinned caller, a nested call, and an older release after a newer one each run their own bundle; missing job fields fail | M2.5 |
| R4.2-04 | unit | planned | `packages/forge-github/test/run-verification.test.ts` | The envelope's `configSha` is the default-branch commit the forge resolved; no artifact or claim field supplies it | M2.1 |
| R4.2-04 | unit | planned | `packages/publisher/test/ingest-job.test.ts` | The ingest job validates config at that commit and records it in the run; a config file inside an artifact is ignored | M2.3 |
| R4.2-04 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | Sub-case D: the projector reads config at the default-branch head resolved after the lock, and the generation hash includes that commit | M2.3 |
| R4.2-05 | unit | passing | `packages/schemas/test/schemas.test.ts` › "reports an unknown version before looking at anything else" | Every document kind reports `unsupported-version` before any other check | M0.3 |
| R4.2-05 | unit | passing | `testdata/schemas/store/invalid/schema.data-version-2.json` | A store with `dataVersion` 2 is rejected | M0.3 |
| R4.2-05 | unit | passing | `testdata/schemas/config/invalid/schema.comparator-version-2.json` | An unknown comparator version in config is rejected | M0.3 |
| R4.2-05 | unit | passing | `packages/core/test/comparator.test.ts` › "refuses an unknown comparator version" | The core maps only comparator version 1 to a policy; any other version throws | M1.3 |
| R4.2-05 | simulation | planned | `packages/publisher/test/simulation/sim-unknown-version.sim.test.ts` | Unknown config/bundle/store version → zero store pushes, zero deployments, zero comment writes | M2.3 |
| R4.2-06 | lint | planned | `tools/lint-workflows.test.ts` › report workflow block | Top-level `permissions: {}`; the ingest and project jobs have exactly the 01 §4.2 sets | M2.5 |
| R4.2-06 | evidence | recorded | `docs/evidence/s4-self-reference.md` | Inside a foreign-called reusable workflow, each called job's logged `GITHUB_TOKEN` permissions were exactly its own 01 §4.2 set, not the caller's union | S4 |
| R4.2-06 | evidence | evidence-planned | `docs/evidence/` (M2.6 live run) | Token permissions observed in a real report run match 01 §4.2 per job | M2.6 |
| R4.2-07 | lint | planned | `tools/lint-workflows.test.ts` › report workflow block | Exactly one job both deploys Pages and writes comments; it has the fixed per-site group, `cancel-in-progress: false`; the ingest job has no concurrency group | M2.5 |
| R4.2-08 | unit | passing | `tools/lib/lint-tools.test.ts` › "rejects any single-byte change or truncation" | Pinned lint tools are verified by SHA-256 before use | M0.1 |
| R4.2-08 | unit | passing | `packages/schemas/test/json.test.ts` › "enforces the size and depth limits" | The strict JSON parser refuses > 1 MiB or depth > 32 | M0.3 |
| R4.2-08 | evidence | recorded | `docs/security/repo-settings.md` | Rows 5–7: Dependabot alerts and security updates, CodeQL advanced setup, dependency review | M0.2 |
| R4.2-08 | unit | passing | `packages/core/test/png-decode.test.ts` › "rejects every hostile PNG with its code, allocating at most the header-sized output" | The hostile PNG corpus (`testdata/png/hostile/`) fails with its own code, allocating at most the output buffer its checked header sizes, each within a time bound | M1.1 |
| R4.2-08 | unit | passing | `packages/core/test/png-decode.test.ts` › "gives every PngSuite file its expected outcome" | The decoder is tested against the third-party PngSuite, including its corrupt `x*` files | M1.1 |
| R4.2-08 | evidence | recorded | `docs/evidence/m1.1-png-bench.md` | Peak RSS and time recorded for real, maximum-size and hostile inputs, within the 02 §5 512 MiB budget | M1.1 |
| R4.2-08 | evidence | recorded | `docs/evidence/m1.3-compare-bench.md` | Peak RSS and time recorded for decoding, hashing and comparing two 16 MP images (dense, fragmented, diagonal, height-change and in-worker cases), within the 02 §5 512 MiB budget | M1.3 |
| R4.2-08 | unit | passing | `packages/core/test/ingress-zip.test.ts` › "rejects every hostile ZIP with its code, allocating only capped declared-size entry buffers" | Every hostile ZIP case (`testdata/zip/hostile/`) fails with its expected code; at most capped declared-size entry buffers (≤ 32 MiB) are allocated, each case within a time bound | M1.4 |
| R4.2-08 | evidence | recorded | `docs/evidence/m1.4-ingest-bench.md` | Peak RSS and time recorded for 4096 entries / 495.3 MiB expanded, full ingestion of 2000 units in process and in a PngWorker, tall images and ZIP bombs; measured peak 195 MiB within the 02 §5 512 MiB budget | M1.4 |
| R4.3-01 | unit | passing | `testdata/schemas/config/invalid/schema.workflow-name-not-id.json` | Config identifies the source workflow by numeric ID, never by name | M0.3 |
| R4.3-01 | unit | planned | `packages/forge-github/test/run-verification.test.ts` | Wrong repository ID, wrong workflow ID, wrong attempt, disallowed event/ref, incomplete run or payload≠REST mismatch → refused before download | M2.1 |
| R4.3-01 | unit | planned | `packages/forge-github/test/run-verification.test.ts` | The envelope is assembled only from REST-corroborated fields, never from the `workflow_run` payload or an artifact; a payload that disagrees with REST fails safely | M2.1 |
| R4.3-01 | evidence | recorded | `docs/adr/0007-s11-same-repo-identity.md` | Same-repo: the `workflow_run` payload matched REST `runs/{id}` on ID, attempt, event, head SHA/branch, workflow ID, path and PR association in all 8 recordings | S11 |
| R4.3-02 | unit | passing | `testdata/schemas/changes/invalid/schema.claims-trusted.json` | `changes@1` can never mark capture claims as trusted | M0.3 |
| R4.3-02 | unit | passing | `packages/core/test/ingest.test.ts` › "rejects identity mismatches between name, bundle.json, attempt and config" | A part can't claim units of another provider: its bundle.json provider must match its artifact name | M1.4 |
| R4.3-02 | unit | passing | `packages/core/test/ingest.test.ts` › "rejects identity mismatches between name, bundle.json, attempt and config" | A `bundle.json` whose attempt, revision, provider or shard disagrees with its artifact name, the authenticated attempt or the config rejects its part | M1.4 |
| R4.3-02 | unit | passing | `packages/core/test/envelope.test.ts` › "takes the run key, stream, commits and PR number only from the envelope, even when claims disagree" | Claimed revision/harness SHAs and environment differing from the envelope change neither run key, `source`, stream nor the store index entry; they appear only under `claims`, and disagreeing parts drop the field (bundle@1 has no PR, URL or run-ID field; a forged attempt is rejected at ingest, M1.4) | M1.5 |
| R4.3-02 | unit | passing | `packages/core/test/changes-projection.test.ts` › "builds image URLs only for captured sides, from the site location and pixel hashes alone" | Claims and labels never choose a served path or URL: hostile URL- and path-like labels and disagreeing claims leave every image URL unchanged | M1.7 |
| R4.3-02 | live | planned | `tools/live/scenarios/pr-fork-hostile.ts` | A fork PR with forged PR/run/attempt claims is published under its real identity only | M2.6 |
| R4.3-03 | unit | passing | `packages/core/test/envelope.test.ts` › "keeps workflow, head, base-branch and baseline SHAs in their own fields" | `workflowSha`, `commits.head`, `commits.baseBranch`, `commits.base` and the captured-target claim are distinct fields; a missing one is never filled from another or from a claim (choosing the head over a merge ref is M2.1's forge test) | M1.5 |
| R4.3-03 | unit | passing | `packages/core/test/changes-projection.test.ts` › "exposes the base-branch commit separately from the baseline, for pull requests only" | `changes@1` keeps `headSha`, `baseSha` and `baseBranchSha` in their own fields, each from its own envelope field; `baseBranchSha` only for pull requests (`testdata/schemas/changes/invalid/base-branch-inconsistent.push-with-base-branch.json`) | M1.7 |
| R4.3-03 | evidence | recorded | `docs/adr/0007-s11-same-repo-identity.md` | Same-repo: capture `github.sha` is a merge ref; `workflow_run.head_sha` is the PR head; `base.sha` is neither the base tip nor the merge parent; the payload's `merge_commit_sha` can be the previous merge | S11 |
| R4.3-03 | evidence | evidence-planned | `docs/adr/` (fork identity) | Recorded fork payloads show which SHAs and head-repository IDs `pull_request` and `workflow_run` report | M2.6 |
| R4.3-04 | unit | passing | `testdata/schemas/run/invalid/association-inconsistent.ambiguous-with-pr.json` | An ambiguous association can't carry a PR number | M0.3 |
| R4.3-04 | unit | passing | `testdata/schemas/run/invalid/association-inconsistent.corroborated-without-pr.json` | A corroborated association must name its PR | M0.3 |
| R4.3-04 | unit | planned | `packages/forge-github/test/pr-association.test.ts` | Zero PRs, several PRs, or a head/merge SHA mismatch → unassociated with a diagnostic and no comment; never the first PR | M2.1 |
| R4.3-05 | unit | planned | `packages/forge-github/test/artifact-download.test.ts` | Only API-listed artifact IDs are fetched; non-HTTPS, > N redirects, over-time or over-size responses are aborted; all pages are listed | M2.1 |
| R4.3-05 | unit | passing | `packages/core/test/merge.test.ts` › "merges only expected names for the selected attempt and rejects duplicates and mixed attempts" | Only expected names for the selected attempt are merged; two artifacts under one name reject the part (none is picked); a bundle of another attempt under this attempt's name is rejected; other attempts, unexpected parts and other bundle versions are ignored with a reason | M1.4 |
| R4.3-05 | unit | passing | `packages/core/test/ingest.test.ts` › "never opens artifacts of another attempt" | Artifacts of other attempts are never opened: hostile archives under their names change nothing | M1.4 |
| R4.3-06 | unit | planned | `packages/forge-github/test/artifact-download.test.ts` | A cross-origin 302 is followed without `Authorization`; a same-origin one keeps it | M2.1 |
| R4.3-06 | simulation | planned | `packages/publisher/test/simulation/sim-github-faults.sim.test.ts` | Expired artifact, rate limit, cross-origin 302 and 410/5xx: bounded retries, auth stripped, incompleteness visible | M2.4 |
| R4.3-07 | simulation | planned | `packages/publisher/test/simulation/sim-github-faults.sim.test.ts` | Captured logs and job summaries of every scenario contain no token or signed-URL query string | M2.4 |
| R4.3-07 | unit | passing | `tools/dev-compare.test.ts` › "reads no environment variable and imports no network, process or Git module" | The dev CLI's sources never mention `process.env`, a token variable or `fetch`, and import no network, child-process or Git module | M1.8 |
| R4.3-07 | unit | passing | `tools/dev-compare.test.ts` › "gives identical bytes and exit code as a process behind the network guard, with or without GH_TOKEN" | As a process behind the network guard, the dev CLI's stdout, stderr and exit code are the same with and without `GH_TOKEN`/`GITHUB_TOKEN` set, and equal the in-process run | M1.8 |
| R4.3-08 | unit | passing | `packages/schemas/test/json.test.ts` › "rejects duplicate keys, including nested and escaped spellings" | Duplicate JSON keys fail at any depth | M0.3 |
| R4.3-08 | unit | passing | `packages/schemas/test/json.test.ts` › "rejects prototype-pollution keys anywhere" | `__proto__`, `constructor` and `prototype` keys fail | M0.3 |
| R4.3-08 | unit | passing | `packages/schemas/test/json.test.ts` › "rejects a BOM, invalid UTF-8 and lone surrogates" | Malformed text fails before parsing | M0.3 |
| R4.3-08 | unit | passing | `packages/core/test/pixel-hash.test.ts` › "rejects dimensions outside 1–16383 and more than 16,000,000 pixels" | Pixel buffers outside the 02 §5 bounds are refused | M0.6 |
| R4.3-08 | unit | passing | `packages/schemas/test/png-profile.test.ts` › "rejects everything outside the profile" | Partial: the chunk-profile check (converter side) rejects non-profile PNGs. It isn't the trusted decoder. | M0.3 |
| R4.3-08 | unit | passing | `packages/core/test/png-decode.test.ts` › "rejects every hostile PNG with its code, allocating at most the header-sized output" | Multiple IHDR/IEND, bad CRC or filter, inflate bombs, trailing data, overflow, disallowed colour types/bit depths/interlace and extra chunks fail; inflation never writes past the header-sized output | M1.1 |
| R4.3-08 | unit | passing | `packages/core/test/png-decode.test.ts` › "decodes real screenshots to the same RGBA as an independent decoder" | Decoded RGBA of the committed real PNGs equals fast-png's (test toolchain only); a seeded differential test covers every filter type | M1.1 |
| R4.3-08 | unit | passing | `packages/core/test/ingress-zip.test.ts` › "rejects every hostile ZIP with its code, allocating only capped declared-size entry buffers" | Central/local mismatch, duplicate or case-colliding names, links and special files, ZIP64, encryption, unsupported methods, descriptors, overlaps, gaps, trailing bytes and bombs (`testdata/zip/hostile/`) each fail with their own code; structural failures allocate nothing | M1.4 |
| R4.3-08 | unit | passing | `packages/core/test/ingress-zip.test.ts` › "budgets declared sizes and holds inflation to them" | A lying header can't hide expansion: the budget counts declared sizes, and extraction stops within one chunk of the declared size | M1.4 |
| R4.3-08 | unit | passing | `packages/core/test/ingress-zip.test.ts` › "shares the 4096-entry and 512 MiB budgets across every archive of one ingestion" | > 4096 entries or > 512 MiB of declared (and enforced) entry bytes across all archives of one ingestion refuse it | M1.4 |
| R4.3-08 | unit | passing | `packages/core/test/ingest.test.ts` › "rejects a part whose PNG fails the bounded decoder" | Every captured image passes the bounded decoder (in process and in the PngWorker); a failing one rejects its part | M1.4 |
| R4.3-08 | unit | passing | `packages/core/test/ingest.test.ts` › "takes dimensions from decoding, never from bundle.json" | Side dimensions come from decoding; the stored blob is the canonical re-encoding | M1.4 |
| R4.3-08 | unit | passing | `tools/dev-compare.test.ts` › "refuses hostile ZIP %s with a bounded error and exit 3" | Local path: every hostile ZIP (`testdata/zip/hostile/`) goes through the publisher's ingress, with no second parser, and exits 3 with the code the ingress reaches first and nothing on stdout | M1.8 |
| R4.3-08 | unit | passing | `tools/dev-compare.test.ts` › "refuses hostile PNG %s with a bounded error and exit 3" | Local path: every hostile PNG (`testdata/png/hostile/`) in a part is rejected by the bounded decoder with its own code, exit 3 | M1.8 |
| R4.3-08 | unit | passing | `tools/dev-compare.test.ts` › "enforces the 02 §5 size and count limits before reading any bytes" | Local path: an oversized PNG, `bundle.json`, archive or input total, and > 4096 entries, are refused from `lstat` sizes before any byte is read | M1.8 |
| R4.3-08 | unit | passing | `tools/dev-compare.test.ts` › "refuses symbolic links, junctions and hard links without following them" | Local input directories are hostile: a link or junction (root, part or file) or a hard-linked file is refused, never followed, so nothing outside the given roots is read | M1.8 |
| R4.3-09 | unit | passing | `packages/core/test/png-decode.test.ts` › "encodes output that fits the profile and round-trips the normalized pixels" | Encoded output fits the profile (checked by the independent converter-side `normalizePng`) and decodes to the normalized pixels | M1.1 |
| R4.3-09 | unit | passing | `packages/core/test/png-decode.test.ts` › "never echoes uploaded bytes that carry extra chunks" | Encoded output never equals the uploaded bytes when those carry extra chunks | M1.1 |
| R4.3-09 | unit | passing | `packages/core/test/blob-pool.test.ts` › "writes a new blob named by its pixel hash as canonical PNG" | A new blob is the publisher's own canonical encoding of the decoded pixels, named by their pixel hash | M1.2 |
| R4.3-09 | unit | passing | `packages/core/test/blob-pool.test.ts` › "reuses an existing blob without reading or overwriting it" | An existing blob is never overwritten (ADR 0010: it isn't re-decoded either) | M1.2 |
| R4.3-10 | unit | passing | `testdata/schemas/bundle/invalid/schema.captured-unit-names-a-file.json` | `bundle.json` can't name files at all: a captured unit's image is always `<viewId>.<variantId>.png` (ADR 0010) | M0.3 |
| R4.3-10 | unit | passing | `packages/core/test/ingress-zip.test.ts` › "rejects any entry name but bundle.json and <viewId>.<variantId>.png" | An archive containing anything but `bundle.json` and `<viewId>.<variantId>.png` (HTML, SVG, JS, CSS, XML, maps, HARs, traces, other names) is rejected before extraction | M1.4 |
| R4.3-10 | unit | passing | `packages/core/test/ingest.test.ts` › "rejects a part whose files and captured units differ" | The archive's PNGs must be exactly the captured units' files | M1.4 |
| R4.3-10 | unit | planned | `packages/publisher/test/site-tree.test.ts` | Every served path matches the 03 §3 allowlist and every served file type is HTML/JSON/JS/PNG/TXT generated or validated by the publisher | M2.3 |
| R4.3-10 | unit | passing | `tools/dev-compare.test.ts` › "refuses extra files, nested directories, parts on the wrong side and mixed attempts" | Local inputs hold only parts: extra files, HTML in a part, unlisted PNGs, nested directories, wrong-side, duplicate or lying parts and mixed attempts are refused, never skipped | M1.8 |
| R4.3-11 | golden | passing | `packages/core/test/changes-projection.test.ts` › "keeps corroborated source and untrusted claims apart, and llms.txt calls results advisory about submitted pixels" | `changes.json`'s `source` holds only envelope facts even when every claim disagrees; claims appear only under `claims` with `captureClaimsTrusted: false`; `llms.txt` says results are advisory and authoritative only about the submitted pixels | M1.7 |
| R4.3-11 | unit | passing | `tools/dev-compare.test.ts` › "says nothing is corroborated and keeps capture claims untrusted, never faking an envelope" | The local report has no envelope, run key or URL; it says `corroborated: false` and `captureClaimsTrusted: false`, and claims appear only under `claims` | M1.8 |
| R4.3-12 | unit | passing | `packages/core/test/comparator.test.ts` › "never turns a missing or failed side into unchanged, under any policy" | Every side pair with a missing or failed side is `missing`/`failed` with no diff under v1 and a maximally lenient policy, and even an `unchanged` comparison is refused for it | M1.3 |
| R4.3-12 | unit | passing | `packages/core/test/comparator.test.ts` › "refuses pixel results for a unit whose sides aren't both captured" | A pixel comparison is refused for every non-captured side pair, and two captured sides can't be decided without one | M1.3 |
| R4.3-12 | unit | passing | `packages/core/test/comparator.test.ts` › "refuses a policy that could hide a change or break run@1" | A policy whose first threshold isn't 0 (or that is otherwise malformed) is refused, so `unchanged` always means no channel moved | M1.3 |
| R4.3-12 | golden | passing | `packages/core/test/comparator-goldens.test.ts` › "reproduces tiny/expected.json exactly" | The core reproduces all 48 recorded tiny results, including every missing/failed precedence case | M1.3 |
| R4.3-12 | unit | passing | `packages/core/test/merge.test.ts` › "never reports omitted or failed work as unchanged" | Property: a side from a rejected, missing or conflicting part, or a unit missing from a catalog, is `missing`; a failed side is `failed`; identical pixels never help | M1.4 |
| R4.3-12 | unit | passing | `packages/core/test/merge.test.ts` › "marks a unit absent from one revision's catalogs as missing, never absent" | A unit one revision's complete catalogs omit is `missing/unit-missing`, never `removed` or `added` | M1.4 |
| R4.3-12 | unit | passing | `packages/core/test/merge.test.ts` › "reports missing parts with unknown unit counts, never zero" | A missing part's catalog size is unknown, never zero; coverage is incomplete or unknown | M1.4 |
| R4.3-12 | unit | passing | `packages/core/test/merge.test.ts` › "keeps the eight counts exhaustive and disjoint" | Property: every merged unit has exactly one of the eight results; counts sum to the declared units and coverage follows run@1's rule | M1.4 |
| R4.3-12 | golden | passing | `packages/core/test/changes-projection.test.ts` › "never turns missing, failed or incomparable into unchanged, and leaves features that didn't run false with no fields" | The projection never reclassifies: every status and side passes through from the run; a run with no comparison has `diff: false` and no diff fields; diffs without regions have `regions: false` and no region fields; partial regions and invalid runs are refused | M1.7 |
| R4.3-12 | unit | passing | `testdata/schemas/changes/invalid/capability-mismatch.diff-claimed-never-ran.json` | `changes@1` can't claim a feature that left no data | M1.7 |
| R4.3-12 | unit | passing | `packages/core/test/changes-projection.test.ts` › "keeps the eight counts summing to results.length and carries coverage and missing parts over unchanged" | Counts, coverage, missing parts and part diagnostics in `changes.json` equal the run's, including a rejected and a never-received part | M1.7 |
| R4.3-12 | unit | passing | `tools/dev-compare.test.ts` › "never exits 0 or 1 for a missing part, a failed side, a missing unit or an incomparable unit" | The dev CLI exits 2 (incomplete) for a missing part or shard, a failed or uncaptured side, a missing unit, no baseline, nothing to compare, or a configured provider neither input has | M1.8 |
| R4.3-12 | unit | passing | `tools/dev-compare.test.ts` › "never reports no-differences unless coverage is complete and every result is unchanged" | Property: exit 0 needs `complete-declared` coverage, no missing part, declared = accounted = results > 0, and every result `unchanged` | M1.8 |
| R4.3-12 | golden | passing | `tools/dev-compare.test.ts` › "reproduces tiny/expected.json exactly for every case an ingestion can produce" | Through the dev CLI, 46 of the 48 recorded tiny results are reproduced exactly; the other two list the unit on neither side, so no ingestion declares them (ADR 0014) | M1.8 |
| R4.4-01 | unit | planned | `packages/forge-github/test/baseline.test.ts` | PR run: target = PR head, baseline = merge base with the event's base-branch commit | M2.1 |
| R4.4-01 | evidence | recorded | `docs/adr/0007-s11-same-repo-identity.md` | Same-repo opened, synchronize (incl. a head that merged the base) and full rerun: merge base of the corroborated `base.sha` and the head equalled the capture's selected base | S11 |
| R4.4-01 | evidence | evidence-planned | `docs/adr/` (fork identity) | Fork PR payloads confirm the base/head policy or surface a decision | M2.6 |
| R4.4-02 | unit | planned | `packages/forge-github/test/baseline.test.ts` | Default-branch push: target = pushed commit, baseline = first parent | M2.1 |
| R4.4-03 | unit | passing | `testdata/schemas/run/invalid/result-inconsistent.no-baseline-without-reason.json` | A base side of `none` must carry `no-baseline` | M0.3 |
| R4.4-03 | golden | passing | `packages/core/test/comparator-goldens.test.ts` › "covers all eight results" | Tiny fixtures include `incomparable` from a missing baseline | M0.6 |
| R4.4-03 | unit | passing | `packages/core/test/comparator.test.ts` › "compares a none base never: incomparable with no-baseline whatever the head" | A `none` base always carries `no-baseline`, is `incomparable` against a captured head, never has a diff, and refuses a pixel comparison | M1.3 |
| R4.4-04 | unit | passing | `packages/core/test/envelope.test.ts` › "never substitutes latest main for a missing baseline commit: results are incomparable" | Without `commits.base` the ingestion expects no base part, every base side is `none` and a captured head is `incomparable` with `no-baseline`, even with a main run in the store; a comparison offered for such a unit and an ingestion whose baseline disagrees with the envelope are refused | M1.5 |
| R4.4-04 | unit | passing | `testdata/schemas/run/invalid/baseline-inconsistent.compared-without-baseline-commit.json` | A stored run without a baseline commit can't hold a compared base side; with one, it can't hold a `none` base side (`baseline-inconsistent.none-base-with-baseline-commit.json`) | M1.5 |
| R4.4-05 | evidence | evidence-planned | `docs/evidence/quickstart.md` | Adopter docs and `llms.txt` state that the PR controls the harness for both sides | M3.8 |
| R4.4-06 | unit | planned | `packages/forge-github/test/pr-association.test.ts` | A historical PR whose base can't be corroborated gets association `none` with a diagnostic, never today's base branch | M2.1 |
| R4.4-06 | unit | planned | `packages/publisher/test/ingest-job.test.ts` | The ingest job stores that run unassociated (no stream, no comment) with the diagnostic | M2.3 |
| R4.4-06 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | Sub-case C: a stale run enters history but never replaces the current head's comment | M2.3 |
| R4.4-07 | evidence | recorded | `docs/adr/0007-s11-same-repo-identity.md` | Same-repo opened, synchronize and "re-run all jobs" recorded with redacted payloads and REST responses | S11 |
| R4.4-07 | evidence | evidence-planned | `docs/adr/` (fork identity) | Fork PR, first-time-contributor approval and partial rerun recorded before M2 exits (fork deferred from M0.5 by the owner, 2026-09-30) | M2.6 |
| R4.5-01 | unit | passing | `testdata/schemas/store/invalid/schema.foreign-marker.json` | `store.json` with a foreign marker is rejected | M0.3 |
| R4.5-01 | unit | passing | `testdata/schemas/config/invalid/schema.store-branch-traversal.json` | Config can't point the store at a traversal ref | M0.3 |
| R4.5-01 | unit | passing | `testdata/schemas/config/invalid/schema.store-branch-lock.json` | Config can't point the store at a `.lock` ref | M0.3 |
| R4.5-01 | unit | planned | `packages/store/test/git-branch.test.ts` | The default branch, an unmarked existing branch, a foreign repository ID, or any ref other than the configured one is refused before any write; never "initialized" over content | M2.2 |
| R4.5-01 | evidence | recorded | `docs/security/repo-settings.md` | Row 2: this repo's default branch is protected; adopter docs recommend the same | M0.2 |
| R4.5-02 | unit | planned | `packages/store/test/git-branch.test.ts` | Hooks, filters, submodules, credential helpers, `core.sshCommand` and hostile tree modes (symlink, gitlink, exec) never execute or get followed | M2.2 |
| R4.5-03 | simulation | planned | `packages/publisher/test/simulation/sim-ingest-cas-race.sim.test.ts` | **CAS race.** Four ingestors fetch the same tip; all four runs are in the final store within 5 attempts each; every push uses an explicit lease; no rebase, no plain `--force` | M2.2 |
| R4.5-03 | unit | planned | `packages/store/test/git-branch.test.ts` | A stale lease fails; first creation uses an expected-absent lease | M2.2 |
| R4.5-03 | simulation | planned | `packages/publisher/test/simulation/sim-lease-exhausted.sim.test.ts` | Retries exhausted → the previous store tip and site stay consistent; a repair instruction is reported | M2.4 |
| R4.5-04 | simulation | planned | `packages/publisher/test/simulation/sim-push-outcome-unknown.sim.test.ts` | Push accepted but the client times out → refetch finds the run key; no duplicate, no overwrite | M2.2 |
| R4.5-04 | unit | passing | `packages/core/test/envelope.test.ts` › "treats an already-stored run key as a no-op and never replaces the stored run" | A run key already in the store index → no-op (`added: false`, the same store, `txn` unchanged), even when the retry has different results and created time | M1.5 |
| R4.5-05 | unit | passing | `testdata/schemas/site/invalid/schema.app-url-field.json` | `site.json` can't carry an app URL | M0.3 |
| R4.5-05 | unit | passing | `testdata/schemas/site/invalid/schema.app-hash-in-versions.json` | `site.json` can't carry an app hash | M0.3 |
| R4.5-05 | unit | planned | `packages/publisher/test/site-tree.test.ts` | A store containing `.html`, `.js`, `.svg` or unknown files produces a served tree without them; app bytes and hashes come from the release only | M2.3 |
| R4.5-05 | unit | passing | `packages/core/test/housekeeping.test.ts` › "refuses store files outside the 03 §3 layout rather than serving or deleting them" | Housekeeping refuses a store tree holding a file outside the 03 §3 layout (`.html`, `.js`, `.svg`, a misfiled blob, a non-JSON file in a data namespace), and never deletes it. The planned site lists only generated paths, run records, pooled PNGs and grace JSON. The projector's own allowlist is M2.3. | M1.6 |
| R4.5-05 | unit | passing | `packages/core/test/changes-projection.test.ts` › "projects only JSON and text at the 03 §3 paths, marking only changes.json immutable" | The projection emits only `.json` and `.txt` files at the 03 §3 paths built from IDs; no HTML, run-record or blob copy comes from it, and served schemas are the release's own | M1.7 |
| R4.5-05 | unit | passing | `packages/core/test/changes-projection.test.ts` › "derives streams, PR pointers, the API index and site.json from the store index" | `site.json`, the API index and stream files carry no URL, script path or hash besides the generation | M1.7 |
| R4.5-06 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | **Deploy/comment race**, sub-case A: projectors A and B reordered at barriers; each reads the store after the lock; the final deployed generation's store tip contains both runs; no deployment uses an older tip than the one before it | M2.3 |
| R4.5-06 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | Sub-case B: a coalesced pending projector deploys and comments for earlier runs too | M2.3 |
| R4.5-07 | simulation | planned | `packages/publisher/test/simulation/sim-cdn-stale-generation.sim.test.ts` | HTTP 200 with an older `generation`, a stale `latest.json`, a body whose digest differs from the built bytes, a cached 404, or an edge that regresses after a pass is not ready until 3 consecutive full passes; no comment is written until ready or timeout | M2.3 |
| R4.5-07 | unit | passing | `packages/core/test/changes-projection.test.ts` › "derives streams, PR pointers, the API index and site.json from the store index" | Partial: `api/v1/pr/<n>/latest.json` names the PR stream's latest run key, its head SHA and the generation, and `site.json` the generation, as canonical bytes the readiness check can compare (the check itself is M2.3) | M1.7 |
| R4.5-07 | evidence | recorded | `docs/adr/0005-s2-actions-pages-bootstrap-and-readiness.md` | Fresh-repo Pages bootstrap, readiness polling, failed/cancelled deploy and same-generation repair recorded with environment deployment IDs; stale and regressing CDN generations observed | S2 |
| R4.5-08 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | Sub-case D: an older-release projector running after a newer one deploys a store tip no older than the previous one, doesn't roll back any comment, and its `site.json` names its own release | M2.3 |
| R4.6-01 | browser | planned | `packages/viewer/test/storage.spec.ts` | Poisoned `localStorage` values are validated and ignored; the app never writes tokens or approvals | M2.7 |
| R4.6-02 | unit | passing | `testdata/schemas/site/invalid/schema.app-url-field.json` | Data can't select app code | M0.3 |
| R4.6-02 | browser | planned | `packages/viewer/test/csp.spec.ts` | In Chromium, Firefox and WebKit the entry page's CSP meta is first, the app loads only with a matching SRI hash, a tampered app is blocked, and no service worker registers | M2.7 |
| R4.6-03 | evidence | recorded | `docs/security/threat-model.md` | §7 records that framing isn't prevented on Pages without a header | M0.4 |
| R4.6-04 | lint | passing | `tools/eslint-smoke.test.ts` › "reports a sink error on every marked line of the bad fixture, and nowhere else" | `innerHTML`, `outerHTML` and `insertAdjacentHTML` fail lint | M0.1 |
| R4.6-04 | unit | planned | `packages/publisher/test/comment-render.test.ts` | Labels with pipes, brackets, backticks, newlines, quotes, HTML and URL delimiters render as their canonical safe text in every Markdown context | M2.3 |
| R4.6-04 | browser | planned | `packages/viewer/test/injection.spec.ts` | Injected HTML/script in labels renders as text in all three engines | M2.7 |
| R4.6-05 | unit | passing | `testdata/schemas/changes/invalid/schema.javascript-url.json` | `changes@1` rejects a `javascript:` URL | M0.3 |
| R4.6-05 | unit | passing | `testdata/schemas/changes/invalid/schema.http-image-url.json` | `changes@1` rejects a non-HTTPS URL | M0.3 |
| R4.6-05 | unit | passing | `testdata/schemas/changes/invalid/schema.dot-dot-url.json` | `changes@1` rejects dot segments | M0.3 |
| R4.6-05 | unit | passing | `packages/core/test/changes-projection.test.ts` › "rejects other protocols, traversal, userinfo and unexpected hosts in the site location and served paths" | The site location and every built URL are HTTPS on exactly the expected host, with no port, userinfo, query, fragment, percent-encoding, backslash, empty or dot segment; IDs that aren't run keys, PR numbers, stream IDs or hashes are refused; the final URL survives WHATWG parsing unchanged | M1.7 |
| R4.6-05 | unit | passing | `packages/core/test/changes-projection.test.ts` › "builds image URLs only for captured sides, from the site location and pixel hashes alone" | Image URLs exist only for captured sides and are the site base plus `blobs/<ab>/<pixelHash>.png`; labels and claims that look like URLs or paths change nothing | M1.7 |
| R4.6-06 | unit | passing | `packages/schemas/test/convert.test.ts` › "bounds untrusted labels and messages" | Converter labels are bounded and control characters become spaces | M0.3 |
| R4.6-06 | unit | passing | `testdata/schemas/bundle/invalid/schema.control-char-in-label.json` | `bundle@1` rejects control characters in labels | M0.3 |
| R4.6-06 | unit | planned | `packages/publisher/test/comment-render.test.ts` | Bidi controls, combining characters and `@mentions` from capture data are stripped or neutralized in the comment | M2.3 |
| R4.6-06 | unit | passing | `tools/dev-compare.test.ts` › "keeps labels as escaped data in the report and out of the summary and errors" | Dev CLI output is printable ASCII: bidi, zero-width and `@mention` label text is `\u`-escaped JSON data and never in the summary; labels with control characters are refused | M1.8 |
| R4.6-07 | unit | planned | `packages/forge-github/test/comments.test.ts` | A comment with the marker but a human or look-alike bot author, or the right author with a different marker, is never edited | M2.1 |
| R4.6-07 | unit | planned | `packages/publisher/test/comment-render.test.ts` | At the 60,000-byte boundary with multibyte text, and in every degradation step, identity, status, warnings and the report link survive | M2.3 |
| R4.6-08 | unit | planned | `packages/forge-github/test/comments.test.ts` | Two comments matching marker + author → no edit, no create, a diagnostic in the summary | M2.1 |
| R4.6-09 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-comment-race.sim.test.ts` | Sub-case C: old/new PR head interleaving; the head is re-fetched immediately before writing; an old head's projector never replaces the new head's comment, and no comment moves to an older run by source order | M2.3 |
| R4.6-09 | simulation | planned | `packages/publisher/test/simulation/sim-comment-unknown-outcome.sim.test.ts` | Deploy OK, comment create times out → the marker is rediscovered before retrying; exactly one comment exists | M2.3 |
| R4.6-10 | unit | passing | `testdata/schemas/changes/invalid/schema.instruction-field.json` | `changes@1` has no instruction field | M0.3 |
| R4.6-10 | golden | passing | `packages/core/test/changes-projection.test.ts` › "keeps llms.txt free of commands and prompt-like labels as escaped data" | `llms.txt` has no code blocks, shell lines, command names or imperative instructions, links only this site, and depends only on the site location and release; prompt-like and JSON-breaking labels appear only as JSON string data in `changes.json`, never in `llms.txt` or the mutable documents | M1.7 |
| R4.6-10 | unit | passing | `tools/dev-compare.test.ts` › "never echoes bad image names, labels or prompt-like text, and escapes control characters" | Prompt-like and control-character entry names and labels never reach the dev CLI's stderr; entries are named by position | M1.8 |
| R4.7-01 | evidence | evidence-planned | `docs/evidence/quickstart.md` | Adopter docs say everything published is public and recommend synthetic data and masks | M3.8 |
| R4.7-02 | unit | passing | `testdata/schemas/bundle/invalid/text-too-long.message-over-2048-bytes.json` | Capture error messages are bounded to 2048 bytes | M0.3 |
| R4.7-02 | unit | planned | `packages/publisher/test/site-tree.test.ts` | No DOM, trace, HAR or log file reaches the served tree; errors appear only as bounded categories | M2.3 |
| R4.7-02 | unit | passing | `tools/dev-compare.test.ts` › "exits 5 for an internal error with a bounded line and no stack trace unless --debug" | Dev CLI errors are bounded (at most 20 lines of at most 1024 printable-ASCII characters), carry a stable code, and have no stack trace unless `--debug` | M1.8 |
| R4.7-03 | evidence | evidence-planned | `docs/evidence/quickstart.md` | Uninstall and GC docs say deletion isn't erasure | M3.8 |
| R4.7-04 | simulation | planned | `packages/publisher/test/simulation/sim-deploy-fails.sim.test.ts` | Store OK, deploy fails or is cancelled → the run stays stored; the summary says "stored; deployment pending" with a repair command; the next or manual projection completes it | M2.3 |
<!-- verification:end -->

### Named race tests (acceptance)

The two races are **separate** simulation scenarios (07 §4) with separate files:

| Scenario | Race | Proves |
|---|---|---|
| `sim-ingest-cas-race` | Concurrent ingestors on the store tip (TB7) | No dropped ingestion: every valid run survives bounded CAS retries with explicit leases |
| `sim-deploy-comment-race` | Projectors vs deploy/readiness/comment (TB8) | No stale generation (A, B, D), no comment rollback (C, D), old head can't replace a new head's comment (C) |

## 6. Ingest vs serialized projection

```mermaid
sequenceDiagram
    autonumber
    participant C as Capture run (untrusted)
    participant I as Ingest job (per run, parallel)
    participant S as Store branch
    participant P as Project job (one lock per site)
    participant G as Pages / CDN
    participant R as PR comment
    C-->>I: workflow_run completed (event only)
    I->>I: verify envelope via API, download by artifact ID, validate, decode, compare
    loop ≤ 5 attempts, jittered
        I->>S: fetch tip (depth 1), revalidate
        I->>S: push parentless commit, lease = fetched tip
        S-->>I: accepted / lease conflict / unknown
    end
    Note over I,S: No lock. Concurrent ingestors race only on the CAS lease.
    I-->>P: needs: ingest (queued; pending runs may coalesce)
    P->>P: acquire concurrency lock
    P->>S: read latest tip (after lock)
    P->>P: read config at default-branch head (after lock), build served tree
    P->>G: upload + deploy Pages artifact
    P->>G: poll site.json generation + per-PR latest.json + body digests
    loop each retained PR needing an update
        P->>R: re-fetch PR head + marker comments, then skip / create / edit / refuse
    end
    P->>P: release lock, write summary
```

### Ingest job (no lock; CAS only)

Permissions: `actions: read`, `contents: write`, `pull-requests: read`.

| State | Reads | Writes | Failure → next | Reported |
|---|---|---|---|---|
| I1 Verify source | `workflow_run` payload; REST run, workflow, attempt, PR association | — | mismatch/disallowed → I9 (no write). Ambiguous PR → continue unassociated. | diagnostic |
| I2 Load config | Config at the recorded default-branch commit | — | unknown version/invalid → I9 (no write) | config error |
| I3 Collect parts | All artifact pages, by ID, bounded | temp files | malformed part → rejected part, run continues incomplete; download failure → missing part | part diagnostics |
| I4 Analyse | Validated parts | in-memory run, blobs | over limits/timeout → I9 or failure record | — |
| I5 Fetch tip | `pixelwatch-data` depth 1 | — | unmarked/foreign/default/unknown version → I9 | refusal |
| I6 Build tx | Tip tree + run (+ retention/GC, budget) | new tree, parentless commit | run key already stored → I8 (no-op); over hard budget → I9 | — |
| I7 CAS push | — | lease push | lease conflict → I5 (≤ 5 attempts); unknown outcome → refetch; run key present → I8; else I5; exhausted → I9 | — |
| I8 Stored | — | — | — | `stored` + store commit |
| I9 Failed | — | nothing (or a bounded failure record through I5–I7) | — | failure category + repair command |

Maintenance `workflow_dispatch`: never treated as a capture. Skips I1–I4 and runs GC/repair as a
normal I5–I7 transaction, then the project job.

### Project job (serialized; one group per site, `cancel-in-progress: false`)

Permissions: `contents: read`, `pages: write`, `id-token: write`, `pull-requests: write`.

| State | Reads (all after the lock) | Writes | Failure → next | Reported |
|---|---|---|---|---|
| P1 Acquire lock | — | — | a newer pending run replaces this pending one: coalesced, nothing lost | — |
| P2 Read inputs | Latest store tip; config at the current default-branch head; own release | — | unknown store/config version → P8 (no deploy, no comment) | refusal |
| P3 Build | Validated store data, release app | fresh served tree; generation = H(storeTip, release, config, projectionVersion) | validation error → P8 | — |
| P4 Deploy | — | Pages deployment | fail/cancel → P8, run stays stored | deployment ID |
| P5 Readiness | Served `site.json` (generation), per-PR `latest.json` (run key + generation), body digests, preview URLs | — | timeout → P8 | `served` |
| P6 Reconcile, per PR | Newest stored run for the **current** head; PR head and marker comments re-fetched immediately before writing | comment create/edit | head changed → skip + reason; > 1 match → refuse + diagnostic; unknown create → rediscover then retry (bounded); API failure → record | per-PR comment status |
| P7 Done | — | job summary | — | stored / deployed / served / commented separately |
| P8 Pending | — | job summary | — | "stored; deployment/comment pending" + repair command. Never "published". |

Reads that must happen **after** the lock: store tip (P2), config (P2, ADR 0004), PR heads and
existing comments (P6, immediately before each write). The release is fixed by the job's own
self-checkout, so it isn't re-read (R4.5-08).

## 7. Residual risks

| Risk | Why it stays | Mitigation |
|---|---|---|
| An admin weakens the capture workflow | A reusable workflow can't enforce caller settings | Template and docs (R4.1-04) |
| Other adopter workflows post as the same `github-actions[bot]` | The author ID is per token type, not per workflow | Marker + ID check; refuse on ambiguity (R4.6-08) |
| A reordered older-release projector deploys once | Projectors can't write the store to record the last release; concurrency order follows queue time | Store tip never older; comments never roll back; `site.json` shows the release; the next projection fixes it (R4.5-08) |
| Other readers see an older or mixed generation after readiness | Readiness is observed from the runner's CDN edge only; Pages serves `max-age=600` and edges regress (ADR 0005) | 3 consecutive passes; the comment's generation stamp (05 §2); the viewer's single reload, then static fallback (04 §2) (R4.5-07) |
| A push lands after the final head check | GitHub has no conditional comment write | Every comment names its head SHA (05 §2) |
| `contents: write` isn't ref-scoped | GitHub token permissions have no ref filter | Store adapter refusal (R4.5-01) and branch protection on the default branch |
| The concurrency group name is a cross-release contract | Different group names would let two releases project at once | Fixed name, lint-checked (R4.2-07); a change needs an ADR |
| Framing on `owner.github.io` | Meta CSP can't set `frame-ancestors` | No state-changing actions in the viewer (R4.6-03) |
| Deletion isn't erasure | Git objects, caches, forks and clones survive | Docs (R4.7-03) |
| Results prove only submitted pixels | The PR controls the harness | Advisory reports, no gate (R4.3-11, R4.4-05) |
| TCB bugs (Node, Git, zlib, parsers) | Can't be removed | Pins, advisories, hostile corpora (R4.2-08) |
| Repo settings are only checked at one date | Settings can change later | `docs/security/repo-settings.md` (owner check dated 2026-10-01); re-check after any settings change |

# MVP program progress

This is the orchestration record for M0–M3. Scope and acceptance remain in
`docs/design/08-implementation-plan.md`; security remains normative in 01 §4.
HANDOVER.md stays uncommitted. Historical failure archives are preserved.

## Current state — 2026-10-04

M0 and M1 are audited complete. M2 is in progress. M3 has not started. The full
M0–M3 Goal is active; component approval does not establish milestone completion.
The last merged baseline is PR23, main `f3b998b428e1db11c0bcd8d0ae782e0149f47010`.
The action work continues on the preserved `codex/m2-action-host` branch.

| Scope | Current evidence | Remaining gate |
|---|---|---|
| Forge, store, ingestion, maintenance, minimal viewer | Reviewed merged foundation; PR23 check1197/58 and24 browser tests on each hosted OS | New integration and exact-head checks |
| Serialized projection | Independent complete32, five adversarial probes, lint and types pass | Bundled host, integrated simulation and live acceptance |
| Public Pages metadata | Final current-caller19, four root-origin probes, lint/types and independent syntax review pass | Normative current-job visibility and live acceptance |
| Native lease exhaustion, separate preserved worktree | Independent complete lifecycle4 and original8 pass with unchanged limits;125 observed children joined and99 fresh roots removed. This PR excludes that unregistered driver | Owned reporter wrapper, integration and case registration |
| Action host in this PR | Reviewed ingest/capture-free maintenance implementation and original20 tests; prepare/finish retain explicit refusal | Real prepare/finish composition remains separate work |
| Action/workflow policy and live fixture preparation | Scoped local reviews retained | Integrated checks, approved infrastructure and actual same-repo/fork served comments |
| Production pipeline, release preparation | Concrete candidates saved; runtime acceptance pending | Genuine case execution, clean approved source, reproducibility and release self-reference |

The separate four-stage host candidate ran32 tests:26 passed and6 failed, including
four unchanged30s case timeouts, a fixture byte-container mismatch and one retry
outcome mismatch. Its code and failed evidence remain preserved in the action-host
worktree. They are excluded from this PR. No timeout or assertion was weakened.

This PR's isolated integration passes `pnpm check`:1446 tests/73 files, lint/types
and actionlint/zizmor, exit0. All24 viewer tests pass across Chromium, Firefox and
WebKit using the existing pinned cache. The initial missing-cache viewer attempt
ran no product assertions and remains preserved. The unfiltered reporter has9
harness checks and3 product PASS/11 NOT RUN, exit2; all14 cases/11 IDs remain visible.
Independent review approves the original20/foundation/projection/metadata scope;
33 physical output files and9802 decoded values scan with zero findings. Exact-head
hosted acceptance remains pending.
The unfiltered simulation's last accepted merged result remains3 PASS/11 NOT RUN,
exit2. Keep all14 cases and11 stable IDs visible. Before M2 live exit, every M2-owned
case must actually pass; the two M3-owned cases remain NOT RUN/exit2 until M2 exits.
All14 must eventually pass for the final MVP.

The independent lease suites include unchanged10s hooks and30s case limits. The
historical timed-out children and retained roots remain separate failure evidence;
fresh joins do not retroactively prove a historical join. Unregistered lease code
has no complete reporter-boundary acceptance claim.

Component evidence is in [serialized projection](../evidence/m2.3-serialized-projection.md)
and [public Pages metadata](../evidence/m2.3-public-pages-metadata.md). The local
continuation's detailed chronology is preserved in immutable ignored logs and the
uncommitted handover, rather than repeated as current product status.

## Owner decisions carried forward

- Preserve milestone order and honest incomplete simulation coverage as above.
- Only NEW24's sent POST503 followed by a cancelled unvalidated retry becomes
  failed/comment-operation-failed. All other deferral, acceptance, write-count and
  work-bound assertions remain.
- Trusted transport/timing/guard ports return ordinary native Promises with
  unmodified constructor/species. The original hostile constructor reproducer
  remains FAIL/out-of-contract evidence; own-then defenses and scans remain.
- Ordered distinct RC versions and distinct release commits may share one approved
  full source SHA. Every release commit remains different from its source.
- Replace only the temporary prepare/finish dependency-absence entry test with
  invalid prepare identity and absent finish capsule refusals before credentials,
  requests or writes. Preserve the original test/evidence, other19 and planned12.

Local implementation, commits, pushes, PRs and reviewed merges are authorized.
External repositories, tokens, settings, adopter/canary writes, tags and releases
still require approval of concrete prepared resources and exact refs. M2 exit needs
same-repo AND fork comments linking actually served final run pages. M3 starts only
after M2 exit; seven canary days mean seven actual days.

The following audit records the historical baseline; its then-absent M2 components
are not the current state.
## Baseline audit — 2026-10-03

- Local and remote main: `59221ba4bfd3b8214440990e5c044503e9c53049`; PR #15 merged.
- Working tree initially: only untracked HANDOVER.md, read and preserved.
- Actual agents: AUDIT-A (`audit_m0_m1`), AUDIT-B (`audit_m2_m3`), independent
  AUDIT-C (`review_program`). Four total slots including the orchestrator.
- M0/M1 code, fixtures, ADRs and evidence inspected. Current core source tree
  `42f5d0af3e27c0ad1ba7852e5a71d3eb6a3be55f` matches recorded 207/207 CLI parity.
- AUDIT-A reran `node tools/check-reference-conversion.ts`: exit 0, 8/8 parts;
  PropertyScope 42 units/revision; TracePilot 105 units/revision. It read the pinned
  prototype code and verified all eight recorded comparator/vector SHA-256s.
- Fresh `pnpm -s test:simulation`: exit 2, 9 harness PASS, 0 product cases ran,
  14 NOT RUN, 11 stable IDs. Lease trace digest:
  `81ffc411a10649a6271b55652ccc84c0fa1a8c5bba637e776d0cb995f53d49fe`.
- Sandboxed `pnpm check`: lint/typecheck passed; Vitest startup failed with spawn
  EPERM. Sandboxed simulation: exit 1, isolated Git subprocesses could not start.
  Permitted subprocess retries succeeded: baseline check exit 0, 27 files / 672 tests,
  lint/types/actionlint/zizmor passed (Vitest 50.35 s).
- Historical Linux/Windows evidence exists in m2.4-simulation-harness.md; this is
  distinct from fresh local Windows verification and new-commit hosted checks.

## Milestone audit at the historical baseline

| Tasks | State | Evidence / remaining gate |
|---|---|---|
| M0.1 | implemented, local check corroborated | baseline 672 tests; corrective 679; new-commit Linux/Windows CI pending |
| M0.2 | recorded complete | 14 owner settings checked 2026-10-01; licence/reuse already approved |
| M0.3 | verified | nine schema fixture suites, generated types, real conversion 8/8 |
| M0.4 | implemented | complete rule/boundary traceability; planned checks remain planned |
| M0.5 | recorded complete in approved scope | S2/S4/same-repo S11, durable IDs/recordings; fork remains M2.6 |
| M0.6 | recorded and locally corroborated | prototype source, binding tiny/crop/full-size outputs and hash vectors |
| M1.1–M1.5 | implemented, recorded | codec/hash/comparator/ingress/run tests and measured evidence |
| M1.6 | implemented; audit corrections verified | eager expired-run/grace graph checks; independent red/green regressions |
| M1.7–M1.8 | implemented, recorded | exact projection goldens and 207/207 full-size dev CLI parity |
| M2.4 | implemented infrastructure | 9 harness checks; all 14 product cases NOT RUN, exit 2 |
| M2.1–M2.3 | absent at baseline | forge/store/publisher production implementations |
| M2.5–M2.7 | absent at baseline | action/release/live/final viewer/browser/local preview |
| M3.1–M3.8 | absent at baseline | full viewer, maintenance/imports, released self-review, canaries/release/adoption |

## Waves and dependencies

1. Shared corrections and frozen adapter contracts, then M2.1 forge and M2.2 store
   in parallel with independent review capacity. Activate store cases with real adapters.
2. M2.3 durable ingestion and M2.7 final viewer shell can overlap. Site assembly uses
   the real viewer assets. M2.5 actual bundle/RC follows; M2.6 live-driver preparation
   is independent but acceptance consumes that bundle and served viewer.
3. M2 exit requires same-repo and fork PR comments linking actually served pages and
   three-engine viewer evidence. ADR 0015 permits M3-dependent cases to stay NOT RUN.
4. Only after M2 exit: M3.1–3 viewer, M3.4 maintenance, M3.5 data import in parallel
   after provenance contracts freeze. M3.6 trusted released self-review and M3.7
   canaries need integrated RC/import/recovery. Seven actual consecutive daily green
   checks plus exact-final-commit M3.8 build/live/adoption evidence close the MVP.

## Frozen foundation interfaces

The orchestrator owns cross-package contracts. Authors may change private internals;
changes to these public signatures require coordination before a consumer is assigned.
Existing schema/core exports and changes@1 bytes are preserved.

### Store (M2.2)

- `StoreAdapter.read(): Promise<StoreSnapshot>`: tip (`string | null`, null means
  verified absence), repository-checked Store, every indexed Run, allowlisted sized
  tree, and bounded `readFile(path)` data access. Every indexed run/reference is
  validated before retention, mutation or returning a snapshot, including expired runs.
- `StoreAdapter.cas(expectedTip, candidate): Promise<CasResult>`: candidate is a
  complete validated store tree; result is accepted with new tip, conflict, or unknown.
  Every write is to the configured ref with an explicit expected-tip/absent lease.
- `writeRun(adapter, input, dependencies)`: immutable accepted run and canonical
  staged blobs; candidate recomputation from each fresh validated snapshot, maximum
  five attempts, injected delay/jitter/metadata/checkpoints. Existing run key returns
  the unchanged stored run. Unknown push result refetches before any retry.
- Recompute callback may supply retention/budget/GC candidate; default is safe append.
  M2.3 must provide admission control. Maintenance has separate outcome recovery;
  existence of an old run key is not evidence a migration/GC transaction committed.
- Production Git accepts only HTTPS github.com owner/repo and configured data ref;
  temporary test remotes are explicitly opted in and confined to generated scratch
  roots. No tests use this checkout's .git or remotes. Local-dir has equivalent
  validated reads/CAS semantics and refuses links/foreign/unmarked existing content.

### Forge (M2.1)

- `HttpTransport.request({method,url,headers,body?,maxBytes,signal?})` returns a
  Promise of `{status,headers,body:Uint8Array}`. Production transport streams within
  maxBytes and uses `redirect: manual`; caller rechecks size. Fake adaptation is test
  infrastructure, never a publisher implementation.
- Injected timing supplies `deadline(ms): {signal,dispose()}` and `delay(ms,signal?)`.
  Tests use virtual time; production uses real bounded deadlines. Logs/errors contain
  fixed categories/numbers only, never tokens or signed URLs.
- `GitHubClient` scopes API routes to trusted owner/repo; JSON parser is bounded and
  strict, REST shapes are checked, IDs converted only from safe positive integers.
  Pagination is bounded and does not trust external Link destinations.
- Artifact listing/download is by API-returned ID only, ≤1024 listed, 128 MiB each,
  256 MiB per attempt, 60 s requests, bounded retry/redirect counts. Cross-origin
  redirect permanently strips authorization, including a redirect back to the API.
- Sticky discovery uses exact repository marker and bot numeric ID; duplicate matches
  refuse all writes. Mutations do not blindly retry unknown outcomes; rediscovery is
  required after backoff. Mandatory `beforeMutation(existing): Promise<boolean>` rechecks
  publisher head/order/readiness immediately before each POST/PATCH, including retries;
  false defers without writing, and missing/malformed/throwing guards refuse safely.
  PR targets come only from trusted caller inputs/envelope.
- Pages metadata validates Actions source and Pages URL/host. Preflight never changes
  settings. Source verification consumes the frozen SourceEnvelope only after the
  root workflow provenance gap resolved in ADR 0016; no fabricated SHA/ref fills.
- `verifySource({event,config,configSha,releaseSha,signal?})` returns an authenticated envelope,
  fixed diagnostic codes and optional currentHeadSha. Parsed source facts and validated policy/
  provenance are privately owned before awaits. Original run time is authoritative; the selected
  completed attempt must agree. PR association/base unavailability gives unassociated history;
  malformed/auth/network responses refuse rather than masquerading as absence.
- M2.1c prerequisite: fresh `getRepository(signal?)` returns checked repositoryId/owner/name/
  defaultBranch. `readDefaultConfig(signal?)` returns `{repository,config,configSha}` after resolving
  that default ref and fetching only `.pixelwatch/config.json` at the captured SHA as bounded raw
  bytes. Strict config parsing precedes mutation; no adopter checkout, execution or defaults on error.

### Publisher / viewer (freeze before their assignments)

Existing `buildRun`, `addRun`, `planHousekeeping`, `projectedSizes`, `projectSite`,
`SiteUrls` and generated schemas are canonical inputs. Viewer produces trusted classic
app bytes plus entry HTML with real CSP/SRI digests. Publisher owns durable ingest,
fresh served-tree assembly, lock→read→deploy→readiness→reconcile, and separate statuses.
Simulation scans raw product outputs before any harness redaction.

## Decisions and conflicts

- Owner chose original `runs/{id}.created_at`; numeric attempt remains the tiebreak.
- Owner approved deferral when the served latest pointer does not name the eligible
  current-head run. Preserve existing pointer and changes bytes.
- Owner delegated unknown-bundle handling (asked for flexibility). Orchestrator chooses
  whole-ingestion refusal for selected expected unknown schemas under normative 01
  §4.2; unrelated/nonselected artifacts remain unopened. Record as delegated judgment.
- Inject ingress deadline and deterministic codec for production-backed simulations;
  retain the production 10-minute limit. Do not use PngWorker real timers in simulations.
- Owner approved optional unavailable workflowSha/workflowRef after authenticated read-only
  investigation (run/attempt/jobs/workflow/check-suite lack root provenance). ADR 0016;
  no head_sha or claim substitutes. Root schema/types/tests and forge path implemented;
  real fork provenance evidence remains M2.6.
- Documentation corrections: 00 stale status, nine schemas, converter/S11 template
  prose, actual M1.8 golden paths, strict presentation config (ADR 0010).
- Benchmark overview/table discrepancies remain unresolved: original measurements
  must reconcile them, no fabricated reruns or silently changed numbers.

## Reviews and acceptance log

| ID | Severity | Finding | State |
|---|---|---|---|
| AUDIT-C-1 | P1 | housekeeping/tree.ts lazily validates refs; unknown expired run is deleted by retention/GC | eager validation + red/green regression; independent verification passed |
| REVIEW-PRE-1 | P1 | expired grace references could likewise evade validation | eager grace refs + red/green regression; independent verification passed |
| AUDIT-C-2 | contract | ingest.ts ambient deadline and PngWorker timers need explicit simulation seams | injected deadline + codec seam; final cancellation regression independently passed |
| AUDIT-C-3 | review constraint | Capture redacts; scan raw production outputs first to expose leaks | required at activation |
| AUDIT-B-4 | contract | workflow provenance unavailable in S11 REST shapes | owner approved omission; ADR 0016/schema tests, forge integration pending |

Each substantive slice gets independent security and correctness/concurrency review;
reviewers inspect/run/attack the code and verify blocking fixes. Integrated review follows.
Evidence records command, dependency SHA, exit/count/output, platform and not-run gates.

- PRE: independent final review exit 0, 6 files / 70 tests; no blocking findings.
  Corrective check exit 0, 27 files / 679 tests; simulation exit 2, 9 harness / 14 NOT RUN.
- W1-G: author commit `1bbfdf4f10c8a89bc4ae577d1fb73c3e199a0413`, base `f97914e`;
  23 adapter tests pass, lint/typecheck pass. Independent security/correctness review active;
  source verification M2.1b is separate, not yet implemented.
- W1-S: isolated implementation active; first 11 adapter tests pass, broader hostile/race
  assertions running. Independent review and production simulation activation remain gates.

## Pull requests and integration

- PR [#16](https://github.com/MattShelton04/PixelWatch/pull/16), draft, foundation corrections,
  head `3ef45da`; independently reviewed and pushed. Hosted run `37096070619`: Linux/Windows
  check passed, 27 files / 679 tests each; both coverage commands report exit 2, 9 harness /
  14 NOT RUN and identical digest `81ffc411…`. Coverage jobs remain red (Windows shell reports
  job exit 1 after pnpm exit 2). CodeQL/dependency review passed. No merge authorized.
- Root continues on `codex/m2-integration` from PR #16 while it awaits human review.
- PR [#17](https://github.com/MattShelton04/PixelWatch/pull/17), draft forge infrastructure,
  base PR #16 branch, head `95ae11a`; pushed, hosted checks pending. Root now continues on
  `codex/m2-source-auth` for the separately reviewed source-verification slice.
- REVIEW-W1-G-1 (P1): internal comment retries bypassed fresh head/order checks and could
  overwrite newer comment content during backoff. Author fix `3506ce47f208a976564368108cfd41db51a6b514`,
  25 tests pass; independent verification passed. Mandatory beforeMutation guard is now
  part of the frozen contract; every retry rediscovers the owned comment after backoff.
- REVIEW-W1-S-1 (P1): post-process disk checks do not bound a live fetch. Author is replacing
  opaque fetch with exact-ref/depth-1 stateless transfer bounded before disk writes and before
  pack expansion; implementation and independent verification remain gates.
- REVIEW-W1-S-C-1/C-2 (P1): retained mutable recomputation/CAS maps can change accepted records
  after validation, and add traversal paths before the local write loop. Real independent
  probes reproduced both; synchronous private candidate/input copies and regressions required.
- W1-G source auth author `4f3546ba5a6a373e368edf78a2abc981f8e1396e`: 37 tests / 3 suites,
  lint/typecheck pass. Independent security/correctness review active; not integrated yet.
- W1-G integrated infrastructure: root check exit 0, 29 files / 704 tests plus workflow lint;
  full simulation exit 2, 9 harness / 0 product / 14 NOT RUN. One invalid phase-owner label
  initially failed traceability; corrected the document without loosening the assertion.
- REVIEW-W1-G-SOURCE-1/-2 (P2): comparison 404 must become unassociated history, and trusted
  validated provenance primitives must not be reread from a mutable caller after awaits.
  Both independently reproduced; fix `fe8ff27719e6eacaba63ce63282a865261c0d60d` verified by
  independent 40-test suite and hostile probes. Source auth integration is a separate slice.
- Forge async ownership fix `276cc0ef281d6fce5116f60f1ae6993030390966` independently verified:
  selections/targets/body/guard and private owned-comment ID survive hostile callback changes.
  Root picks `a7844cb`; final infrastructure check and hosted evidence next.
  Final root check exit 0, 29 files / 707 tests plus lint/types/workflow lint. Independent
  manifest/lock/threat/test-proof review passed. Forge infrastructure can be proposed separately
  from source authentication; hosted checks still pending for this new slice.
- REVIEW-W1-S-C-3 (P2): changing caller metadata during retry changed injected timestamp.
  Author copied/validated metadata; independent current-code probes verify all three candidate
  races fixed. Committed SHA, final pack review and store integration remain gates.
- W1-S correctness/concurrency review at `b9fad30`: independent 4-suite / 35-test run
  passed (54.12 s), isolated Git/local mutation probes passed. Run canonical bytes, path
  confinement and retry timestamp remain unchanged; raw production outputs clean.
- REVIEW-W1-S-PACK-2 (P2): actual GitBranchStore.read() refused an HTTP 302 but left its
  open response body alive after clearing the transfer deadline. Cancellation before
  deadline disposal is required; minimal transport fix and independent verification active.
- REVIEW-W1-S-PACK-3 (P3 correctness, integration blocker): ASCII decoding masks high
  bits, so malformed packet/PACK literals can pass pre-index validation. Exact byte checks
  and regression required. Strict Git indexing still refuses; no ref-write bypass demonstrated.
- Source integration at `318bbaa`: full check exit 0, 30 files / 722 tests. Independent
  source and async ownership review passed; integrated documentation/traceability review
  exit 0, 4 files / 50 tests. One unsupported runtime-schema claim corrected in ADR prose;
  no assertion weakened. Final full check 722/30 passed; simulation incomplete exit 2.

## External gates (not blanket blockers)

### Next-source preparation at dependency `67f1ddc`

Root implemented the metadata-only selection seam (ADR0023) in an isolated dependency branch.
Actual eight tests first had six failures/two passes; final metadata/ingestion/merge28/3
passed2.76s, focused lint/typecheck0. One startup sandbox failure collected no tests.
The full API listing now survives duplicate/ignored/missing downloads; invalid supplied
downloads refuse before any ZIP access. No dummy archive or schema/golden/dependency change.
Independent review and full integration remain gates. Current foundation67 fullcheck908/47
and viewer24/24 passed; a later admission self-finding holds that foundation for one-time
bounded listing/reader/checkpoint/adapter-port captures. It has strict actual red probes,
not a passing verdict. Full simulation remains2PASS/12NOTRUN/exit2; sixteen product replay
hashes plus one harness hash match the merged-viewer source exactly.

Readiness and source-ingestion specialists prepared real adapter-based DTOs/tests without
edits. Their final root-owned interface freeze follows the admission correction. Readiness
alone cannot activate the full CDN scenario through a vacuous empty comment list. Deployment,
comment orchestration, real live M2 exit and all M3 gates remain absent/unproved.

- Fixed separate e2e organisation/upstream/bot fork identities and scoped credentials;
  owner approval before creating repos/tokens/settings or external repository writes.
- Read-only discovery permitted. Prepare concrete driver/setup changes before approval.
- Live source fork/approval/partial-rerun/stale-head, Camo or text fallback, S7 GitHub
  growth/push sizes, actual served pages and comments remain unproved.
- External TracePilot and PropertyScope fork canary changes need approval.
- PR merges now authorized by the owner; existing required checks still gate each merge.
  RC/final tag/release publication still needs explicit owner approval; no tag moves.
- Seven actual daily checks and fresh-adopter evidence require time/human participation.
- No M4+ work or future designs. Completion cannot be claimed until every done-when is proved.

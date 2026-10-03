# MVP program progress

This is the durable orchestration record for M0–M3. Scope and acceptance remain in
`docs/design/08-implementation-plan.md`; security remains normative in 01 §4.
Status is evidence, not an estimate of completeness. HANDOVER.md stays uncommitted.

## Current checkpoint — 2026-10-03

- Exact publisher source `c319ded5bf8bd99315b286376cca142a2cbf04f4` passed unfiltered
  `pnpm -s check`:930 tests/48 files, exit0,320.42s, including lint/typecheck/workflow lint.
  Complete `pnpm -s test:viewer` passed24/24, exit0,34.8s, eight cases in each engine.
  Independent admission approval at d1b685a covers56/56,206.20s, original3 probes and
  fifteen additional hostile variants. Independent metadata approval at1678d59 covers28/3
  existing tests and28 reached production forge/core probes;102 raw values scan clean,
  deadlines/disposals10/10, delays2 and zero ambient timing/random calls. These reviews
  exclude each reviewer's own implementation. Full `pnpm -s test:simulation` exited2:
  nine harness PASS, two production PASS, twelve NOT RUN; all17 normalized trace hashes
  match the previous integrated proof. Final documentation traceability passed7/7, exit0,
  2.82s. Hosted exact-head Linux/Windows acceptance remains a gate before this PR merges.
- Readiness contract/types are frozen on dependency branch0179b2e (ADR0024); its isolated
  implementation author is writing tests first. Source ingestion, admission cancellation,
  serialized deploy/comment reconciliation and M2 live exit remain unimplemented. The owner
  approved bounding source work by ten minutes, checking cancellation before every new CAS,
  and truthful recovery of already-sent pushes. That approval is not implementation evidence.

The entries below are historical checkpoints, superseded by the facts above.

- Publisher foundation source `c319ded` combines reviewed assembly/diagnostics at67, admission
  correction author`d1b685a` (pick0916123), and root metadata seam author1678d59 (pickc319ded).
  Current verified main remainsf60311c; no PR is open yet. Independent admission original3
  and extra15 probes pass; independent unfiltered56 suite is active. Metadata independent
  review is active. Neither active review is recorded as approval.
- Stable67 `pnpm check` passed908/47, exit0,229.47s, including workflow lint; viewer24/24
  passed26.5s in all3engines using the existing pinned browser installation. Initial concurrent
  fullcheck failedPNG5s rejection andGit30s timeout/cleanup (906pass/2fail); unchanged fullcheck
  alone passed without changing assertions/limits. Initial browser setup had no installed
  engines and ran0cases; its failed report is retained separately from actual24passing.
- Independent assembly/sharedguard final approval at67: all4originalCAP probes and11
  additional variants passed; unfiltered35/3 passed12.09s. Forge55/4 passed2.49s plus31
  hostile observations/56rawerrors, zero diagnostic getters; original callback leaks closed.
  Store fixed diagnostics independently closed with4native/Proxy probes/all73codes. These
  approvals exclude their respective implementation authors' own files.
- Admission self-check exposed caller-map/bind/count/checkpoint captures. RootactualLocalDir
  original3 failed; independent original3 plus15variants reproduced the same class of defect.
  Author14newtests first12failed/2passed with42filtered; fullfinal56 passed209.28s and
  lint/types0, all9rawlogs clean. Exact final independent/fullcombined/hosted gates remain.
- Full reporter at67 exited2:9harnessPASS/2productPASS/12NOTRUN. All16product hashes plus
  one harness hash match merged-viewer proof. Metadata8tests first6failed/2passed, final
  metadata/ingestion/merge28/3 passed2.76s with raw leakage assertions and lint/types0.

The entries below are historical checkpoints, superseded by the facts above.

- Current verified main is `f60311c` (PR #20 merged; viewer/platform evidence below).
  Publisher branch rebased as `c4098ce` with publisher/store source byte-identical to the
  preserved pre-rebase branch. All three conflicts were progress prose; both histories remain.
- Independent admission approval covers exact author `d332647`:42/42 plus six recovery and
  thirteen hostile-input probes, reached injections and raw scans. Independent assembly
  review found new CAP-1/-2/-3/-4 blockers: incoherent snapshot/tip, oversized listing bypass,
  uncaptured reader and repeated asset parent reads. Author strict red/fix work is active;
  assembly or combined acceptance is not approved yet.
- Store ERR1 independently verified at immutable `f4ba5f3`:four original native/Proxy probes
  pass, callbacks reach once and zero accessors/alias/cause/raw-secret, all73 current codes
  match the runtime allowlist. A probe against the moving rebase failed and is explicitly
  invalidated, retained without a verdict. Final stable probe logs are separate.
- GitHub callback diagnostic correction: client/fetch/stream/timing tests first red, final
  full forge55/4 exit0,1.26s, lint/types0. Private code identity prevents retry steering;
  independent original-probe verification and full combined acceptance remain gates.

The following entries are historical checkpoints, superseded by the facts above.

- PR #20 is held for REVIEW-W2-V-PATH-1 (P2), a reproduced local preview substitution race;
  hosted CodeQL reported two path-injection alerts on the original preview. Root replaced
  request-derived filesystem resolution with a captured inventory and checked descriptor reads.
  New inventory regression first failed (one failure / six tests); the forced native race
  first failed (one test, actual 200 versus expected 404). Corrected focused suite passes
  seven tests / two files; independent current-diff verification also passes. Stable source
  `3bffa7e` full check exit0, 826/43 (254.75 s), browser exit0 24/24 all three engines (50.1 s),
  full simulation exit2, 9 harness / 2 product PASS / 12 NOT RUN with unchanged normalized hashes.
  Stable-SHA independent review and hosted exact-head CodeQL remain integration gates.
- Independent review capacity rotated after three service-interrupted reviewer turns. Assembly
  author now reviews root viewer tooling, admission author reviews assembly/shared diagnostics;
  neither approves their own implementation. Prior concrete findings remain tracked until fix
  verification; interrupted turns are not approvals.

- Combined viewer/store source `47e0626`: full check exit0, 42 files / 824 tests (199.51 s),
  all linters/types pass; full browser acceptance exit0, 24/24 (33.2 s), all three engines.
  Full simulation exit2, nine harness / two production PASS / twelve NOT RUN; every normalized
  hash matches final merged-store proof. Independent integrated-source/lock/threat/workflow
  review passed 14 focused tests and workflow lint. One viewer PR will now run hosted acceptance;
  real Pages/live fork, M2 exit and all M3 gates remain open.
- PR #20 merged at `f60311c8d2ea8130206eb412b3a672da338cde25`, exact head `1d0b939`.
  Hosted run `37107686143`: Linux/Windows each passed826/43 and unfiltered viewer24/24
  (16.0/39.0 s). Both full simulations exited2 with2PASS/12NOTRUN and all sixteen
  normalized hashes matching local proof. Aggregate CodeQL now passes; API returns no open
  PR merge-ref alerts, with no dismissal/suppression. Independent preview review at source
  `3bffa7e` passed7/2 plus17 native/request probes; all seven named injections reached once.
  Supported actual preview is restarted on corrected source, session22938, same run entrypoint.
- Actual admission author `d332647` integrated as `8dbefff`, only three owned files. Final
  unfiltered42/42 passed153.71 s with actual local/native Git, focused lint/types pass.
  Assembly own final source `5b87651` integrated as `8a03314`:26/26 plus lint/types pass.
  Independent authors now cross-review code they did not write; shared diagnostic/store fixes
  require independent closure. The local slices do not implement deployment/comments/M2 exit.
- REVIEW-W2-P-STORE-ERR-1 (P2) reproduced caller-owned diagnostic aliases through actual native
  before-push checkpoint. Root strict red regression then full native15/15 passed88.96 s;
  fresh errors preserve privately known fixed codes without caller fields/causes. Independent
  original-probe fix verification and full combined acceptance remain gates.

- Controlled publisher admission/assembly interfaces are frozen at `6cf4836`; actual assembly
  source `4abf6d4` and workspace manifest `a7f638c` are integrated on the dependency branch.
  Independent review holds integration for byte-copy accounting, undocumented snapshot-derived
  metadata and caller-owned diagnostics (REVIEW-W2-P-A-1/-2, REVIEW-W2-P-ERR-1). Authors
  reproduced strict regressions before fixes; historical assembly 20/20/full 844 and admission
  30/30 do not close these findings. Root fixed asynchronous diagnostics with private provenance
  and fresh errors; shared input wrapper/admission tests and final independent review are pending.
- Native attempted-tip receipt `eb098c3` independently passed the full 14-test Git branch suite
  (62.09 s). Every unknown receipt derives only from the private completed candidate commit;
  admission still requires exact refetch tip plus complete candidate-tree equality. Full
  integrated acceptance remains a gate.

- M2.3 root contract freeze 1: `m2-publisher-contracts.md`, ADR 0022. Owner approved
  configurable 400/500 MiB defaults, preserving existing config@1/core limits. Independent
  reviewer examined assembly DTO/ownership/budget/generation boundaries; implementation remains
  unproved. Isolated assembly/admission authors get disjoint modules after this commit.
  `writeRun` remains strict; controlled expiry needs exact candidate/tip recovery proof.

- PR #19 merged `ce226ca011cca71882a0f102ef8f33de42783d2f` after final independent review
  and every required check passed. Exact head `fe1ff57` hosted run `37103496303`: Linux and
  Windows each passed 785/37; both full simulation commands exited2, 9 harness / 2 product
  PASS / 12 NOT RUN. All sixteen normalized trace hashes match each other and local source
  `7b0743d` results. Runner P1/P2 findings are independently verified closed (14 focused tests).
- Viewer `a56e398` full check exit0, 770/36 (55.86 s); independent docs/workflow review
  passed 7 trace tests and workflow lint. Actual retained hostile-browser rerun at a56e398
  passed 18/18; raw transcript independently inspected/scanned clean. The viewer has been
  rebased onto merged store main with empty viewer/schema/tool source diff. Root corrected
  the workspace-importer lockfile conflict explicitly; no dependency versions changed.
  Final combined check/browser/coverage and hosted viewer gates are now running/pending.

The entries below are historical checkpoints, superseded by the current facts above.

- Final store/runner source `7b0743d`: Windows full check exit0, 785 tests / 37 files,
  workflow linters pass (201.57 s). Full no-network reporter exit2: nine harness PASS,
  two product cases PASS across all four seeds twice, twelve NOT RUN. Exact trace hashes
  match independent recordings. P1 manifest ownership and P2 returned-DTO getter defects
  have strict red/green regressions; final independent fix verification/hosted gates pending.
- Root publisher dependency branch `.tools/worktrees/m2-publisher` at `373e8d0` combines
  source main `44420ca`, reviewed store `7b0743d` and local viewer `a56e398`; root retained
  both evidence/progress records and regenerated only the pinned lockfile offline. This is
  preparation for M2.3, not a working publisher or M2 exit.

- Latest verified main `44420ca45d2c4854d447369cf36f75b62d0afac2`: PRs #16, #17 and #18
  merged with owner authorization and every required hosted check green. PR #18 exact head
  `38a17f2` hosted Linux/Windows each passed 731/31; full simulation each exited 2 with
  nine harness checks and fourteen NOT RUN. No settings or required checks changed.
- Store and two real driver slices independently approved: author `b9fad30` + `1ad15a` +
  `e47c501`, root `6972da4` + `1186b69` + `caef46e`, dependency main `44420ca`.
  Independent eight driver tests ran both cases for all four seeds twice with exact equality;
  five harmful mutants refused; credential/time/randomness traps and raw secret scans passed.
  Root async runner four tests first failed, then passed; real full run/integrated review pending.
  Root `6e41c8f` full check passed 782/37 and full simulation passed two product cases with
  twelve NOT RUN/exit2. Independent integration review found a P1 mutation could erase cases,
  seeds or original verifiers after validation; two regressions red then six runner tests green
  with private snapshots. Final fix SHA review/check/full run remain required before merge.
- Viewer source `8445320`, cancellation fix `347d6b` independently verified with fourteen
  unit tests. Original real browser run 21/24 exposed fixture assertion and WebKit focus issues;
  root `aba8d91` gives generated anchors explicit tab stops and authenticates preview Host.
  Root `bb0e05a` fixes real nested entry advertisements and browser report paths. Final author
  three-engine run pending; independent hostile browser probes passed 18/18. No M2.7 exit claim.
- Actual specialists: viewer author, independent browser reviewer (former store author),
  independent tooling/security reviewer, plus root integration/runner. Four total slots.

The following entries are earlier checkpoints, superseded by the facts above.
- Viewer author and independent unfiltered browser acceptance each passed 24/24 at `bb0e05a`
  (eight per Chromium/Firefox/WebKit); independent eighteen hostile browser probes passed.
  P1/P2 cancellation, Host and nested-entry findings all independently closed; exact transcripts
  and initial 21/24 failure are retained. Rebase onto main `44420ca` produced `b500453` with
  empty viewer/schema/tool tree diff; frozen offline install and actual fixture generation pass.
- Supported actual final app preview is running at `http://127.0.0.1:4173/pixelwatch/runs/11-a1/`
  via `pixelwatch-dev serve`; synthetic local inputs explicitly labelled, real core projection/
  PNGs/generated entries/app. Root CI now runs all three engines on Linux/Windows with no
  credentials/cache/filters/skips. Owner approved separate-suite threat status bookkeeping.
  Final integrated check and hosted/real Pages/live gates remain pending.

The entries below are earlier checkpoints, superseded by current facts above.

- Owner explicitly authorized merging completed reviewed slices as the program proceeds.
  Existing squash-only policy and required checks are preserved; no settings were changed.
- PR #16 merged `64b8c36c751da3902f79521f50bfe4f2b05c5648`; PR #17 merged
  `f4a4499d8919b67414e6b1f8e35eb3dc8c6daf6f`, current verified remote main.
  PR #17 rebased head `0022caf` had all five required hosted checks passing before merge;
  full simulation remained correctly non-green. Dependency branches rebased with explicit
  leases and empty old/new tree diffs. PR #18 now targets main.
- Trusted config joins the closely related source slice in PR #18 instead of another PR:
  author `0f88fcb`, root `0f96ba8`; independent 52-test/19-hostile-probe review passed,
  final root check 731/31 passed (73.23 s); independent integrated review 59/5 passed.
  New PR-head hosted checks follow.
- Store security fixes `1ad15a571fd1fdcff20bb8e1819ce8264d6605d0` independently verified:
  39 tests pass, actual malformed-response cleanup order and high-bit pre-index refusal proved.
  No remaining blocking store finding. Author now activates two real Git product simulations.
- Generated viewer entries `7ba1b3858d1de559c256247a29f665b857ab4933` implemented:
  13 unit tests and author 692-test check passed; independent entry review 13 tests and 18
  hostile probes passed with no blockers. Browser app,
  supported local preview and actual three-engine evidence are not yet implemented.
- Root static browser validation `788353b82b1bfdea667b98b7dd3a68bf483a1318`:
  author check 685/29 and final selected 6/2 passed; independent 169-test and 2,000-mutation
  probes pass, final SHA review pending. Browser app implementation/tests in progress;
  no actual app/browsers/preview acceptance yet.
- Publisher admission prerequisite: ADR 0012 permits an old late capture to expire in its
  admission transaction. Foundation writeRun deliberately forbids arbitrary accepted-record
  omission. M2.3 needs a separate controlled planHousekeeping.newRunExpired outcome and
  exact candidate/tip recovery proof; an absent old run key cannot prove unknown push success.
  Existing retention policy stays intact; no owner decision is reopened.

Earlier checkpoint entries below are historical snapshots, superseded by the facts above.

- Root: `codex/m2-source-auth`, source picks `9a7bfc8`/`318bbaa`; integrated check exit 0,
  30 files / 722 tests. Independent integrated source/documentation/traceability review passed;
  final check 722/30 (38.84 s). Full simulation exit 2, 9 harness / 14 NOT RUN.
- PR #16 and #17 are draft and unmerged. PR #17 head `95ae11a5e5892c20d766778146197aa540b238d7`
  hosted run `37097793164`: Linux and Windows checks passed (29 files / 707 tests each),
  CodeQL/dependency review passed; both full simulation commands exited 2 with 9 harness
  checks / 14 product cases NOT RUN, identical `81ffc411…` digest. Coverage jobs remain red.
- W1-S author `b9fad30f18167e8527bc045d3afd996e6583ad9c`, base `3ef45da`:
  full check exit 0, 31 files / 714 tests (35 store). Independent correctness/concurrency
  review passed; security review found two blocking pack issues, fixes active. No store pick yet.
- W1-G-C author is implementing fresh repository/default-ref config loading; eight tests first
  failed on missing methods. No config slice acceptance claimed yet.
- Three actual specialists plus root: store author, forge/config author, independent reviewer.
  Viewer worktree exists but has no implementation; publisher is absent. M2 exit remains open.

This checkpoint supersedes earlier in-flight statements in the chronological acceptance log.

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

## Milestone audit

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

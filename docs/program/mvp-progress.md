# MVP program progress

This is the durable orchestration record for M0–M3. Scope and acceptance remain in
`docs/design/08-implementation-plan.md`; security remains normative in 01 §4.
Status is evidence, not an estimate of completeness. HANDOVER.md stays uncommitted.

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
  Permitted subprocess retry succeeded for simulation. Fresh check capture pending.
- Historical Linux/Windows evidence exists in m2.4-simulation-harness.md; this is
  distinct from fresh local Windows verification and new-commit hosted checks.

## Milestone audit

| Tasks | State | Evidence / remaining gate |
|---|---|---|
| M0.1 | implemented, baseline check being corroborated | strict tooling, network guard, real fixtures, Linux/Windows CI |
| M0.2 | recorded complete | 14 owner settings checked 2026-10-01; licence/reuse already approved |
| M0.3 | verified | nine schema fixture suites, generated types, real conversion 8/8 |
| M0.4 | implemented | complete rule/boundary traceability; planned checks remain planned |
| M0.5 | recorded complete in approved scope | S2/S4/same-repo S11, durable IDs/recordings; fork remains M2.6 |
| M0.6 | recorded and locally corroborated | prototype source, binding tiny/crop/full-size outputs and hash vectors |
| M1.1–M1.5 | implemented, recorded | codec/hash/comparator/ingress/run tests and measured evidence |
| M1.6 | implemented; audit regression found | unknown expired run can evade lazy validation before GC; fix required |
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
  required. PR targets come only from trusted caller inputs/envelope.
- Pages metadata validates Actions source and Pages URL/host. Preflight never changes
  settings. Source verification consumes the frozen SourceEnvelope only after the
  root workflow provenance gap below is resolved; no fabricated SHA/ref fills.

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
- Open investigation: authenticated REST run/attempt recordings lack required root
  workflowSha/workflowRef. Do not substitute head_sha or capture claims. Need official
  corroboration mechanism or an explicit minimal contract correction before that path.
- Documentation corrections: 00 stale status, nine schemas, converter/S11 template
  prose, actual M1.8 golden paths, strict presentation config (ADR 0010).
- Benchmark overview/table discrepancies remain unresolved: original measurements
  must reconcile them, no fabricated reruns or silently changed numbers.

## Reviews and acceptance log

| ID | Severity | Finding | State |
|---|---|---|---|
| AUDIT-C-1 | P1 | housekeeping/tree.ts lazily validates refs; unknown expired run is deleted by retention/GC | reproduced; regression/fix required |
| AUDIT-C-2 | contract | ingest.ts ambient deadline and PngWorker timers need explicit simulation seams | correction planned |
| AUDIT-C-3 | review constraint | Capture redacts; scan raw production outputs first to expose leaks | required at activation |
| AUDIT-B-4 | contract | workflow provenance unavailable in S11 REST shapes | investigate, affected source verification held |

Each substantive slice gets independent security and correctness/concurrency review;
reviewers inspect/run/attack the code and verify blocking fixes. Integrated review follows.
Evidence records command, dependency SHA, exit/count/output, platform and not-run gates.

## External gates (not blanket blockers)

- Fixed separate e2e organisation/upstream/bot fork identities and scoped credentials;
  owner approval before creating repos/tokens/settings or external repository writes.
- Read-only discovery permitted. Prepare concrete driver/setup changes before approval.
- Live source fork/approval/partial-rerun/stale-head, Camo or text fallback, S7 GitHub
  growth/push sizes, actual served pages and comments remain unproved.
- External TracePilot and PropertyScope fork canary changes need approval.
- PR merges and RC/final tag/release publication need explicit owner approval; no tag moves.
- Seven actual daily checks and fresh-adopter evidence require time/human participation.
- No M4+ work or future designs. Completion cannot be claimed until every done-when is proved.

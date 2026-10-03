# MVP program progress

This is the durable orchestration record for M0–M3. Scope and acceptance remain in
`docs/design/08-implementation-plan.md`; security remains normative in 01 §4.
Status is evidence, not an estimate of completeness. HANDOVER.md stays uncommitted.

## Current action composition checkpoint — 2026-10-04

PR [#23](https://github.com/MattShelton04/PixelWatch/pull/23) is merged at main
`f3b998b428e1db11c0bcd8d0ae782e0149f47010`. Independently reviewed exact head `891e42d`
passed all five required hosted checks and aggregate CodeQL. Both Linux and Windows ran
1197 tests across 58 distinct files and 24 browser cases across Chromium, Firefox and WebKit.
Full simulation remains 3 PASS / 11 NOTRUN, exit 2, with all 25 normalized hashes identical
between local, Linux and Windows. Its hosted jobs remain failed; this is incomplete coverage.
The next action branch merges actual main without resetting preserved integration history.

The action's invocation and staging helpers are independently approved within their scope:
complete 16/16 tests, 13.41s runner duration, focused lint and whole typecheck exit 0. Hostile
path ownership, same-inode inventory replacement, late output getters and real 100,008-file
assembly accounting reproducers are closed unchanged. The exact metadata seam accepts
44,254,887 canonical bytes below the unchanged 64 MiB bound. This proves metadata accounting,
not physical staging of 100,008 files. The immutable `state.json` is an inventory; overwriting
it with publisher state was never authorized.

The root's separate prepared-payload codec first executed 5 failing tests before implementation.
Independent review then found an array-method/accessor/Proxy validation bypass; the expanded
13-test strict red run executed 7 passes and 6 failures before correction. The corrected
complete file passes 13/13 locally and independently (1.45s and 1.46s); focused lint and whole
typecheck pass. Both original input and descriptor reproducers close unchanged, the immediate
input-mutation probe retains owned bytes, and retained PR records/targets plus actual rehashed
HTML are validated against real site reassembly. URL functions and credentials are not
serialized. Scope is data-only IO; physical process handoff, shared publisher restoration and
the production host remain gates.
The later independent cost probe found that metadata extraction
copies repeated file buffers before aggregate or duplicate-path refusal (eight real 2 MiB
copies under a 1 MiB configured hard limit). The fourteenth regression executed that strict red
before the native-length and configured aggregate checks were moved before allocation. Local
and independent complete 14/14 both pass (1.57s); unchanged cost/input/descriptor/snapshot
probes pass with zero over-budget copies. An independent exact counter seam also checks 18
valid and seven invalid cases, including exactly 64 MiB and one byte over. Scope remains IO;
physical handoff and real host acceptance are separate.

Projection now uses the genuine adapter's exact privately recorded operation promise to join
bounded completion and retain finite cleanup warnings. Its complete 31-case file currently
reports 30 PASS / 1 FAIL. The new retry-cancellation expectation remains under owner approval:
after a real POST receives 503 and cancellation rejects the retry without a validated reply,
the independent reviewer agrees that `failed/comment-operation-failed` preserves the unknown
sent outcome. Automatic approval review twice rejected that precise assertion edit because it
requires direct owner approval; neither rejected action ran. Existing accepted-201, changed-head
503 deferral, zero-write readiness and all work-bound assertions remain intact. The correction
to the deterministic timer fixture has its own tests-first red and preserves the exact
600000ms bound. Independent final consumer review and complete green integration remain gates.

The independent GitHub adapter replay passes 77/77 across six files, closing signal acquisition,
cleanup and shadow-getter findings with unchanged reproducers. The nonconfigurable native
Promise constructor boundary remains an open owner decision shared with public metadata.
Historical uncaught red logs containing a fake canary remain visible as failed scans; later
corrected logs have zero unexpected leaks. Public metadata is not integrated or approved overall.

A later projection review found that an earlier reaction could mutate a genuine comment result
to falsely claim a write or conceal an actual HTTP201. Three producer regressions executed
before correction: 14 PASS / 3 FAIL in the 17-case operation file. A first new cleanup fixture
faulted before POST and also produced an unhandled fixed diagnostic; that run is retained.
Correcting only fault timing reached all three intended failures with no unhandled error.
The adapter now freezes actual privately constructed results and copied finite warnings before
fulfillment. Its complete six-file suite passes 80/80 (1.63s), lint and types pass. Original
independent consumer closure and the integrated review remain pending; this is not full M2
acceptance. Projection's owner-gated expectation and constructor decision remain open.

Physical payload staging first executed 16 original passes and seven new failures, then the
complete 23-case author file passed (17.37s). Root review reproduced a changed payload inode
after the bounded reader's close being accepted as the retained identity despite identical
bytes. Only byte-identical replacement of the state inventory was an explicitly accepted
restart boundary. The payload finding is open with an unchanged probe; its correction and
independent physical handoff review are required before host composition acceptance.

The fixed live setup proposal is prepared locally with finite refs, scoped credentials, Pages
policy, nine actual scenarios and exact-ID cleanup. Numeric IDs, account choices, release pins
and the runnable two-shard capture workload remain unresolved. No external resource or setting
was changed. Actual host, separate worker bundles, reusable workflow, reproducibility,
production simulations and same-repository plus fork comments linking served pages remain M2
gates. M2 is not complete; M3 has not begun.

## Active continuation — 2026-10-03 to 2026-10-04

- Owner resumed the full M0–M3 program and explicitly requested goal tracking. The full MVP
  goal is active; M2 exit, M3, actual seven-day canaries and release approval remain gates.
- Preserved integration HEAD `8707bf7` and functional base `83330d2` verified. Main `1fe4821`
  is an ancestor. Original checkout remains the older branch with uncommitted HANDOVER.md.
- Priority0 investigation found a concrete lifetime gap: synchronous GitBranchStore.close
  could delete scratch while an asynchronous pack read still owns its FD and child process.
  Tests-first correction and independent review are approved. The historical two test
  timeout causes remain unverified; file scheduling uses separate unit and serial
  native phases without changing 30000ms deadlines, process budgets or race actors/assertions.
- Authors and independent reviewers work in disjoint scopes. Native-heavy commands are
  coordinated serially. Complete current local foundation acceptance is recorded below;
  projection/metadata/action/live and complete product simulation remain gates.
- Continuation crosses into2026-10-04. Independent exact051 GitHub review is APPROVED:
  complete5/5 exit0/45.79s, unchanged compiler/whole-case zero-token-read probes, child
  no-network closure and original four hashes. Root copies exact source and awaits terminal
  store close; static registry review preserves all14 cases/all11IDs. Integrated execution
  executes3PASS/11NOTRUN/exit2 with25verified hashes; this is incomplete product coverage.
- Native correction actual37/37 across lifecycle17/original15/transport5 passes exit0/59.38s.
  Independent NL-REV-1 found a throwing native listener-removal hook could strand read/close;
  tests-first correction passes unchanged reproducer and broadened acquisition/abort probes.
  Independent final native replay37/37 and full integrated check1197/58 pass. Serial original15
  measurement passes49.82s; prior timed-out cases now3274ms/3749ms without changed30000ms
  limits. These observations do not prove the historical timeout cause.
- Build author d7c2220 is clean: fixed fixture reaches strictred8/8fail, then final complete
  8/8 passes8.48s with actual separate worker/classic viewer and identical two-root inventories.
  Tooling host is explicitly a fixture; independent build review and actual host remain gates.
- Public metadata author now works at exact83330d2 in m2-public-metadata. Root nine frozen
  tests reach strictred9/9fail,1file,exit1/357ms before implementation; no unhandled errors.
  This adapter is not integrated or accepted. Projection resumes separately after cleanup DTOs.
- Initial continuation completecheck exits0 with2060tests/102files/684.36s and workflowlint0,
  but runtime discovery exposes45duplicated unit files/872cases from parent include array
  concatenation. Configuration approval is superseded for that defect. Corrected source now
  independently lists57unique=45unit/12native with no missing/duplicate/misclassified paths;
  discovery excludes omissions/duplicates. Exact independently approved build84 adds one native
  file: actual root inventory58unique=45unit/13native, exit0/1.57s. Complete corrected check
  exits0 at a8d9a72 plus reviewed source changes:1197/58,630.46s, lint/types/workflowlint0.
  Log root-corrected-native-github-build-check-20261004.log. No assertion or timeout changed.
- Shared environment accounting omitted by the original DTO is restored at a8d9a72:
  PreparedProjection.environment plus separate ProjectionResult.environmentId, required by
  the existing ADR0029/freeze. Types0 and independent alignment/security review approved;
  no new permissions or bootstrap assertion. Projection dependencies merge as e5c476a.
- Projection expanded19-case strictred actually executes18fail/1pass/exit1/2.26s before
  implementation; original12 titles/assertions retained and hostile cleanup/state cases added.
- Independent BUILD-PATH-1 finds ancestor-junction cleanup escapes the original source root.
  Author tests-first full-chain identity/realpath correction passes the unchanged independent
  probe and complete9/9 suite8.65s. Independent root complete9/9 passes8.54s; actual compiler
  guard blocks four network APIs, reads zero fake-token keys and emits identical artifact
  hashes. Scoped tooling84fde65 independent security/correctness/concurrency review APPROVED;
  exact four-file integrated static review also approved. Actual production host remains absent.
- Native final independent37/37 passes60.36s, original failure cases3578ms/3724ms and barrier
 17475ms; no EBUSY. Exact lifecycle/caller/config/ADR0030 scoped approval is complete.
- Projection author c61dcf9 freezes four files after actual complete20/20 exit0/4.91s,
  lint/types0. Undefined rejection self-finding added a twentieth strict-red regression before
  correction (1fail/19NOTRUN,2.03s). Independent adversarial review is active; no integration.
- Public metadata original13 actual cases passed; corrective final17 now independently pass
  complete Vitest17/17/959ms, lint/types0. Independent cancellation and contradictory
  next/future-last pagination blockers close with unchanged probes. PM-REV-3 own-then half is
  corrected; poisoned nonconfigurable Promise constructor remains an open trusted-port boundary
  question to the owner. Its unchanged failing probe remains retained. No suppression or scoped
  acceptance is inferred. Metadata source is frozen/unintegrated in its three assigned files.
- Root actual unfiltered simulation exits2 with9harness PASS/3product PASS/11NOTRUN, all14cases/
  11stable IDs retained. All25hashes match exact prior17 plus reviewedGH8. Browser24/24all3
  exits0/25.5s using cached pinned binaries. Physical logs7137/4571/3997bytes scan0leaks before
  reporting. Exact-head hosted/integrated final review remain gates before PR23/merge.
- Root isolated m2-action-host at a8d9a72 is created with offline frozen cached154package
  install0downloads. Five actual action invocation/filesystem tests plus refusing skeleton
  exist before implementation; actual5 strictred5fail/331ms, then caller-report identity sixth
  strictred6fail/359ms. No host implementation or acceptance claimed.
- Final documentation traceability initially fails2/7 because new simulation passing rows used
  the driver path without the required registered scenario title. References are corrected to
  the existing stable scenario path/title; assertions unchanged, complete7/7 then passes.
- Benchmark summaries are reconciled by Git history to the existing post-ADR0010 records:
  PNG202MiB; ingestion177MiB/495.0MiB. Earlier209MiB/195MiB/495.3MiB provenance remains in
  m1-benchmark-summary-reconciliation.md. No benchmark was rerun or measurement invented.

## Previous session checkpoint — 2026-10-03

- SESSION WRAP requested by owner. Agents stopped and preserved clean WIP branches; root
  creates uncommitted HANDOVER.md and ignored paste-ready.tools/NEXT_SESSION_PROMPT.md.
  No additional PR/tag/release/live setup or external mutation is made during wrap-up.
- Final root `pnpm -s check` at83330d2 EXIT1:1164pass/2fail,55files (54pass/1fail),531.35s.
  Git-branch tests "five lease conflicts exhaust bounded retries without mutating the existing
  store" (line105) and "validates expired indexed records and missing blob references before
  returning a snapshot" (line112) exceed unchanged30000ms. Teardown also reports EBUSY at
  GitBranchStore.close line210. Cause is UNVERIFIED; concurrent native-suite load is context,
  not a proven diagnosis. Lint/types passed before tests; workflow lint was not reached.
  Maintenance44 passes in this run with raw226values128852bytes0failures. Root log is
  root-maintenance-integrated-check.log. Integration is NOT ready for PR/merge. Diagnose
  lifecycle/scheduling without loosening budgets/assertions, then require full green check.
- GH source final051e0123cba65ab9333774939c8aafd6aba9af22 is preserved, not integrated or
  registered. d4c7790 complete5/5 passes77.34s, but independent review finds child guard missing.
  Final051 loads existing guard before compiler; focused1PASS/4NOTRUN,lint/types0. Independent
  exact review18d91c7 unchanged compiler probe passes3.20s with0token/real-credential reads.
  Final complete5 replay and whole-case environment probe remain PENDING; no final approval.
  Earlier independent4/4 and all repeated hashes remain scoped historical evidence.
- Projection WIP00d4b2df2bdeea0340189cf11aa4077a192d984d is a refusing skeleton plus12tests,
  initial11fail/1pass,5.81s. Onlyprojection.ts/test changed; c0daf67 cleanup DTO not yet merged.
  No implementation/types/lint/full acceptance. Public metadata assignment83330d2 is reserved
  with nine titles/three owned files/cap60; no implementation began.
- Build WIP7c1c1873c95666f137aa9815bd4e9d0e6e9867d4 preserves four assigned files atb382cb0.
  Actual suite0cases/8NOTRUN because fixture beforeAll times out (exit1,28.35s); lint8errors,
  types0. Initial sandboxEPERM ran0cases. Stubs are unimplemented; no strict eight-case red,
  compiler/runtime/reproducibility or product acceptance. Fix fixture before implementation.

## Merged baseline and preceding active-work checkpoint

Agent assignments below are historical; all three agents have stopped for the session wrap.

- PR22 is MERGED at1fe48214466d9c76e884791dea7a590ef71baee7 (12:51:06Z), exact reviewed
  head8d2de3981c8216fc0999d8f33384975dfaa1c767. All five enforced checks, aggregate CodeQL
  and both viewer jobs pass. No bypass, alert dismissal or settings change. Seven reviewed
  PRs16–22 are merged under the owner's standing authorization.
- Hosted corrected head: pnpm check1122/54 on Linux (29.39s) and Windows (212.80s), exit0;
  browser24/24 across Chromium/Firefox/WebKit on each OS (15.8s/22.2s), exit0. Both full
  coverage jobs remain2PASS/12NOTRUN/exit2; all17 normalized hashes match local evidence.
  CI37123807928, CodeQL37123807926, dependency review37123807991.
- Root integration0bcdc37 aligns next slice with verified main1fe4821, resolving only import/
  export/type conflicts; whole typecheck and diffcheck exit0. Byte-identical reviewed maintenance
  source8a95bf5 is integrated at2a04580; its root fullcheck/browser/simulation remain gates.
  IndependentA approval1caaab4 includes44/44 plus original hostile and real Git recovery probes.
- GH simulation author278748e passes4/4,31.80s; independentA review661ca7f repeats4/4,37.70s,
  with identical four seeded hashes. Blocking P2 GH-ENV-1 independently proves esbuild's default
  subprocess environment reads fake GH_TOKEN/GITHUB_TOKEN once each. No real credentials or
  observed leak; zero-token-read invariant still fails. AuthorC is correcting the fixture's
  actual compiler port using a fixed trusted child with explicit allowlisted environment.
  Case is not registered; unchanged reviewer probe and complete corrected suite are gates.
- Active writable specialists: B implements reproducible release tooling from b382cb0 in
  m2-release-build; C owns isolated GH correction and serialized projector from2a04580 in
  m2-project-caller. A independently reviews GH before the public metadata adapter assignment.
  Root owns shared DTOs/manifests/workflows/docs/integration. Four agents total; no extra agents.
- Projection/public-metadata DTOs frozen201e2a; ADR0029, projection and build contracts are
  committed. Finite truthful cleanup warnings are root-owned; whole typecheck and the complete
  threat-model suite7/7 pass (exit0,1.90s) after the contract and five maintenance rows change.
  No production projector/public preflight/action workflow or RC build is claimed yet.
- Actual generated final viewer entry remains http://127.0.0.1:4173/pixelwatch/runs/11-a1/.
  Its fixture pixels are local viewer evidence. M2 exit still needs authorized same-repo/fork
  comments linking actual served run pages, pinned release/workflow checks and live evidence.
  M3, canaries, seven daily checks, final release and fresh-adopter gates have not started.

The entries below are historical checkpoints, superseded by the facts above.

## Earlier checkpoint — 2026-10-03

- PR22 opened at810b157; hosted unit1120/54 and browser24/24 pass on Linux/Windows. CodeQL
  language/action jobs succeeded but aggregateHIGH alerts3/4 flag unanchored marker regexes;
  merge HELD. Root replaces searches with bounded literal parsing;22/22 tests pass before/
  after, preserving semantics. IndependentC exact94cea3f passes22/22 plus57variants twice,
  identical normalizedd8163dcd… and6rawlogs clean. New local/hosted exact-head gates pending.
- Hosted810b157 actual Linux1120/54,42.99s and Windows1120/54,220.42s; browsers24/24 each,
  19.4/24.5s. Both fullcoverage jobs print2PASS/12NOTRUN/exit2 and all17hashes equal local.
- Maintenance author8a95bf5 final44/44,152.18s/raw226clean; A independentlyAPPROVED exactsource
  (review1caaab4),44/44,156.82s plus29repeatedownership/cleanup,9unchangedpathvariants and
  2actualnativeconflict/lostreply/cancellationprobes. Integration remains nextslice gate.
- Integrated source6547d469800593f23a74a8cc2bd503c03d1ff070 passes complete `pnpm -s check`:
  1120tests/54files,exit0,359.25s; lint,typecheck,actionlint,zizmor0. Browser24/24 across all
  three engines,exit0,26.0s. Exact source-job bytes match author3e315b1; public ingestJob exists.
- Source author A-independent review closes all4SOURCEfindings and actual reused-blob/GC race:
  83/83 at3e315b1,exit0,12.82s;16 unchanged hostile/interleaving probes pass. Second independent
  C integrated review at6547d469 passes83/83,15.42s plus13 coupled actual-forge/core/LocalDir/
  nativeGit rows twice; hash481de397… identical,74raw scans/run,6logs clean. No new blocker.
  Scope ingestion through durable admission; projection/workflow/live safety remain gates.
- Publishing identity P1 IDENTITY-1 independently CLOSED at02b80f4:34/34,exit0,1.04s;
  unchanged original accepted-POST reproducer recovers;34 original and14 reuse variants each
  repeat identically,15rawlogs clean. Root correction uses a private never-exposed HTTP carrier.
  Fresh guarded fallback composition and actual workflow/live token ownership remain gates.
- Readiness independent review45/45 plus9 repeated temporal traces,14boundaries/10cleanup
  probes passes. Pure comment renderer independent20/20 plus71variants twice passes. Both are
  integrated and covered by the1120-test check; full deploy/reconcile pipeline remains absent.
- Final full simulation at documentation-onlyaa3dcb9 exited2:9harness PASS,2product PASS,
  12product NOT RUN. All17ordered normalized hashes match0516268/priorlocal/PR21Linux/Windows.
  Logroot-reviewed-source-simulation.log; no new driver is registered yet.
  ADR0015 requires this incomplete coverage to remain visibly non-green.
- Six reviewed PRs16–21 merged under owner authorization; verified mainba4831d. Next grouped
  PR22 is not yet opened. It groups reviewed source/readiness/comment/prerequisites; maintenance
  remains a separate following slice. Hosted exact-head checks/CodeQL remain merge gates.
- W2-M author B works in isolated m2-maintenance from frozen1ceb27d;12required titles ×2backends
  initially fail24/24 at stub. Additional hostile tests now38total; native red/fix/acceptance is
  active, with independent reviewer A reserved. No maintenance approval or integration yet.
- Read-only deployment discovery maps all14 historical S2 deployments uniquely to exact API
  job URLs/status fields, including same-SHA distinct jobs. Original job-token access and early
  current-deployment visibility were NOT proved; CLI auth cannot substitute. Fixed public
  no-auth read policy is being checked without widening normative workflow permissions.
- Independent action/workflow/release/live preparation completed; production contracts/build
  and fixed authorized live infrastructure still need implementation. Simulation activation
  audit is active. No external settings/repositories/tokens/tags/releases were changed.
- Actual generated viewer entry http://127.0.0.1:4173/pixelwatch/runs/11-a1/ responds200,
  4953bytes, with SHA256-pinned app SRI. Fixture pixels demonstrate generated final app only.
  M2 exit requires real served same-repo/fork comment evidence. M3 has not started.
The entries below are historical checkpoints, superseded by the facts above.

- Integrated sourcef546eb871705689c8ffd3ec6d2d071f02b8ca636 passes complete `pnpm -s check`:
  1029tests/52files, exit0,252.76s;lint/types/actionlint/zizmor0. Root browser is running;
  final fullsimulation and hosted evidence remain gates. Comment independent review pending;
  production source job remains held rather than being counted in this check.
- Source091 independent SOURCE-3 P1: native AbortSignal.any reads poisoned public aborted
  getter and loses already-aborted native caller/deadline. Two actual forge→LocalDir probes
  store99-a7/CAS1 with10public getter reads instead of refusal0reads. Author replaces this
  with a private controller and captured intrinsic links. Source new strict70tests red12fail/
  58pass,11.73s; product scanner385values/268254bytes clean but Vitest transcript contains
  the known unhandled fake-canary rejection from SOURCE-1. That is security-red evidence,
  never a clean-log claim. SOURCE-2 variants reach source/ZIP/list/pixel/encode/compare/
  snapshot ownership gaps. Direct shared readFile await is verified safe, no root edit needed.
- Actual generated viewer preview rechecked200/4953bytes/pinnedscript at127.0.0.1:4173/
  pixelwatch/runs/11-a1/; Codex panel openqueued. Fixture pixels, not live publisher evidence.

The entries below are historical checkpoints, superseded by the facts above.

- Readiness independent final review PASS at fa613922, exactauthoraaf87cb+shared18:45/45
  exit0,2.50s/linttypes0, originalC1/C2/C3 unchangedprobes closed,9sequences×2 normalized
  ac91140a… unchanged,14input boundaries and10broadenedcleanupcases pass;7rawlogs clean.
  Root integrates exactthreefiles, exposes waitForReadiness; wholecheck/browser/simulation
  and actualprojection/deployment/comment integration remain gates.
- Source review has two new P1 blockers at091: Proxy error prototype inspection leaks an
  unhandled rejection and preventsdeadline/worker cleanup; DTOcapture afteranotherawait lets
  actualverifiedsource head or downloadedZIP mutate beforeprivatecopy. Actual local CAS
  storesforgedhead/rejectedgoodpart. A's three original probes fail with reachedcounts;
  B authors testsfirst fixes. GC/reusedcanonicalbyte race is also underfix. Root holds source.
- Comment renderer source3121157 is independently reviewed next byC; local20/20 pass only.

The entries below are historical checkpoints, superseded by the facts above.

- Independent root signal/admission review CLOSED original2P1 plus new native-state/listener
  findings at ec7051e+18d5b89, reviewca030ceb:82/82 at ec,255.73s; new4/4,1.27s;
  original16 plus own9interleavings/9hookvariants reached, fullraw115/58/27 scans clean,
  ambient0. Source diff vs18 empty for covered files. Integrated check/simulation/browser
  and source-job interaction review remain required; no self-approval.
- Readiness immutableaaf87cb dependsrootec+18;45/45 exit0,3.17s/linttypes0/raw32logs clean.
  Independent fa61392 reproduces45/45,2.50s, closes originalC1/C2/C3 sequences and repeats
  original9traces identically (ac91140a…);14input boundaries pass. Broadened hook cleanup
  and final scoped verdict are still pending, so readiness is not integrated/approved yet.
- Root commentrenderer20/20 exit0,1.45s/linttypes0, strict initial11red plus5numeric/partial
  stamp regressions red beforefix. ADR0026 minimal owner correction committed; renderer
  independent review and serialized/live use remain gates.
- Source author is fixing actual reused-blob/GC admission race: initialcanonicalB can vanish
  before current CAS. Root corrected its own overstrict inferred contract: carry accepted-run
  exact existing canonical bytes with bounds, never rehash/decode/overwrite (ADR0010/25).
  Independent A inspects source; no final source approval yet. No full new product simulation.

The entries below are historical checkpoints, superseded by the facts above.

- Source ingestion immutable author091d3a96c11093001c1839a7b0442b68cc38c19b has54/54 local
  tests,12.12s, raw290values/203875bytes clean andlint/types0. Actual same-repo/fork fixtures
  remain local. Root signal followup adoption, independent source security/concurrency
  review and integrated acceptance remain gates; no source job is on main yet.
- Independent rootec review passes82/82,255.73s andoriginal16sequences/raw115 clean but
  finds P2 native aborted-state coercion; actualnumber0 reads1/CAS1/stores3-a1 instead of
  refusal. Readiness author finds native failed-registration listener leak. Root strict
  red tests and shared corrections produce final4/4,1.18s; new independent closure pending.
  Readiness author's35green then45strictred9fail/36pass includes8coercion cases and1shared
  hook failure; own finish-on-remover-failure fix remains within three ownedfiles. No approval.

The entries below are historical checkpoints, superseded by the facts above.

- New prerequisite integration is held for two independently reproduced P1 findings at5cc:
  signal Proxy/plain-shape cancellation bypass; post-CAS checkpoint failure hiding confirmed
  stored/expired truth. Twelve strict red tests allfailed (70filtered diagnostic),23.67s;
  corrected complete admission82/82 exit0,227.41s. Wholetypes/focusedlint0. Root shared
  signal helper and fixed proof warnings are frozen for dependent authors; independent
  original-probe closure and final integrated acceptance remain gates, no self-approval.
- Source job author has45/45 localtests exit0,7.18s; actual forge/core/native worker/local
  and nativeGit paths. Cleanup tests first36pass/2fail, later44pass/1fail; source still
  mutable pending lint/types/shared helper adoption and independent review. Local fixture
  same-repo/fork authentication is not live M2 evidence.
- Readiness author860cf0d passes26/26 exit0,4.14s after independent P2 final-clock finding.
  Reviewer confirmed24existingtests and9deterministic sequences repeated identically,
  plus14input/provenance/HTTPS/error sequences. Later review found native-signal Proxy
  bypass and allocated-deadline leakage from scope construction outside cleanup. Those
  findings remain open; author must use root helper and reviewer rerun original probes.
- Owner approved fixed MVP PixelWatch comment title and bounded display limits, preserving
  config@1. Correction/renderer remain pending; approval alone is not implementation.

The entries below are historical checkpoints, superseded by the facts above.

- Ingress prerequisite source `c2a53a1ab568b7bfe2fb23c0714983b0cbcfa61f` is rebased onto
  merged mainba4831d; source diff from17c5f75 is empty. Complete `pnpm -s check` exited0,
  948tests/49files,278.97s, all lint/types/workflow checks pass. Browser/full simulation and
  independent root cancellation/codec review remain gates. Source-job cleanup DTO is now
  frozen: a disposal failure cannot hide proven stored/expired status and is reported by a
  fixed cleanup diagnostic. Source-envelope validation reuses the existing run validator
  internally; its carrier is never stored/returned/logged.
- Readiness author `ddb42e377b1dc1ff406d2b1e8b2da3778f27fc3a` owns only three files:
  final24/24 exit0,2.59s, focusedlint/wholetypes0 and12retainedlogs scan0. First strict red
  14failed/3passed, later resource-boundary red2failed/22passed; fixed signal/disposal and
  selected-body budget issues without changing limits/assertions. Independent review is
  required before integration. B implements actual source job in isolatedm2-ingress atc2.

The entries below are historical checkpoints, superseded by the facts above.

- PR #21 merged `ba4831dd366463540dd556ccbe576d68400d1f19` at09:39:51Z, exact head
  abd363c/sourcec319ded. Hosted37113159634 Linux/Windows each930/48 exit0
  (37.42/190.98s), complete viewer24/24 each (18.4/26.2s), all required checks/aggregate
  CodeQL pass, no open merge-ref CodeQL alerts. Both full simulations exit2 with2PASS/
  12NOTRUN; all17normalized hashes match local and each other. Independent integrated
  interaction review passed43/4 and18 reached cases,215rawvalues clean, zero ambient
  timing/random calls; reviewer excludes own admission/store. No M2 exit is claimed.
- Root source-job interfaces/ADR0025 are frozen on the next dependency branch. Native
  cancellation tests first10failed/4passed/56filtered diagnostic cases,42.08s, exit1;
  complete admission after correction70/70 exit0,232.69s. Codec diagnostics first4failed,
  exit1,1.35s; final codec/ingestion/metadata20/3 exit0,2.58s, with raw fake-canary/cause/
  accessor/proxy probes. Lint/types initial attempt found one getter annotation and one
  test optional-type issue; corrected verification/independent/fullcheck remain gates.
  These are local tests, not source-job implementation or integrated acceptance.

The entries below are historical checkpoints, superseded by the facts above.

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
Readiness freeze2 is on a separate dependency branch combining metadata1678d59 and
admission author d1b685a (pick5ef5347). Actual shared Readiness DTOs and three fixed error
codes are root-owned. The only dependency addition is existing internal forgeworkspace,
justified in ADR0024; lockfile regenerated offline with no external version change.
Source helper/test implementation is not yet claimed. Its independent security/temporal
review, complete pipeline callers and product simulations remain gates.

The owner approved bounding source verification/download/image analysis by ten minutes,
checking cancellation before every new CAS, and recovering/reporting an already-sent
push under the existing bounded store rules. This is approval of the clarification,
not proof of the still-unimplemented source job or admission cancellation.

Foundation rootbranch c319ded fullcheck is running; stable67 prior908/47 and viewer24/24
pass. Current B d1 independent56/56 passes206.20s plus3original/15extra probes/rawclean;
metadata1678d59 independent28/3 and28actualforge/core probes pass, final scopedverdictpending.
No M2 exit or full14case simulation pass. The historical entries below are superseded.

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

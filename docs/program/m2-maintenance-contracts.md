# W2-M: internal maintenance contract and assignment

Root owns types/errors/exports/manifests/ADRs/docs/integration. Governing documents are
AGENTS,01 §4,03 §§1/5–7,06 §§3–5,07 §4,08 M2.3/M2.5,ADRs0010/0012/0014/0018/0022/0025/0028.
This contract is scaffolding, not completed maintenance or M3 feature work.

`maintainStore(adapter: StoreAdapter, dependencies: MaintenanceDependencies):
Promise<MaintenanceResult>` uses root types in publisher/src/types.ts. Dependencies extend
AdmissionDependencies with the existing Timing.deadline port. No caller run, plan, file list,
generation, write destination, mutation callback or budget override is accepted.

Allowed author files only: publisher/src/maintenance.ts, maintenance-input.ts and
publisher/test/maintenance.test.ts. A separate worktree/branch must use the committed root
freeze; no source-ingress, shared signal/admission, exports or root files are edited. Reuse
actual validated snapshot/candidate helpers, measureSite, planHousekeeping and StoreAdapter.
Do not loosen writeRun/admitRun. Read all malformed/expired input before selecting deletions.

Result status absent/unchanged/updated/recovered has actual tip (null only absent), attempts1–5,
unknownPushes0–5, exact confirmed deleted paths/sizes and removedRuns. Absent/unchanged have
empty deletion arrays. No-change means the observed final snapshot needs no GC; unknownPushes
discloses earlier uncertain writes. Existing absence is not a branch initialization instruction.
Warnings are fixed checkpoint-failed/timing-disposal-failed only. No deployed/served/commented
claim. Capture/copy returned DTOs/native bytes in the resolving reaction before another await;
never inspect public error fields/prototypes or strand settlement on a throwing cleanup hook.

Bound reads/planning/cancellation by one injected600000ms deadline. Private native controller/
intrinsic links, preaborted rejection, partial setup/teardown protected even before dependency
capture completes. Always attempt all acquired removers/disposer. The last pre-CAS check
prevents new writes after expiry. A sent push still recovers truthfully under store bounds.
Checkpoints use existing WriterCheckpoint points. A post-CAS callback failure preserves proven
updated/recovered with a fixed warning; without proof, recover once then refuse without retry.
For no-change/absent return, teardown failure before returning the observed result refuses.

Five leases maximum, existing100*2**(attempt-1)+jitter delays with jitter0–1000 injected.
Privately own the entire candidate before CAS; never share recovery proof maps/bytes with the
adapter. Unknown result needs receipt tip plus full path/byte equality; counters/removed keys
alone are insufficient. After a conflicting or superseded tip, revalidate and recompute from
the same captured config/time/policy. Apply exact GC only, preserve every kept immutable byte,
budget actual final app/HTML/API/blob/derived sizes, and retain conservative measurement bounds.

Tests FIRST, named acceptance:

- "maintenance applies exact real retention and GC without constructing a capture"
- "an absent or already clean store performs no CAS"
- "unknown config store and expired run versions refuse before maintenance writes"
- "maintenance preserves reused canonical bytes without decode or rehash"
- "a conflicting writer is retained when maintenance recomputes under a fresh lease"
- "maintenance recovers only the exact accepted lost-reply candidate"
- "a superseding writer cannot prove an uncertain maintenance transaction"
- "five maintenance conflicts exhaust without a blind force or sixth write"
- "maintenance cancellation prevents new CAS and preserves a proven sent push"
- "post CAS checkpoint and teardown failure cannot conceal confirmed maintenance"
- "hostile metadata methods byte aliases and rejected prototypes remain bounded and secret-free"
- "partial timing acquisition and listener cleanup cannot strand maintenance"

Use actual LocalDirStore and fully isolated native Git repositories for acceptance, committed
fixtures only, no reference reads. Inject deterministic time/seed/barriers; existing no-network
guard; no credentials/ambient clock/random/sleep. Scan complete captured errors/results/store/
logs before output with fake token and signed URL canaries. All named injections must reach.

Handoff: exact base/dependency/source SHAs, clean owned diff, strict red and complete unfiltered
green commands/exits/counts/timings/logs, focused ESLint/wholetypecheck, full raw scans and
remaining gates. An independent reviewer who did not author this code must attack CAS/recovery,
malformed graph/budget/cancellation and cleanup then verify each blocking fix. Root subsequently
runs pnpm check, fullsimulation (honest exit2 until every product case runs), viewer all3engines
and exact-head Linux/Windows checks. No external permissions are needed for this local slice.

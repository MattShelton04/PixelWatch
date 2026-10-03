# ADR 0015: Local simulation infrastructure and honest product coverage

- Status: proposed (owner decisions inferred; scope correction approved by the owner)
- Date: 2026-10-03
- Task / spike: M2.4

## Context

M2.4 is first in M2, but 08's acceptance originally required all 07 §4 product scenarios to run
before their production dependencies existed. The store (M2.2), forge (M2.1) and orchestration
(M2.3) are absent. Viewer and migration scenarios also depend on M2.7/M3.1 and M3.4. The threat
model mostly assigns scenarios to those tasks, but assigns full lease exhaustion/repair and
GitHub faults to M2.4. Its provisional paths create a publisher package before 06 §2 permits one.

On 2026-10-03 the owner approved the minimal correction: implement and test the harness first,
write the future product specifications, report missing adapters explicitly, and keep the full
simulation CI job non-green while any case has not run. Passing a fake implementation of the
publisher would not prove the publisher. Unknown is never safe (01 §4).

The remaining choices below are inferred owner decisions, recorded in the same form as ADR 0014.

## Decision

### 1. Location, specifications and scope

`tools/simulation/` is internal test infrastructure, not a workspace package or shipped code.
`scenarios/<id>.sim.test.ts` contains each of the 11 stable IDs (14 table cases, including A–D).
Each has a written stimulus, real-adapter prerequisites, named barriers/faults and executable
evidence assertions. The index is explicit. A traceability test compares it to 07 §4 and requires
one file per ID. These files are excluded from Vitest's unit discovery deliberately: they are
not `it.skip`/`todo`, and the standalone coverage runner reports each as NOT RUN.

No complete product scenario can run yet. `sim-github-faults` and `sim-lease-exhausted` export
partial, executable harness probes; the runner labels these HARNESS PROBE ONLY. Complete
scenarios keep their original acceptance and become executable with production adapters in
their owning tasks. Full lease exhaustion/repair belongs to M2.3, using the M2.2 writer. Harness
tests add narrowly scoped evidence rather than flipping whole product rules to passing.

### 2. Fake GitHub scope and shape sources

The fake is an in-process request/response transport. Its typed subsets cover repository and
workflow/run/attempt identity, PR/head/base associations, paginated artifact lists/downloads,
comments and Pages metadata/deployment replies. Exact method, URL and canonical request body
identify a fixture. Unknown, duplicate, empty, ambiguous-header, exhausted and unconsumed
fixtures are errors. No fallback endpoint or fabricated association is supplied. Scripted
callbacks allow a fake state mutation before a fixed timeout error, so a later GET can rediscover
an accepted operation. Nothing authenticates a production envelope yet.

Shapes are hand-written from these official GitHub REST docs, consulted 2026-10-03:

- [Workflow runs and attempts](https://docs.github.com/en/rest/actions/workflow-runs)
- [Workflows](https://docs.github.com/en/rest/actions/workflows)
- [Artifacts and download redirects](https://docs.github.com/en/rest/actions/artifacts)
- [Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [Issue comments](https://docs.github.com/en/rest/issues/comments)
- [Pages and deployment replies](https://docs.github.com/en/rest/pages/pages)

These are typed subsets, not purported recordings or complete generated REST schemas. IDs are
REST numbers here; the future forge validates/converts them to decimal contract strings.
`route()` is the replacement boundary for future redacted recordings; none are invented now.
The harness download probe uses manual redirects, strips auth on origin changes (and never
reattaches it), allows only registered HTTPS `.invalid` origins, caps redirects at 3 and attempts
at 3, advances injected time for bounded retry delays, and reports missing outcomes explicitly.
Those are harness defaults, not a new production retry policy.

### 3. Real Git against fully isolated temporary bare repositories

Use installed Git with argument arrays and no shell. A generated `pixelwatch-simulation-*`
directory under the OS temporary root holds the remote and each writer's bare repository. No
checkout, repo `.git`, repo remote, branch setting or token is used. All commands run beneath
that generated root. The API accepts only the fixed data ref, validated OIDs and flat regular
fixture files. It uses `hash-object --no-filters`, `mktree`, parentless `commit-tree`, depth-1
fetches, `cat-file`/`ls-tree` and explicit expected-SHA/expected-absent leases.

The environment copies only OS executable/runtime/temp keys. HOME, USERPROFILE and XDG config
point inside scratch; global/system Git config are empty and system attributes are disabled.
Inherited Git overrides, SSH settings, tokens and credentials are never read or copied.
Hooks and templates use empty directories; receive-pack's hooks are pinned too. Credential
helpers, signing, SSH, recursive submodules and external protocols are disabled; only the local
file protocol is allowed. There is no index/checkout to run filters, links or executable tree
content. Fixed author/committer/time and explicit SHA-1 object format make object IDs repeatable.
Raw Git diagnostics are discarded; normalized traces never contain temporary paths. Canary
content is refused before any object write. Cleanup verifies the absolute generated target is
inside the temporary root before removing it.

This is a test remote, not the marked production store adapter. Flat fixture files are enough
to prove real lease mechanics; M2.2 implements and tests the production tree/ref checks.

### 4. Fake static/CDN transport

Use an in-process static origin and independent edge/path caches, rather than HTTP sockets.
This preserves the no-network contract and makes timing independent of OS sockets. Deploys
replace origin bytes; already cached bytes remain until injected time expires their TTL.
Removed registered paths return cacheable 404s. Explicit scripts can regress to older bytes,
serve mixed generations and return negative-cache entries after a pass; exhausted scripts fail.
Unknown paths, unsafe paths and ambiguous scripts are refused.

TTLs are 0, 60, 600 and 900 seconds. 600 is the S2 observation (ADR 0005), not a guarantee.
The fake models served bytes; it does not implement the M2.3 three-consecutive readiness policy
or the M3.1 browser reload policy. Those assertions remain in the product specifications.

### 5. Scheduling, barriers, seeds and time

Actors are cooperative generators yielding named checkpoints, with explicit barrier membership.
No actor crosses a barrier until every named actor has arrived; reuse/duplicate arrivals fail.
Ready actors are sorted before a documented xorshift32 selection. Fixed seeds are 1, 42,
0x5eed1234 (1592594996) and 0xffffffff (4294967295). Registration order and OS process completion
never choose the schedule. Git operations finish within a selected checkpoint. A maximum 1024
steps bounds schedules; lack of a runnable actor is a deterministic deadlock, not a timer.

The clock starts at 2000-01-01 UTC and only `advance(integerMilliseconds)` changes it. No real
sleep, wall-clock timeout or Math.random is used in simulation logic. The simulation describe
disables Vitest's inherited deadline (`timeout: 0`); step and fixture bounds decide failures.
Existing Actions process watchdogs never decide simulated retries or readiness.

### 6. Failure injection and evidence

Fault plans match actor + named point + occurrence. Duplicate plans and invalid occurrences
fail; each expected injection must be reached, not merely registered. Effects distinguish
conflict, failure before acceptance, acceptance with a lost reply, cancellation after acceptance
and stale observations. Callers implement the effect at the checkpoint; no product logic is
hidden inside the injector.

Self-tests force both readers into an open race window before reaching each named point for
each seed, replay complete traces, and fail on deadlock, unused injection or exhausted steps.
This proves the hooks/scheduler can reach those windows, not that absent production code is safe.
The real Git probe forces five stale leases for every seed: A fetches, B commits/pushes, then A
pushes that stale lease. Barriers guarantee the harmful ordering; assertions require five
rejections and B's final bytes. The accepted-push probe discards the successful reply and
refetches the accepted object. GitHub faults verify exact bounded request counts and clock
advances. CDN probes verify older-after-newer, mixed-file and cached-404 behavior.

The four scheduler trace hashes and a fixed parentless Git commit OID were recorded by running
the harness on 2026-10-03 and are asserted in both CI platforms. The lease probe prints a digest
of all normalized schedule/injection/push traces, so repeated full command outputs can be
compared byte for byte. Failures identify the failing seed even outside a scheduler checkpoint.

Fake canary token and signed URL strings stay in memory. Capture redacts tokens, signed URLs
and encoded forms before logs, summaries, errors or stored output; independent assertions scan
captured outputs, normalized traces and temporary files. Git/CDN refuse canary data before a
write. The runner loads the existing no-network guard first. Tests also forbid ambient time,
randomness, sleeps and token-variable reads in harness source.

### 7. Runner output and exit codes

`pnpm test:simulation` runs real harness checks, then prints every listed product case and its
missing prerequisites. It prints the seed set, separate harness/product totals, and
`PRODUCT COVERAGE INCOMPLETE`. It emits no timing or platform-dependent paths.

| Code | Meaning |
|---|---|
| 0 | Reserved until every registered product case actually runs and passes; unreachable in M2.4 |
| 1 | Failed harness check, invalid/empty manifest or internal error; wins over incomplete coverage |
| 2 | Harness checks ran, but one or more product cases did not run |
| 4 | Usage or help; explicitly says no scenario ran |

There is no filtered success mode. The runner cannot silently omit an ID; its manifest and 07
are checked. Harness evidence passing inside `pnpm check` does not imply scenario acceptance.
Later tasks must wire actual production adapters and retain failure/incomplete precedence.

### 8. CI and dependencies

Add a separate `Simulation coverage` matrix job to `ci.yml`, Linux and Windows on every PR,
main push and dispatch. Reuse the existing SHA-pinned checkout, pnpm and Node actions. Give
only `contents: read`; persist no checkout credentials and use no caches or suite credentials.
The job runs the unfiltered command, preserving exit 2 as a failed coverage check while adapters
are unavailable. No `continue-on-error`, required-check change or GitHub setting change.

`pnpm check` continues to run actual harness unit/security tests, lint, types and workflow lint.
No new runtime dependency or devDependency is added. Node, installed Git, existing Vitest and
the existing schemas canonical serializer are sufficient. Core and all recorded goldens stay
unchanged.

## Consequences

- M2.4 infrastructure can be reviewed before the missing product implementation, without claiming
  that its end-to-end acceptance has passed.
- Full simulation CI is intentionally non-green until all listed cases execute, including M3
  viewer/migration cases. This cost was explicitly approved, not hidden with a successful wrapper.
- 06, 07, 08 and AGENTS.md describe the location, corrected acceptance and command semantics.
  Threat-model paths move together; complete production assertions stay planned with their real
  owner tasks, and narrowly scoped harness assertions cite exact runnable titles.
- Future adapters consume these fixtures, checkpoint hooks and assertions; they do not replace
  them with a second publisher implementation. Genuine product scenarios must report their
  full variants and capture outputs when activated.
- No security-model, schema, API bytes, core behavior, release or GitHub setting changes.

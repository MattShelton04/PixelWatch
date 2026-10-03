# M2.3 readiness contracts — freeze 2

Root owns the actual Readiness types, diagnostic allowlist, publisher manifest/lockfile and
exports. Base source combines67f1ddc, reviewed admissiond1b685a and metadata1678d59.
The owner approved bounded source work and truthful recovery of already-sent pushes; its
admission cancellation implementation is separate from read-only readiness.

## Function and ownership

`waitForReadiness(input: ReadinessInput, dependencies: ReadinessDependencies): Promise<ReadinessResult>`.
Authoraudit_m2_m3 owns only publisher/src/readiness.ts, readiness-input.ts and
publisher/test/readiness.test.ts in an isolated worktree. Root integrates the export when
actual source exists. Author cannot approve their own code. Former admission author performs
independent security and temporal correctness review after final authorSHA.

## Invariants

- Capture input/dependency parents and methods exactly once before firstawait. Intrinsic-copy
  bounded native bytes. Never call supplied urls/map/bind/iterators to build destinations.
- Validate generated site/latest schemas and all identity metadata before GET: numeric target
  IDs, run key/head, repo/prefix/release, internally recomputed generation from actual nonnull
  store/config/release OIDs. Expected target must match its actual built pointer/site stream.
  Upstream defers pointer/current-head mismatch; helper never rewrites frozen pointer bytes.
- Ignore supplied site.urls methods; derive HTTPS GET URLs only from captured trusted Pages/
  config and fixed path builders. No auth/cookies, redirect following or cache-buster claims.
- Capture expected site/latest native bodies at most1MiB and verify their actual SHA against
  assembled hashes. Returned200 bodies must match exact hashes and schema identity; equivalent
  fields with different bytes fail. Unknown versions fail; unsafe/oversized inputs refuse.
- All requested pointers must pass in a fullpoll. Failures/reset, pending and served use only
  fixed codes. Poll callbacks receive bounded separate frozen DTOs. No raw exception causes,
  bodies, Location headers, signed URLs or tokens enter results/errors/logs.
- Overall600000ms, request min(60000ms, remaining), at least10000ms injected spacing after
  prior completion; max61fullpolls. Monotonic finite nonnegative clock, bounded progress.
  Race request and delay against injected abort/deadlines even if callbacks ignore signals.
  A third pass completing at/after deadline is pending. Cancellation cannot claim served.
- Result contains separate served/pending state, fixed reason, generation, count, elapsed
  and at most61privatepoll records. It contains no deployment or comment success claim.
- Use actual assembleSite fixtures. No fake publisher or new manifest. No real sleep/time/
  Math.random/credentials in simulations. Scan complete raw result/error/store outputs.

## Named acceptance and handoff

Tests first: threefullpolls/spacing, resets for oldgeneration/mixedpointer/wrongdigest/404;
all selected pointers; trustedURLderivation; coherent capture; unknownexpected versions/
provenance refusal before requests; ignored transport/delay abort; deadline boundary;
cancellation; observedserved despite failed/cancelleddeployment; fixed raw diagnostics;
invalid clock and every reached injection. Use exact proposed titles from preparation.

Run unfiltered readinessfile, focusedlint and wholetypes; provide firststrictred and finalgreen
logs/counts, immutableSHA, raw scans and reachedcounters. Independent hostile/stale/cancellation
probes and final rootfullcheck/fullsim/all3browser/hosted follow. No product scenario pass or
M2 exit until actual caller/deployment/comments/live served evidence exists.

# M2.3 source ingress contracts — frozen root DTOs

Dependency branch0179b2e plus root ADR0025 cancellation/codec correction. The actual
types live in publisher/src/types.ts. This freeze is an implementation inference; it does
not prove the absent source job. Root owns types/exports/manifests/ADRs/integration.

`ingestJob(input: SourceJobInput, deps: SourceJobDependencies): Promise<SourceJobResult>`
owns source authentication through durable admission. Author owns only ingest-job.ts,
ingress-input.ts, staging-pool.ts and ingest-job.test.ts. No output writer/deploy/comment,
workflow/action, release or root/shared edits. Export integration is root-owned.

## Required behavior

- Capture trusted context, event bytes (<=1MiB), all port parent objects/methods and optional
  checkpoint/signal once before any await. Use native byte copies and Reflect.apply with
  original this; never supplied map/bind/iterator/URL destinations. Fixed safe errors only.
- Start one injected600000ms deadline covering verifySource/list/download/stored snapshot
  reads/ingestion/analysis/worker close. Race ignored signals at asynchronous boundaries;
  pass combined native signal through forge/core/worker. Dispose the deadline and close the
  worker on all paths, including refusal. Simulations inject codec/timing; no ambient timer,
  Date.now, Math.random, real sleeps, credentials, network or .reference.
  Always invoke captured deadline disposal. Before proven admission, disposal failure refuses
  with a fixed timing category; after a proven stored/expired result, preserve that truth and
  add the fixed `timing-disposal-failed` cleanup diagnostic. No raw cause/message survives.
- Call actual verifySource with captured config/configCommit/releaseCommit/event, verify
  returned envelope schema and repository/config/release provenance against captured context.
  PR association/target/commits come only from the authenticated envelope, never bundle claims.
  SourceEnvelope is a component of run@1. An internal zero-result validation carrier may
  reuse the existing run validator's component/semantic checks; it uses only the copied real
  envelope and internally fixed versions/key/unknown expected-part coverage, and is never
  stored, returned or logged. Actual buildRun still validates the final produced run.
  Unknown policy/source/store versions refuse before mutation. Read an actual validated
  snapshot for canonical reuse; bound/capture its graph/listing/reader, using existing helper.
- Call actual listArtifacts once for the verified run. Feed the full listing into generic
  core selectArtifacts, preserving original forge descriptor identity. Download only unique
  selected expected parts; unrelated/duplicate/nonselected artifacts stay unopened. Pass
  full listed metadata to ingestArtifacts with successful downloaded ZIPs; never fake empty
  archives for unavailable parts. Authenticate downloaded ID/name uniqueness before ZIP reads.
- Stage only canonical new blobs in a private bounded map. Existing canonical paths use the
  validated listing for has; never overwrite, rehash or decode solely for reuse (ADR0010).
  Read/decode reused blobs only when actual comparison requires their pixels. Use exact
  native staged bytes/private reads and enforce existing STORE_LIMITS. No durable mutation
  occurs until actual admitRun. Unknown selected bundle preflight precedes every sibling's
  pixel decode/staged add. No weakened profile/budget/golden/partial-pass rule.
- Production uses actual PngWorker. Await one decode/encode/compare at a time. Comparison
  keys and policy derive from actual ingestion and comparatorPolicy(config version/default1).
  Build run with buildRun and internally fixed versions: bundle1/data1/config1/comparator1,
  publisher from trusted assets.release. No caller run/analysis/status override. Close the
  worker before attempting admission so a cleanup failure cannot conceal a successful write.
- Call actual admitRun with captured trusted context/admission metadata/state and combined
  signal. Its native cancellation preflight applies to each NEW CAS; already-sent accepted/
  unknown replies recover under existing bounds. Never claim mutation did not happen after
  a sent push. No new CAS after cancellation. Source-stage failure cannot expose raw callback
  fields/causes; private known errors may retain fixed categories.
- SourceJobResult separates actual admission from pending/not-retained projection. Diagnostics
  carry bounded fixed source/download/ignored categories and numeric IDs/counts, never signed
  URLs/raw artifact names/callback messages. No deployed/served/commented claim.

## Acceptance and handoff

Tests first: actualforge API fixtures→core ingestion/comparator→actualLocalDir/nativeGit
store; no-usable artifact; missing/expired/duplicates/ignored coverage; selected-only opaque
descriptor identity; hostile traversal/HTML/unknown bundle/source/store/config refusals with
zero durable writes; source/PNG/compare ignored-signal cancellation and reacheddeadline;
canonical reuse without encode/redecode; byte/private input mutation across awaits; worker
close before CAS/all paths; conflicting CAS and lost reply/status truth; fixed raw errors
and scanned results/store bytes. Use all named injections and fake canary/signed URL values.
Run the unfiltered authored file, focusedlint/wholetypes, record exact red/green exits/counts/
SHA and raw logs. Root runs fullcheck/simulation/browser and updates threat rows in the slice.
Independent reviewers inspect source and force harmful interleavings before integration.

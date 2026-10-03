# ADR 0028: Internal maintenance without a synthetic capture

- Status: inferred implementation contract under ADR 0014; implementation pending
- Date: 2026-10-03
- Task: M2.3/M2.5

## Context

03 §5 requires workflow_dispatch GC and repair without captures. The ingestion job has
contents:write; the serialized projection job has contents:read. `ingestJob` authenticates
workflow_run capture input and cannot fabricate a run for maintenance. Core already supports
`planHousekeeping` without newRun. M3.4's public maintenance framework remains gated by M2.

## Decision

Implement a narrow internal `maintainStore` transaction in the ingestion job. Capture trusted
context/time/PR-state/pin/port inputs once. Read and validate every existing record/file before
selection, measure actual release site bytes, and apply only the exact real planHousekeeping
GC candidate under an expected-tip lease. No new capture, classification, arbitrary deletion
callback or production data version is introduced. An absent store returns absent without
creating a branch; adoption starts with an actual capture. No-change plans write nothing.

Use existing five-attempt deterministic backoff bounds and exact adapter-computed receipt plus
entire candidate/refetch equality for unknown-push recovery. A newer tree cannot prove this
maintenance transaction. Recompute after conflicts or unproved supersession under a fresh
lease. Report observed unknownPushes even if a later validated snapshot needs no further GC;
never equate an unchanged final snapshot with proof that no earlier push landed. Only updated/
recovered results report the exact confirmed transaction's deleted paths/run keys.

Cancellation refuses each new CAS while an already-sent push completes bounded recovery.
The injected ten-minute deadline and private signal links bound read/planning work. Post-proof
checkpoint or teardown failures preserve truthful results with fixed warnings; unproved
failures refuse without another write. Every allocated deadline/link is cleaned up. Existing
validated immutable records/canonical bytes remain unchanged; no decode or rehash solely for
reuse. Unknown versions/budget conflicts refuse before mutation.

## Consequences

The subsequent projection still resolves fresh config/store only after its workflow lock.
This is internal MVP repair wiring, not a public CLI, migration/import framework or production
v2. No dependency, permission, schema or golden changes. Root freezes DTOs and the ownership/
acceptance contract before assignment. Tests first, independent security/concurrency review,
integrated/hosted checks and real dispatch repair evidence remain required.

# ADR 0018: Validated store adapters and bounded leased ingestion

- Status: accepted (inferred implementation details under the authorized MVP program)
- Date: 2026-10-03
- Tasks: M2.2, M2.4 activation

## Context

03 requires marked, repository-owned stores, parentless Git commits, explicit expected-tip
leases and bounded recovery. The complete retained graph must validate before mutation,
including records a subsequent retention plan would expire. M2.4 supplied infrastructure,
not a production writer or passing product scenarios.

## Decision

Implement local-dir and Git data-branch adapters with the same complete candidate/snapshot
contract. Privately copy bytes, metadata and accepted run inputs before asynchronous work.
Refuse links, hardlinks, executable paths/modes, unknown versions, unmarked existing content,
foreign repository identity and writes to the default branch or non-allowlisted refs.

Use sanitized native Git plumbing with empty templates, disabled hooks/config/helpers,
filters and submodules, an allowlisted remote/ref, parentless commits and explicit leases.
Fetch only the selected tip at depth one through bounded smart-protocol v0 negotiation.
Stream and validate packet/PACK bytes before trusted indexing: compressed bytes plus index
reservation are bounded, as are object count, object/aggregate expansion and delta depth.
Thin/reference deltas, tags, malformed headers and unexpected redirects refuse. Refused
HTTP body cancellation keeps its injected deadline until cleanup succeeds or abort occurs.

`writeRun` admits one immutable run and its canonical blobs; it recomputes against the latest
validated snapshot at most five times. A lost push reply triggers refetch before retry; a
matching immutable run proves normal admission. Its callback cannot omit/replace that run
or change the accepted timestamp. All errors are fixed diagnostics, without native Git or
credential-bearing response text. No new trusted-path runtime dependency is introduced.

Activate the existing CAS-race and unknown-push cases through these production implementations
and real isolated temporary Git repositories. Every seed executes twice with exact normalized
equality, original scenario assertions and reached named injections. The asynchronous full
runner scans raw evidence before redaction and preserves exits 1/2/0 for failure/incomplete/
all registered cases passed. All eleven IDs and fourteen cases remain visible.
Before any injected callback or await it privately snapshots the complete flattened manifest,
original verifiers, prerequisites, fixed seeds and harness checks. Callbacks cannot shrink the
coverage denominator, replace an acceptance assertion or turn a later harness failure into a pass.
Each returned driver DTO is privately cloned once before scanning, verification, replay comparison
and hashing; a getter or later mutation cannot substitute unscanned bytes for the validated trace.

## Consequences

Git pack limits bound logical bytes and expansion, not measured peak process memory or
filesystem allocation units. Linux/Windows native behavior and normalized replay equality
require actual hosted evidence; Windows-only checks cannot establish platform agreement.
No goldens, schemas or changes@1 bytes change. Other twelve simulations remain incomplete.

ADR 0012 permits an old late incoming run to expire during admission. M2.3 will provide a
separate controlled admission outcome from `planHousekeeping.newRunExpired`, exact candidate
bytes and expected-tip receipts. An absent run key cannot prove such an unknown push accepted.
Foundation `writeRun` stays strict; no arbitrary omission flag or production v2 is introduced.

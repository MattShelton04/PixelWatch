# ADR 0022: Controlled publisher admission and exact site assembly

- Status: accepted (owner budget clarification; other details inferred under ADR 0014)
- Date: 2026-10-03
- Tasks: M2.3

## Context

The implemented store and final viewer now supply validated durable snapshots and actual app/
entry bytes. Publisher assembly must account for those exact files. Core planning uses
conservative fixed metadata bounds, not future tip values. ADR 0012 permits an old late run
to expire in its admission transaction; strict foundation writeRun correctly rejects arbitrary
accepted-record removal. An absent expired run key cannot prove an uncertain push succeeded.
03 §1's 400/500 MiB prose conflicted with existing config@1/core configurable limits to 1 GiB.

## Decision

The owner approved clarifying 400/500 MiB as defaults, preserving existing trusted configurable
limits. No schema, golden, limit or assertion is changed to make an acceptance test pass.

Freeze `docs/program/m2-publisher-contracts.md`: separate complete post-GC assembly from
pure real-renderer sizing and controlled durable admission. Derive generation internally from
actual captured store/release/config OIDs; pre-CAS measurement uses only a fixed-width sizing
placeholder. Privately capture all inputs/returned bytes before async consumption. Eagerly
validate complete graphs and unknown versions before selection. Emit only allowlisted generated
files and validated referenced stored data, with exact internal categories and byte hashes.
Existing canonical bytes and ADR 0010 reuse remain unchanged. No retained-data pruning by
the read-only projector.

Keep writeRun strict. Separate admitRun invokes actual config-derived housekeeping and applies
only its validated GC result. Expired transaction recovery requires the adapter's own attempted
commit ID and complete private candidate-tree byte equality on refetch. Superseding writers
force recomputation under a fresh lease; missing receipts/absent keys never prove success.
Bounded five attempts, original injected time, immutable retained records and protected budgets
remain unchanged. No new runtime dependency, schema version or production v2 is introduced.

## Consequences

Assembly is neither deployment nor readiness/comment evidence. Exact totals can be smaller
than conservative planning totals; they must not exceed the proven bound. Read-only type
annotations are not ownership proof, so later output writers and readiness consumers recapture
bytes and validate digests. Local assembly/admission acceptance and adversarial review precede
orchestration, live same-repo/fork tests and M2 exit. Unknown expired admission may remain
unconfirmed after bounded retries rather than report success without evidence.

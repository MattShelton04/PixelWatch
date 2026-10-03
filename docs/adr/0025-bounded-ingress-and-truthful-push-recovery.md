# ADR 0025: Bounded ingress and truthful push recovery

- Status: accepted (timeout clarification approved by owner; implementation details inferred under ADR 0014)
- Date: 2026-10-03
- Task: M2.3

## Context

02 §5 requires a ten-minute ingestion bound. A Git push can succeed when cancellation
arrives; 03 §6 requires bounded refetch/recovery and cannot safely undo that push. Source
ingress now depends on real forge descriptors, core metadata ingestion, worker ports and
durable admission. Reading public injected PNG error fields can leak callback data into
persisted part diagnostics or raw causes, even if outer summaries later redact them.

## Decision

The owner approved on2026-10-03: bound source verification/download/image analysis by ten
minutes, check cancellation before every new CAS attempt, and recover/report an already-sent
push using the existing bounded store rules. Do not undo a successful push or begin a new
CAS after expiry. Accepted and exactly recovered replies retain truthful stored/expired
status. Unproven unknown replies after cancellation refuse without retry writes.

Implementation inferences: capture the supplied in-process AbortController signal once;
reject Proxy signals before any traps, copied plain shapes, non-boolean native state and
accessor-backed own symbol state. Use captured native getters/EventTarget operations and
require the exact local AbortSignal prototype. Node's getter alone is not a sufficient
boundary: it accepts proxies and shapes and coerces malformed native boolean storage. Inspect
the captured own Node kAborted symbol's data value before that coercion; absence refuses.
This policy assumes a trusted adapter constructs
the controller; it is not an unforgeable JavaScript identity claim. Check before each attempt and immediately after the
last pre-CAS checkpoint. Preserve existing five-attempt/receipt/tree recovery limits. Freeze
SourceJob types and `m2-ingress-contracts.md` before dependent authors consume them. Use the
existing forge Timing deadline port and private staged canonical blobs; no external dependency.
Always invoke captured deadline disposal. A disposal failure before proven admission refuses
with a fixed category; after proof, preserve stored/expired truth and report a fixed cleanup
diagnostic. Reuse run@1 validation as an internal carrier for its existing SourceEnvelope
component checks; never store/return/log the carrier or invent an envelope. A post-CAS
checkpoint exception must not hide an accepted write. Unknown outcomes still undergo bounded
recovery; a proven result retains stored/expired status with the fixed optional admission
warning `checkpoint-failed`. Without proof, checkpoint failure refuses before any retry.
Native EventTarget registration can insert before its listener hook throws. On registration
failure, remove that exact callback with the captured native remover before refusing. A
throwing removal hook is contained; native unlink precedes that hook in the pinned runtime.
No raw exception survives. The previous sanitization test's after-CAS expected refusal was
corrected to assert stored truth plus this warning and actual persisted bytes, following the
owner's recovery decision; its pre-CAS failure assertions remain unchanged. These are inferred
implementation details, not additional owner approvals or schema changes.

Carry exact initially validated canonical bytes for reused blobs referenced by the accepted
run into the bounded private admission input. A concurrent writer can GC them before the
admission read; omitting those bytes can lose an otherwise valid ingestion. This corrects an
overstrict inferred ingress contract, preserving ADR0010/03 §4: no hash verification, decode,
reencoding or overwrite solely for reuse. Only accepted-run references are carried.

Authenticate codec diagnostic codes with a private constructor identity and finite existing
code set. Ingress creates fresh fixed diagnostics without raw callback causes or public
error fields/prototypes. Unrecognized codec exceptions refuse the ingestion. Legitimate
PNG refusal codes and existing part diagnostic text remain stable. This is a boundary fix,
not owner approval of a new algorithm or policy.

## Consequences

Cancellation remains observable; a deadline cannot turn stored data into a false failed-write
claim or start more writes. The source job closes its worker before admission and emits only
stored/expired plus projection pending/not-retained, never deployed/served/commented. Existing
schemas, run/changes goldens and comparator-v1 are unchanged. Injected clock/codec/deadline
ports keep simulations deterministic and network-free. Exact final independent review and
integrated acceptance still apply; this ADR alone proves no implementation.

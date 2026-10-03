# ADR 0016: MVP audit corrections and unavailable source provenance

- Status: accepted for explicit owner decisions; delegated/inferred details identified below
- Date: 2026-10-03
- Task: MVP audit and M2.1/M2.2 prerequisites

## Context

The program starts at main `59221ba4bfd3b8214440990e5c044503e9c53049` after M2.4.
Read-only audit found three conflicts: ADR 0007's original-run versus attempt timestamp;
unknown selected bundle schemas becoming part-scope incomplete runs despite 01 §4.2;
and 05's current-head run selection versus ADR 0013's frozen newest-stream pointer.

Required root capture workflow SHA/ref are also absent from recorded REST authority.
AUDIT-B queried S11 run `36841473039` read-only on 2026-10-03: run, attempt 1, attempt-1
jobs, workflow `371067781`, check suite `99783578268`. Queries succeeded through permitted
read-only execution after the restricted proxy failed. None supplies root workflow SHA/ref.
Their head_sha is H2 `64d0906…`; recorded capture executed merge `72d8928…` (ADR 0007).
referenced_workflows is empty. The check suite now names H3/base M4, so its current PR
association cannot establish the historical event base.

Official sources inspected by AUDIT-B and independent AUDIT-C:
[run attempts](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt),
[jobs](https://docs.github.com/en/rest/actions/workflow-jobs#get-a-job-for-a-workflow-run),
[workflows](https://docs.github.com/en/rest/actions/workflows#get-a-workflow),
[check suites](https://docs.github.com/en/rest/checks/suites#get-a-check-suite),
[OIDC claims](https://docs.github.com/en/actions/reference/security/oidc).
Called-workflow sha/ref are not root-workflow authority. Source OIDC requires id-token:write,
outside capture's fixed read-only model. Copying another SHA or a claim fabricates provenance.

Independent review reproduced lazy graph validation accepting an unknown expired run
and deleting it during GC; expired grace references to missing blobs also evade checks.
Both violate ADR 0012 §7: malformed references are errors, never deletion candidates.

## Decision

### Explicit owner responses, 2026-10-03

1. source.createdAt uses the original runs/{id}.created_at, constant across attempts.
   Numeric attempt remains the history-order tiebreak; publisher finish time is irrelevant.
2. Defer comments with a diagnostic if the projected latest pointer does not name the
   newest eligible current-head run. Preserve the canonical pointer and changes@1 bytes.
3. workflowRef/workflowSha become optional independently corroborated provenance. Omission
   means unavailable. Keep and validate known values. Never synthesize either from another
   SHA/ref or capture claims. Forge returns a separate bounded
   source-workflow-provenance-unavailable diagnostic for the summary. Repository/workflow/
   run IDs, attempt, event/ref policy, association, target and baseline still authenticate.

### Delegated choice and inferred implementation details

The owner delegated unknown-bundle handling, requesting flexibility. The orchestrator chooses
the following under normative 01 §4.2; this is delegated judgment, not an exact owner selection.

- Unsupported bundle.json schema in a selected expected part refuses the whole ingestion
  with ingest-unsupported-version before any sibling decode/blob write. Other malformed
  parts remain explicitly incomplete. Name-excluded artifacts remain unopened, including
  other attempts/providers/shards/name versions, unrelated files and duplicate selections.
  Future compatibility requires an explicit writer update, never a silent default.
- Prepare selected ZIP/manifests/identity/file sets before admitting any pixels. Each JSON,
  ZIP entry and PNG is read/inflated once, preserving ADR 0010. No golden changes.
- Eagerly validate every indexed run and existing grace namespace reference before retention.
  M2.2 also validates bytes, schemas, modes and the complete graph on each read. Existing
  blob reuse is untouched: no decode/hash recomputation (ADR 0010).
- IngestInput.deadline accepts an injected AbortSignal; absent injection retains the real
  production 600,000 ms deadline. Simulations supply virtual deadlines and deterministic
  in-process codecs rather than PngWorker's real isolation timers. Cancellation still refuses.

## Consequences

- Amend 02 §8, 05 §2 and ADR 0007/0011 pointers; correct stale status, nine-schema count,
  converter/S11 header and evidence paths. Licence, reuse and settings decisions remain settled.
- run@1 changes before any release. No migration: existing known values stay valid and no
  stored record is rewritten. Executed capture provenance never chooses publisher code;
  trusted publisher code still comes solely from its own SHA-pinned self-checkout. 01 §4 unchanged.
- projectChanges excludes both fields. Compare all four recorded projections with/without
  provenance and the exact golden tree. No changes.json byte change or golden regeneration.
  Inlined served schemas do change unused SourceEnvelope definitions, disclosed here.
- Regenerate types. Exact regression titles map to R4.2-05/R4.3-03/R4.3-08/R4.5-05.
  Real forge unavailable-provenance tests remain planned until M2.1 executes them.
- The full MVP, all product simulations, browser/live/release/canary/adoption gates remain open.
  Benchmark overview/table discrepancies need original measurements; no new numbers are inferred.

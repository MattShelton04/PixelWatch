# ADR 0019: Authenticate source attempts without inventing provenance

- Status: accepted (owner choices and inferred implementation details distinguished below)
- Date: 2026-10-03
- Task: M2.1b–c source authentication and default-branch configuration

## Context

01 §4.3–4.4 require a REST-corroborated source envelope, exact selected attempts,
unambiguous PR association and historical baselines. The eight committed S11 recordings
separate PR head, event base and merge base. They do not authenticate the executed root
workflow SHA/ref. A comparison can disappear while the authenticated run still exists.

## Decision

The owner chose the original run's `created_at` for ordering and approved omitting unavailable
workflow SHA/ref with a diagnostic (ADR 0016). Numeric attempt remains the tiebreak. These
choices do not authorize filling unavailable fields from PR head, called workflows or claims.

The following are inferred implementation details under the authorized MVP program:

- Validate and privately capture config, trusted config/release SHAs and event bytes before
  awaits. Read repository, original run, exact selected completed attempt and workflow through
  bounded repository-scoped GET routes. Payload and REST identity, event, ref, target and
  association facts must agree; an original run advancing to a later attempt does not invalidate
  an already completed selected attempt.
- Corroborate the single PR against bounded commit-association pages and a current PR read.
  Zero, multiple, disagreeing, deleted or unavailable historical associations remain history
  with a fixed diagnostic and no guessed PR/baseline. A changed historical base defers
  association. Authentication, malformed responses, network and server failures refuse.
  Only a historical lookup's 404 means unavailable; it is not a generic error fallback.
- For PR captures, retain event base separately and use its merge base with the authenticated
  head. Never substitute today's default-branch tip or a merge ref. Report a stale identifiable
  current head separately. Default-branch pushes use their first parent; initial commits have
  no baseline. Capture dispatches never join a PR.
- Root workflow provenance stays absent with `source-workflow-provenance-unavailable`.
  Fields are validated during assembly; M1.5 `buildRun` validates the complete run before
  storage (publisher wiring remains M2.3). Source verification performs no artifact download
  or external mutation.
- Resolve policy through a fresh repository read bound to the constructor's numeric repository
  ID and namespace, then only that repository's validated default `refs/heads/` ref. Capture
  its commit OID and fetch only `.pixelwatch/config.json` with raw media at that immutable SHA.
  Never follow repository/ref URL claims, checkout adopter files, execute policy, use defaults
  on errors or read the policy at a moving ref. Strict 1 MiB parsing and version dispatch precede
  mutation. Projector must call this reader after the site lock (M2.3).

## Consequences

No canonical changes@1 bytes, dependencies or trust boundaries change. Historical runs can
remain useful without a commentable association. Fifteen source tests replay recorded identities
and hostile synthetic variants; supplemental workflow/parent shapes are identified as synthetic.
They are not live fork evidence. M2.1c binds configSha to a fresh default-ref resolution;
publisher must still enforce head/order/readiness immediately before each comment mutation.

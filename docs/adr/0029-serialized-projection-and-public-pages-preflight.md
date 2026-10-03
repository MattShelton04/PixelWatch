# ADR 0029: Serialized projection and public Pages preflight

- Status: inferred implementation decisions under ADR 0014; implementation/review pending
- Date: 2026-10-03
- Tasks: M2.3/M2.5, with live proof in M2.6

## Context

01 §4 and03 §7 require config/store reads after one workflow-held lock, official Pages upload/
deploy, observed readiness and all retained PR reconciliations in the same job. Ingestion is
already durable and must never be cancelled by that lock. The owner approved pointer-mismatch
deferral and optional unavailable provenance in ADR0016/19. Unknown versions refuse before
mutation. These decisions are not reopened here.

The normative project token does not include Actions read or Deployments read. The MVP scope
is public GitHub.com repositories. Primary REST documentation permits public unauthenticated
[environment](https://docs.github.com/en/rest/deployments/environments),
[branch-policy](https://docs.github.com/en/rest/deployments/branch-policies),
[deployment](https://docs.github.com/en/rest/deployments/deployments),
[status](https://docs.github.com/en/rest/deployments/statuses) and
[attempt-job](https://docs.github.com/en/rest/actions/workflow-jobs) reads. A separate fixed-
destination adapter can therefore preserve the exact token permissions. Public reads have a
60-request/hour originating-IP primary limit; failures/limits must refuse or report pending.

Read-only discovery maps all14 recorded S2 deployments uniquely to exact attempt-job URLs
through status log_url/target_url. Same-SHA deployments belong to distinct jobs; empty payloads
contain no run identity. Operator CLI reads do not prove normative token access or early current
deployment visibility. Historic status retention also cannot prove old missing history unused.

## Decision

The reusable workflow's sole project job uses the fixed cross-release group
`pixelwatch-project-${{ github.repository_id }}`, with `cancel-in-progress: false`. PixelWatch
owns the whole Pages site in the MVP, so the numeric repository ID identifies that site. The
job holds this group across prepare, official upload/deploy, readiness and every sticky write.
No config, prefix, release, PR or event supplies the group; no workflow-level ingestion lock.

`prepareProjection` reads fresh actual default config, Pages metadata and a validated store
through captured ports. Inputs contain trusted runner target identity and this release's assets;
there is no preloaded config/snapshot or capture target. It produces exact generated site bytes,
validated retained records and pointer-matched newest eligible current-head PR targets. Each
unavailable/closed/mismatched target defers with a fixed diagnostic. It does not deploy.

`finishProjection` validates/copies the exact prepared state rather than reading a newer store
to select an unserved run. It observes actual served bytes through waitForReadiness, then uses
renderComment and real reconcileComment. Each mutation guard freshly corroborates the PR head,
numeric-bot ownership and stored source order. Unknown/expired/unrecognized stamps whose order
cannot be proved defer; no arbitrary comment claim certifies rollback. A definitive HTTP422
permits exactly one newly guarded plain fallback, never an unknown/authentication outcome.

Keep deployment step outcome, numeric environment ID, served observation and each comment
operation separate. A failed/cancelled step may have landed; readiness remains authoritative
about the runner's observations. An accepted store transaction survives later failures. Summary
repair instructions are fixed trusted commands. Unknown-version ingestion refusal does not
authorize an unconditional always-project path. Valid manual maintenance/repair is separate.
Finite cleanup warnings preserve a received served/accepted result when deadline disposal,
store closure or listener cleanup fails. Prepared state carries its warnings into finish;
warnings never certify an unknown operation or turn a refusal into success. This is inferred
implementation accounting under ADR0014, not an owner change to the security model.

The2026-10-04 contract audit found the frozen DTO omitted the environment identity required
above. PreparedProjection.environment now holds the validated EnvironmentMetadata, and
ProjectionResult.environmentId carries it separately from deploymentId. This aligns the DTO
with the existing decision; it grants no new ownership assertion, route or token permission.

Public metadata uses no token, cookie, redirect following or caller/API-returned destinations.
Authenticate the trusted report run/selected attempt/ref/SHA, identify the unique API-listed
project job by exact trusted runner name and fixed project label, and compare only constructed
job URLs with bounded statuses. SHA/time/newest/first alone never select or exclude a deployment.
The environment must have an exact default-branch-only custom branch policy before upload.
As an inferred bounded adapter policy, one instance permits at most60 actual public GET
attempts, including retries, and uses existing1024-item collection/JSON/request limits.
The next request refuses rather than guessing a wall-clock quota reset. This can block large
or previously rate-limited histories; it never treats a partial inventory as complete.

Existing site@1 must match repository/prefix and a validated marked store. Initial site absence
also needs complete bounded deployment history with no prior deployment, excluding at most the
uniquely authenticated current job deployment, and no positive root/site content. A404 alone,
missing/expired history, API refusal, ambiguity or bounds exhaustion cannot prove an unused
site. No settings change, automatic takeover or new owner assertion bypass is introduced.

## Consequences

No new runtime dependency, schema, golden bytes, token permission or write destination. The
workflow/API/ownership implementation needs tests first and independent security plus concurrency
review. Historical discovery is scoped evidence only. Early current-job visibility, public
quota availability, first-run setup and actual served same-repo/fork comments remain live gates.
Unknown metadata can block first-site bootstrap while independent packaging work continues.

RaceD's old-release placeholder will be replaced by an actual validated older semver in the
simulation evidence, with an exact site.json release assertion; its ordering requirement stays.
Lease-exhaustion beforeTip/afterTip denote the unchanged served store tip; observed remote tips
and all five genuine competitor advances must be recorded separately. Neither assertion is
weakened or used to conceal a missing production caller.

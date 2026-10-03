# W2-P projection contract freeze

Base: aa3dcb98acaa60b1c445e9958a1ee6e33e6043d2, functional6547d469. Required reading: AGENTS,
01 §4,02 §§6–8,03 §§3/5–8,04 M2,05 all,06 §§3–6,07 §4,08 M2 gates; ADR0004/5/6/0010/13/14/
15/16/19/22/24–29; source/readiness/comment/maintenance contracts and actual forge/store/core.
The root owns shared contracts/errors/index/manifests/workflows/ADRs/docs and integration.

This freeze implements no projector and proves no deployment. Exact TypeScript DTOs are in
publisher/src/types.ts and forge-github/src/public-metadata-types.ts. `prepareProjection(input,
dependencies):Promise<ProjectionPreparation>`, `finishProjection(prepared,observation,
dependencies):Promise<ProjectionResult>` and `renderProjectionSummary(result):string` are the
fixed future exports. No dependent author starts before this commit or invents new ports.

## Inputs and operations

Trusted runner identity separates adopter owner/name/numeric repository ID from release
version/full release commit/app bytes. The report identity includes actual run ID, selected
attempt, caller workflow ID/default ref/SHA and runner name. It does not accept artifact targets.
The action validates runner event identity before constructing adapters. Every generated/network
destination is derived from these authenticated identities/config and current Pages metadata.

`prepareProjection` runs only after the workflow project lock. Capture dependency methods once;
read actual readDefaultConfig/getPages, construct the read-only store from that freshly captured
repository/default branch/configured data branch, and read it afterward. Validate all graph/run
versions before any upload/deploy/comment. Native collection/byte capture happens inside foreign
fulfillment reactions before another await, with bounded private copies. Refuse absent/foreign/
unmarked/malformed store safely; verified absence is an explicit no-site outcome, not init.

Pages preflight is actual production adapter work, not an always-true callback. Require source
Actions, exact default-branch-only github-pages environment policy and whole-site ownership or
the complete initial unused-site proof in ADR0029. Current deployment correlation is exact
authenticated attempt/job URL, never timestamp or SHA alone. Public API reads are unauthenticated
and bounded. Unavailable/ambiguous/over-bound history refuses before upload.
The public adapter class is PublicGitHubPagesMetadata, constructed from PublicMetadataOptions.
No credential input exists. Count every actual GET attempt/retry against a60-request per-instance
bound; retain existing1024-item and JSON/request limits. Refuse the next request without any
wall-clock quota assumption. Complete environment/deployment inventories are never inferred
from a truncated response. This bound is an inferred implementation decision in ADR0029.

Use real assembleSite/deriveStreams/compareRunOrder. For every retained PR stream, fetch actual
current PR metadata, select newest corroborated current-head run, and require built latest.json
to name exactly it. Closed/unavailable/no-eligible/pointer-mismatched PRs have fixed deferred
diagnostics. Unknown is not closed. No optional image until real generated PNG/probe is proved.

Prepared state contains exact context, original marked store, retained records, generated site,
readiness targets/deferred outcomes and authenticated report/environment identity. This state
must be privately owned. Public persistence/restoration verifies versions/generation/provenance/
all allowlisted paths/categories/sizes/hashes/exact bytes and reconstructs equivalent actual
assembly before writes. No token/raw artifact/foreign executable/arbitrary callbacks or URLs.
The action keeps its private capsule outside the uploaded root; no cross-workflow cache/upload.
AssembledSite's URL methods are derived trusted functions, never persisted function data. Disk
capsules record bounded JSON metadata/byte inventories, and reconstruct URL builders and exact
assembly from checked context/records/file bytes. No caller function is restored from disk.
Preparation and finish each use an injected600000ms outer scope, intrinsic private cancellation,
and complete acquisition/cleanup accounting. Finish also uses the actual readiness scope; if
its outer scope expires after a served observation, it records that observation but starts no
new sticky mutation. Already-sent comment recovery remains bounded and truthful through the
adapter; teardown cannot invent successful mutations or conceal a received accepted operation.
PreparedProjection and ProjectionResult carry optional finite warnings: timing-disposal-failed,
store-close-failed and listener-cleanup-failed. The absent preparation outcome can also report
warnings. Private persistence validates these values; finish carries preparation warnings and
appends cleanup warnings after privately capturing actual served/accepted outcomes. Unknown or
refused operations remain fixed errors. This inferred accounting changes no success criterion.
Summary derives trusted workflow basename/default ref for a fixed gh workflow repair command.

`finishProjection` consumes only this prepared generation and an actual official step outcome.
It never substitutes later store runs. Actual waitForReadiness checks all selected pointers/site
digests three consecutive polls10seconds apart; deployed status alone authorizes no comment.
Then actual renderer/reconcileComment uses publishing bot metadata. Final head/order guards run
immediately before every mutation, including after retry delay and before one plain fallback.
An existing owned stamp must be valid and comparable using captured records; unproved order
defers. More than one owned comment edits none. Per-PR failure does not discard other targets.
All results use fixed diagnostics and exact operation IDs. Cancellation issues no new mutation.

## Acceptance and reviews

Tests first, complete unfiltered files with actual GitHubClient/core/LocalDir/nativeGit where
applicable, injected timing/no-network/fake credentials and raw scans before summaries. Titles:

- "projection reads fresh config and store only after the workflow-held lock"
- "coalesced projection repairs every eligible retained PR"
- "pointer mismatch and unavailable PR state defer without rewriting pointer bytes"
- "unknown prepared config store and run versions refuse before deployment or comments"
- "queued older release observes the newest store without rolling back a comment"
- "head changes during retry backoff defer sticky mutation"
- "failed and cancelled deployment outcomes cannot substitute for served-byte proof"
- "exact served generation precedes every comment mutation"
- "definitive comment refusal makes exactly one freshly guarded fallback attempt"
- "malformed foreign changed or stale prepared state refuses before mutation"
- "unknown or expired owned stamps cannot certify source-order rollback"
- "ignored ports and partial cleanup cannot strand bounded projection"

Independent reviewer examines actual code and forces harmful interleavings; author cannot approve.
Each blocker needs file/line, violated requirement, actual/expected, reproducer and regression.
Root integration runs complete check/fullsimulation/all3browser and hosted exact-head Linux/
Windows. Production scenarios use this caller; no driver reimplements a test-only publisher.
M2 live exit remains actual same-repo/fork served comments, release self-reference/reproducibility
and fixed authorized infrastructure. Human/external gates remain visible.

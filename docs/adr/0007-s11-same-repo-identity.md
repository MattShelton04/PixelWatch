# ADR 0007: S11 same-repo PR identity confirms 01 §4.4

- Status: accepted
- Date: 2026-10-01
- Task / spike: M0.5 / S11 (minimal, same-repo only)

## Context

01 §4.3–4.4 keep these separate: source workflow SHA, PR head SHA, base-branch SHA, selected
baseline SHA and the captured-target claim. For a PR, target = head and baseline = merge base
with "the event's base-branch commit". 01 §4.4 requires the live same-repo/fork/synchronize/rerun
behaviour to be recorded before M2 exits. M0.5 asks for a minimal recording that confirms or
challenges this policy.

On 2026-09-30 the owner put **fork PRs out of scope for M0.5**: no forks, second accounts or fork
PRs. Fork identity moves to M2.6 and is still required before M2 exits.

Evidence: [docs/evidence/s11-same-repo-identity.md](../evidence/s11-same-repo-identity.md), with
redacted payloads and REST responses in
[recordings/s11/](../evidence/recordings/s11/). Repository `MattShelton04/pixelwatch-spike-app`
(ID 1397668282), PR #1.

| Event | Capture run (attempt) | Report run |
|---|---|---|
| opened | 36710769935 (1) | 36710869758 |
| synchronize | 36841473039 (1) | 36841518484 |
| "Re-run all jobs" | 36841473039 (2) | 36841768825 |
| synchronize after merging `main` | 36842134011 (1) | 36842172831 |

Pushes to `main` between these events (36710643967, 36841340489, 36841580726, 36841581816) made
the base tip differ from the merge base.

Observed:

- **SHAs.**
  - The capture's `github.sha` is a synthetic merge commit (`refs/pull/1/merge`).
  - `workflow_run.head_sha` and `pull_request.head.sha` are the PR head.
  - The report job runs at `refs/heads/main`, at the default-branch tip.
- **The base is consistent across sources, but it isn't the tip.**
  - `pull_request.base.sha`, `workflow_run.pull_requests[].base.sha` and `pulls/{n}.base.sha`
    agreed in every PR event.
  - That value was neither the base-branch tip nor the merge ref's first parent. On a synchronize
    it stayed at M2 while `main` was M3.
  - It moved (to M4) when the head merged M4.
  - Each time, the merge base of that value and the head matched the base the capture selected
    and was the correct baseline.
- **The payload's `merge_commit_sha` can be the previous merge commit.**
- **A rerun replays the event.** "Re-run all jobs" kept the original event fields and merge SHA
  (no re-merge against the newer base), with `run_attempt` 2 and the same run ID.
  `runs/{id}.created_at` stayed the original; `attempts/{n}.created_at` was the attempt's.
- **A rerun removes the old attempt's artifacts.** After the full rerun, the attempt-1 artifacts
  were no longer listed for the run, and fetching their IDs returned 404.
- **One push started two capture runs**, with distinct run IDs, the same head SHA, and a report
  each.
- **PR association is unambiguous for same-repo PRs.**
  - `workflow_run.pull_requests[]` held exactly PR #1 for every PR event and `[]` for pushes.
  - `commits/{head_sha}/pulls` agreed.
  - The `workflow_run` payload matched REST `runs/{id}`.

Nothing observed contradicts 01 §4.4 for same-repo PRs.

## Decision

1. **01 §4.4 is confirmed for same-repo PRs, unchanged.** For implementation (M1.5 envelope, M2.1
   forge-github), "the event's base-branch commit" means:
   - `pull_request.base.sha`, which the publisher corroborates as
     `workflow_run.pull_requests[].base.sha`, matched against `pulls/{n}`;
   - **never** the base-branch tip, the first parent of the merge ref, or the payload's
     `merge_commit_sha`.

   The baseline is the merge base of that commit and the PR head. The publisher can compute it
   with `compare/{base}...{head}` (`merge_base_commit`) and check the capture's claim against it.
2. **Target = `workflow_run.head_sha`**, never the capture's `github.sha` (a merge ref).
3. **Run identity is `(run ID, attempt)`** (02 §8 run key), confirmed. A full rerun is a new
   attempt with the same commits. An attempt's parts are only those named for that attempt
   (02 §6).
   - The publisher must expect an earlier attempt's artifacts to be gone after a rerun. That run
     key then has no usable parts and gets 01 §3's bounded failure record. It isn't an error.
4. **Two source runs for one push are two runs.** Run keys differ, so both are ingested and
   ordered by 02 §8's history order. No deduplication by commit.

## Open items

- **Fork identity is unverified.** 01 §4.4 is confirmed only for same-repo PRs.
  - Still unrecorded: fork PR payloads, `workflow_run.pull_requests[]` for forks, head-repository
    IDs, and first-time-contributor approval.
  - Deferred to M2.6 (owner decision 2026-09-30), and still required before M2 exits (08 §7 S11).
- **Partial ("failed jobs only") rerun** is not recorded. It's S3/M2.6.
- **A PR updated between its capture and its report** wasn't produced. M2.1's fake-API tests
  cover "stale head". A live recording is M2.6.
- **Source-created time resolved by ADR 0016 (owner, 2026-10-03).** Use original
  `runs/{id}.created_at`, constant across attempts; numeric attempt remains the tiebreak.

## Consequences

- Threat model:
  - R4.3-03, R4.4-01 and R4.4-07 each get a `recorded` same-repo row pointing here (owner S11).
    Their fork part stays `evidence-planned` with owner M2.6.
  - R4.2-01 and R4.3-01 get `recorded` rows for the default-branch report job and the
    payload/REST match.
- 08 §7 S11 "When" and 08 §3 M0.5 say "same-repo; fork → M2.6".
- `platform-facts.md`:
  - the `workflow_run` row's "Live" column reads "same-repo: ADR 0007; fork: M2.6";
  - the artifact row notes the full-rerun observation (S3 stays pending for partial reruns);
  - the rerun row is confirmed live.
- M2.1's fake-API fixtures should use these recordings in place of hand-written shapes (07 §4):
  - stale `base.sha` with a newer merge parent;
  - stale `merge_commit_sha`;
  - a rerun with missing earlier-attempt artifacts;
  - two runs for one push.

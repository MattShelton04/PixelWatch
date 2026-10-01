# Evidence: S11 same-repo PR identity (M0.5, minimal)

- Date: 2026-09-30 (opened) and 2026-10-01 (synchronize, rerun, base update)
- PixelWatch commit: `ef39750` (no product code involved; spike code lives only in the spike repos)
- Scope: **same-repo PRs only**. Fork identity is deferred to M2.6 (owner decision 2026-09-30) and
  is still required before M2 exits.
- Result: **pass**. 01 §4.4 is confirmed for same-repo PRs. Decision:
  [ADR 0007](../adr/0007-s11-same-repo-identity.md).
- Redacted recordings: [recordings/s11/](recordings/s11/)

## Setup

| Item | Value |
|---|---|
| Repository | https://github.com/MattShelton04/pixelwatch-spike-app, repository ID 1397668282, public |
| Capture recorder | `.github/workflows/s11-capture.yml`, name "Spike Capture", workflow ID 371067781. Triggers `pull_request` (default types) and `push` to `main`, both with `paths: s11/**`. `permissions: contents: read`, checkouts with `persist-credentials: false`. |
| Report recorder | `.github/workflows/s11-report.yml`, name "Spike Report". Triggers `workflow_run` on "Spike Capture" `completed`. Top-level `permissions: {}`; job `actions: read, contents: read, pull-requests: read`. No checkout; `gh api` and `jq` only. |
| PR | #1 (ID 4690041596), head branch `s11/same-repo` → base `main`, same repository. Left open. |
| Runner | GitHub-hosted `ubuntu-24.04` |

The capture job records:
- `github.sha`/`github.ref` and that commit's parents;
- the payload's PR head and base SHAs, `before`/`after` and `run_attempt`;
- the base-branch tip it can see;
- the base/head pair it selects, the way the capture template does: PR = merge base of the
  payload's base SHA and the head; push = first parent.

It uploads the redacted event payload and two synthetic `pixelwatch-b1-a<attempt>-<rev>-spike-s1-of1`
parts.

The report job records:
- the redacted `workflow_run` payload;
- `runs/{id}`, `runs/{id}/attempts/{n}` and `runs/{id}/artifacts`;
- `commits/{head_sha}/pulls`;
- `pulls/{n}`, and `compare/{base}...{head}` for both the payload's base and the PR's current base;
- its own `github.ref`/`github.sha` and the default-branch tip.

Redaction (jq `walk`, on the runner):
- `node_id`, `gravatar_id`, `url` and every `*_url` key are dropped;
- every object with an `email` has its `email` and `name` replaced with `<redacted>`.

IDs, SHAs, refs, PR numbers and logins are kept. The committed files were also scanned for email
addresses, URL keys and token patterns; none were found.

## Commits

| Label | SHA | What |
|---|---|---|
| M1 | `e4e9b82ba3e5900a21aac5440b96273c98b6ff5e` | `main` before S11; `s11/same-repo` branches here |
| H1 | `50b2f5e185f47fb1038c901915048ec5c1fc71a6` | PR head at opened |
| M2 | `f8927b68efbdbc5589f9f7ae379ad473dd40e440` | `main` when the PR was opened |
| M3 | `ef2f8dc2ee41baec0f948efd2fe0106c55f9225d` | `main` advanced before the synchronize |
| H2 | `64d0906a4ac77e4ba51ee018d14950227c2bc435` | synchronize push |
| M4 | `92c0f162c65fd989f4bc69b1017db91e387f3ab4` | `main` advanced before the rerun |
| H3 | `92a103c1085798bd869ea505037853bb88c8c00b` | second synchronize: merges M4 into the PR branch |

## PR events

| Event | Capture run / attempt | `github.sha` (merge ref) → parents | Payload `base.sha` | Payload `head.sha` | Selected base (capture) | Report run (ran at) | `workflow_run.pull_requests[]` | `pulls/1` at report | Compare merge base |
|---|---|---|---|---|---|---|---|---|---|
| opened | 36710769935 / 1 | `3f56ddf…` → M2, H1 | M2 | H1 | M1 | 36710869758 (`main` @ M2) | #1, base M2, head H1 | base M2, head H1, `merge_commit_sha` `3f56ddf…` | M1 |
| synchronize (H2) | 36841473039 / 1 | `72d8928…` → **M3**, H2 | **M2** | H2 | M1 | 36841518484 (`main` @ M3) | #1, base M2, head H2 | base M2, `merge_commit_sha` `72d8928…` | M1 |
| Re-run all jobs | 36841473039 / **2** | `72d8928…` → M3, H2 (**not re-merged**; `main` was M4) | M2 | H2 | M1 | 36841768825 (`main` @ M4) | #1, base M2, head H2 | base M2, `mergeable: null` | M1 |
| synchronize (H3 merges M4) | 36842134011 / 1 | `32479b6…` → M4, H3 | **M4** | H3 | M4 | 36842172831 (`main` @ M4) | #1, base M4, head H3 | base M4, `merge_commit_sha` `32479b6…` | M4 |

In every PR row:
- `workflow_run.head_sha` = `pull_request.head.sha` (the PR head, never the merge ref);
- `workflow_run.head_branch` = `s11/same-repo`;
- `head_repository.id` = `repository.id` = 1397668282;
- `commits/{head_sha}/pulls` returned exactly PR #1;
- the compare merge base for the payload's base equalled the capture's selected base;
- "payload base" and "current base" compares were identical, because the PR's base never changed
  between a capture and its report.

## Push events (incidental)

| Push | Capture run(s) | Report run(s) | `pull_requests[]` | `commits/{sha}/pulls` |
|---|---|---|---|---|
| M2 | 36710643967 | 36710676244 | `[]` | `[]` |
| M3 | 36841340489 | 36841378060 | `[]` | `[]` |
| M4 | **36841580726 and 36841581816** | 36841620239 and 36841619821 | `[]` | `[]` |

These aren't claimed as evidence for the push policy (R4.4-02).

## Observations

1. **Merge ref vs head.** A `pull_request` run's `github.sha` is a synthetic merge commit on
   `refs/pull/1/merge`. Its first parent is the base-branch tip when GitHub computed the merge,
   not `base.sha`. `workflow_run.head_sha` is the PR head.
2. **`base.sha` is not the base-branch tip.**
   - On the H2 synchronize, `pull_request.base.sha` was still M2 while `main` (and the merge
     ref's first parent) was M3. `pulls/1` and `workflow_run.pull_requests[].base.sha` also said
     M2.
   - On the H3 synchronize, after the head merged M4, all three said M4.
   - In both cases, the merge base of `base.sha` and the head was the correct baseline (M1, then
     M4).
3. **The payload's `merge_commit_sha` is stale.** In the H2 synchronize payload,
   `pull_request.merge_commit_sha` was `3f56ddf…`: the previous merge commit (M2 + H1), not the
   one the run checked out (`72d8928…`).
4. **"Re-run all jobs" replays the original event.**
   - Attempt 2 had the same event fields the capture job records: action `synchronize`,
     `before`/`after`, and base and head SHAs. It also had the same `github.sha` `72d8928…`
     (merged against M3, although `main` was M4 by then), and `run_attempt` 2. Attempt 1's full
     `event.json` was lost with its artifacts, so only these fields were compared.
   - The report for attempt 2 got `workflow_run.run_attempt: 2` with the same run ID.
   - `runs/{id}.created_at` stayed the original 09:14:57Z; `attempts/2.created_at` was 09:17:02Z.
5. **A full rerun removed the previous attempt's artifacts.**
   - Attempt 1 had uploaded `s11-capture-36841473039-a1` (ID 11151363553),
     `pixelwatch-b1-a1-base-spike-s1-of1` (11151568111) and `pixelwatch-b1-a1-head-spike-s1-of1`
     (11151264411). The attempt-1 report listed all three.
   - After the rerun, `runs/36841473039/artifacts` listed only the three `a2` artifacts, and
     `GET /actions/artifacts/{id}` returned 404 for all three attempt-1 IDs.
   - The attempt-1 capture identity in the recordings was recovered from the job log.
6. **One push, two runs.**
   - The single `git push` of M4 started two "Spike Capture" runs: 36841580726 (run number 6) and
     36841581816 (run number 7).
   - They had the same event, head SHA and creation second, and each triggered its own report.
   - Both had distinct run IDs and complete artifacts. The cause wasn't investigated.
7. **The report runs from the default branch.** Every `workflow_run` report job had `github.ref`
   `refs/heads/main` and `github.sha` equal to the default-branch tip at that moment (M2, M3, M4).
   It never ran at the PR head or the merge ref.
8. **The payload matches REST.** For all 8 reports, the `workflow_run` payload and `runs/{id}`
   agreed on these fields:
   - `id`, `run_attempt`, `event`;
   - `head_sha`, `head_branch`;
   - `workflow_id`, `path`, `run_number`;
   - `status`, `conclusion`, `created_at`, `run_started_at`;
   - `pull_requests[]`.

   `attempts/{n}` agreed too, except `created_at` on attempt 2 (observation 4).

## Not covered

- Fork PRs: no fork, second account or fork PR was used (owner decision; M2.6).
- First-time-contributor approval.
- A failed-jobs-only (partial) rerun.
- A PR whose base branch is changed.
- A PR updated between its capture and its report.

Logs of these runs expire about 90 days after the run dates. The recordings here are the durable
copy. Raw downloads and logs are in the owner's git-ignored `.reference/m0.5-spikes/evidence/s11/`.

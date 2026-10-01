# ADR 0004: Projection readiness, inputs after the lock, and ambiguous comments

- Status: accepted
- Date: 2026-09-30
- Task / spike: M0.4 (threat model)
- Amended by: [ADR 0005](0005-s2-actions-pages-bootstrap-and-readiness.md). Readiness (decision 1)
  must pass on 3 consecutive polls at least 10 s apart, and it means "ready as observed from the
  runner", not globally visible.

## Context

Mapping 01 §4 to tests (`docs/security/threat-model.md`) exposed three gaps. The owner decided
each one on 2026-09-30.

1. **Readiness.** 03 §7 step 4 polled "a generated manifest" reporting the expected generation,
   run key and content digest. No such file exists:
   - the 03 §3 served tree doesn't list one;
   - the frozen `site@1` has `generation` and per-stream `latest` run keys but no content digest;
   - `api/v1/pr/<number>/latest.json` (02 §7) carries run key, head SHA and generation.
2. **Projector inputs after the lock.** 01 §4.5, 03 §7 and 07 §4 required re-reading only the
   **store** after taking the projection lock. The generation also hashes the release and config
   commits. A report run triggered at an older default-branch commit can take the lock after a
   newer run whose ingest finished first. It then deploys an older app or config. M2.3's "no stale
   generation" didn't say whether that counts.
3. **More than one marker comment.** 05 §2 identifies the sticky comment by marker plus the bot's
   numeric author ID. Every `GITHUB_TOKEN` workflow in a repo posts as the same
   `github-actions[bot]`, so another workflow that quotes PR text can create a second matching
   comment. 05 didn't say what happens then.

## Decision

1. **Readiness reuses existing files.** There is no new served file and no schema change.
   - The served `site.json` must report the expected `generation`.
   - Each PR about to be commented must have an `api/v1/pr/<number>/latest.json` that names the
     expected run key and generation.
   - The SHA-256 of each fetched body must equal the bytes the projector built. This "content
     digest" is compared in memory, not stored.
   - HTTP 200 alone is still not readiness.
2. **Re-read config after the lock; accept the release residual.**
   - After taking the lock, the projector reads config at the default-branch head resolved at
     that point and records it in the generation. It needs only `contents: read`, and unknown
     versions still fail before deploying.
   - "Stale generation" means an older **store tip**. That's never deployed.
   - A reordered older **release** is a documented residual risk. It may deploy once, but it can't
     lose data or roll back a comment, `site.json` names its release, and the next projection
     fixes it.
3. **Ambiguous comments are refused.** If more than one comment matches marker + author, the
   reconciler edits none, creates none, and records a diagnostic. This follows M2.1's "ambiguous
   cases never guess".

## Consequences

- 03 §7 steps 2 and 4 and 05 §2 carry these rules. 07 §4 gains stable scenario IDs, including
  `sim-deploy-comment-race` sub-case D, the older-release projector.
- The threat model records them as R4.2-04, R4.5-07, R4.5-08 and R4.6-08, with planned tests
  owned by M2.1 and M2.3.
- The concurrency group name becomes a cross-release contract (R4.2-07). Changing it needs an ADR.
- A PR with a duplicated marker gets no comment updates until someone deletes the extra comment.
  The job summary says so.

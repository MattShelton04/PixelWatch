# ADR 0011: Runs, the store run index and derived streams

- Status: accepted
- Date: 2026-10-02
- Task / spike: M1.5
- Amended by: [ADR 0013](0013-changes-projection.md). `changes@1` exposes `baseBranch` as
  `source.baseBranchSha`, for pull requests only.

## Context

M1.5 builds run@1 from the trusted envelope plus an `Ingestion`, adds it to `store.json`'s run
index, and derives stream@1 for the projector (02 §8, ADR 0010). Building it showed four gaps:

- **Base SHAs.** 01 §4.3 keeps the base-branch SHA and the selected baseline SHA apart. ADR 0007
  defines the baseline as the merge base of `pull_request.base.sha` and the head. run@1 had only
  `commits.head` and `commits.base`, so one of the two had nowhere to go.
- **Streams.** No doc said which stream a `workflow_dispatch` capture run joins, or what a push
  with an association does.
- **Claims.** A side has many parts (providers × shards), each with its own claims. run@1 has one
  `Claims` per side.
- **Duplicate parts.** A part sent under two artifact names is rejected. run@1 lists each part
  once, with one `artifactId`.

## Decision

### Commits (owner decision, 2026-10-02)

run@1's `source.commits` gains an optional **`baseBranch`**. This is an in-place change: run@1
hasn't shipped (as in ADR 0010).

| Field | Meaning |
|---|---|
| `workflowSha` | Optional independently corroborated source workflow SHA; unavailable provenance is omitted, never inferred (ADR 0016) |
| `commits.head` | Target: the PR head or the pushed commit |
| `commits.base` | Selected baseline: the merge base for a PR, the first parent for a push. Absent means no baseline. |
| `commits.baseBranch` | The event's base-branch commit (`pull_request.base.sha`). Pull requests only. |

Two new run@1 semantic checks enforce this, each with an invalid fixture:

- `base-branch-inconsistent`: only a `pull_request` run may have `baseBranch`;
- `baseline-inconsistent`: with no `commits.base`, every base side is `none` and no base part
  is listed. With a `commits.base`, no base side is `none`.

`buildRun` refuses an ingestion whose baseline doesn't match the envelope's, and
`baselineFor(envelope)` gives the ingestion its baseline. So the baseline comes only from the
envelope (01 §4.4). `buildRun` can't read the store, so "latest main" can't stand in for a
missing baseline.

### Streams (owner decision, 2026-10-02)

`streamFor(envelope)`:

- `push` → `main`, whatever the association. The forge admits `push` only on the default
  branch (01 §4.3, "allowed event/ref").
- `pull_request` with a corroborated association → `pr-<number>`.
- Anything else → no stream. That covers no association, an ambiguous one, and
  `workflow_dispatch`, which may run on any ref. The run is in `store.json` in history order
  but in no stream, so it never gets a PR comment.

`deriveStreams(store)` lists `main` first, then PRs by number. Each stream's runs are in history
order, and `latest` is the last one. A stream longer than stream@1's 1000 keys keeps the most
recent 1000; retention (M1.6) keeps streams far shorter. Empty streams aren't emitted.

### Index and idempotency

`addRun(store, run)`:

- refuses a run of another repository;
- returns the **same** store with `added: false` when the run key is present (02 §8), and never
  replaces the stored entry;
- otherwise inserts the entry in history order (`compareRunOrder`, now exported from
  `@pixelwatch/schemas` and shared with the store@1 semantic check) and adds 1 to `txn`.

### Claims

Each side's `claims` keeps only the fields (`revisionSha`, `harnessSha`, `environment`) that
every valid part of that side states identically. A disagreeing or silent part drops the field;
nothing is picked. If no field survives, the side is omitted. Claims are untrusted either way
and are never read to decide anything.

### Parts and labels

- `run.parts` lists received parts only. Parts that were never received appear only in
  `coverage.missingParts`.
- A part rejected as a duplicate records its lowest artifact ID. Its diagnostic
  (`<code>: <message>`) says how many artifacts carried the name and that none was chosen.
- A result's `labels` are the head's, falling back to the base's. They are untrusted display
  text.

## Consequences

- run@1 and its fixtures change in place, with no migration (nothing has shipped).
  `changes@1`'s `source` still has only `headSha`/`baseSha`. Whether it exposes `baseBranch` is
  M1.7's call.
- 02 §8 states the commit fields and the stream rule.
- The forge (M2.1) must fill `commits.base` only with a corroborated baseline, and admit `push`
  only on the default branch.
- `Ingestion.excluded` and `Ingestion.ignored` aren't recorded in run@1, and this ADR adds no
  place for them.

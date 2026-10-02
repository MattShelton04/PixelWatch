# ADR 0012: Retention, GC and budget planning

- Status: proposed (owner decisions inferred; see "Owner decisions inferred" in the M1.6 PR)
- Date: 2026-10-02
- Task / spike: M1.6

## Context

M1.6 plans retention, GC and the site budget in `packages/core` (03 §§1, 5). Everything is pure:
time, PR state, pins and the projector's file sizes are injected. Building it showed gaps the
docs don't settle:

- **Pins.** 03 §5 relies on pins, but neither config@1 nor store@1 has a pin field, and nothing
  writes pins yet.
- **Last known PR state.** 03 §5 says to keep the last known state when a lookup fails, but
  store.json can't hold it.
- **Runs in no stream.** Unassociated, ambiguous and `workflow_dispatch` runs (ADR 0011) have no
  stated retention.
- **Projected sizes.** The budget covers API files, stubs, HTML and the app, which only the
  projector (M1.7, M2.3) can size.
- **Derived files.** `derived/<ab>/<bytesHash>.png` are GC roots "of retained runs", but run@1
  doesn't record which derived files a run uses.
- **Grace namespaces.** 04 §3 keeps an old data namespace "if the budget allows", but 03 §5's
  pruning order doesn't mention grace copies, and no record of a grace namespace exists yet.
- **`now`.** 03 §5 lists `now` as a retention input, but retention orders by history only.
- **The new run.** 03 §1 refuses when "the protected roots plus the new run" don't fit, but
  retention by history order can expire a run published late.

## Decision

Code: `packages/core/src/housekeeping/` (`retention.ts`, `tree.ts`, `budget.ts`, `gc.ts`,
`plan.ts`). `planHousekeeping` runs retention, then the budget, then GC, for one transaction.

### 1. Retention

- main keeps its latest `mainRuns` runs, and each kept PR stream its latest `runsPerPr`.
- At most `prStreams` PR streams are kept, ranked open (and unknown) before closed, then by the
  stream's most recent capture in history order. "Recently closed" means most recent capture, not
  closing time: ordering uses history order only, never forge or publish time.
- **Runs in no stream** keep their latest `runsPerPr` as one group. They're never protected.
- Retention doesn't read the clock. `now` enters through grace expiry (§4) only.
- Protected: the latest main run, and the latest run of each kept open or unknown PR stream.

### 2. PR state

- The snapshot maps a PR number to `open`, `closed` or `unknown`. A PR missing from it is
  `unknown`.
- `unknown` ranks like `open`, its latest run is protected like `open`, and it's listed in
  `unknownPrStates`. It's never pruned as closed.
- Nothing is persisted. "Keep the last known state" happens in the caller (M2.3), which passes
  what it knows. A failed lookup is passed as `unknown`, never as `closed`.

### 3. Pins

- Retention, budget and GC take an injected pin set (run keys), empty by default. There's no
  schema change until a feature writes pins.
- A pinned run is kept past the count limits. Under the hard limit it's pruned last, after every
  unpinned candidate, because pins never bypass the budget (03 §5). A pin isn't protection.
- A malformed pin is an error. A pin naming no stored run is reported in `unknownPins`.

### 4. Grace namespaces

- Injected as `{ namespace: "data/v<N>", until, blobs, derived? }` until M3.4 records them. A
  namespace is a GC root, and its files are served grace copies, while `now < until`. After
  that its files are deleted.
- A namespace holds JSON records only. Any other file under `data/v<N>/` is refused.
- Under the hard limit, live grace copies go **first**, earliest expiry first, before any run
  history (04 §3 keeps them "if the budget allows"). Each drop is reported.
- A namespace whose files are already gone holds nothing alive.
- store@1 has only `data/v1`, so tests use a test-only `data/v2` as the older namespace (04 §3).

### 5. Derived files

- run@1 doesn't record derived files, so their writer supplies a map from run key to byte
  hashes.
- Without that map, references are unknown, so **every** derived file is a root and counted in
  the budget.
- With it, every run a plan keeps must have an entry, or the plan is refused
  (`unknown-references`).

### 6. Budget

The assembled site is:

- the injected fixed files (entry page, site.json, app build, API index, llms.txt; upper bounds
  where the size depends on what's kept);
- per kept run: its record, `changes.json` and permalink stub;
- per stream: its stream file, plus a PR pointer for a PR stream;
- the referenced blobs and derived files, each counted once;
- live grace copies.

Rules:

- Projected sizes are injected (`ProjectedSizes`). A size that isn't a non-negative integer
  refuses the plan rather than counting as zero.
- Over the soft limit: `overSoftLimit` and a breakdown by category (`html`, `app`, `api`,
  `stubs`, `data`, `blobs`, `derived`, `grace`).
- Over the hard limit, prune one item at a time until the site fits, in this order:
  1. live grace copies;
  2. unpinned closed-PR runs, oldest first across all closed PRs;
  3. unpinned runs in no stream;
  4. other unpinned runs (main, open and unknown PRs);
  5. pinned runs.

  Within a tier, history order decides.
- **The new run is protected** whatever its class, if retention keeps it. If retention expires
  it (an old run published late), the plan reports `newRunExpired`. The run is stored and expires
  in the same transaction, by policy rather than by budget.
- If the protected runs still don't fit, the plan is refused. It reports the total with
  everything prunable pruned, the bytes over the limit, a breakdown and the protected runs. No GC
  plan is returned, so nothing is written and the previous site stays.

### 7. Store tree and GC

The store tree is read as a reference graph. Each of these is an error, never a deletion:

- a path outside the 03 §3 layout (for example, a leftover `data/v1/streams/*.json`, any
  `.html`, or a misfiled blob);
- a run record with no index entry;
- a namespace with no grace record;
- an index entry with no record;
- a supplied run record that disagrees with its entry (key, created time, stream, repository);
- a reference to a missing blob or derived file.

GC roots are:

- `store.json`;
- each kept run's record and the blobs and derived files it references;
- every derived file while references are unknown;
- each kept grace namespace's files and references.

Everything else is deleted. The plan is a dry run:

- It lists the exact paths and bytes.
- It reports the store-branch size before and after, which the site budget doesn't measure.
- It returns store.json with only the kept runs.
- `txn` advances by 1 when GC deletes anything, as `addRun` does. A commit that ingests and
  collects advances it by 2, and `txn` only needs to be monotonic.
- Planning again on the result deletes nothing.

### 8. Paths

`housekeeping/paths.ts` names the 03 §3 served paths for each run and stream: the run record,
`changes.json`, the permalink stub, the stream file and the PR pointer. M1.7 should reuse these
paths rather than define a second set. The plan's `served.removed` lists the generated files
that leave with their runs and streams. Pool and grace files leave at the paths in `gc.delete`.

## Consequences

- No schema change: config@1, store@1 and run@1 are untouched. Pins, PR state, grace records,
  derived references and projected sizes are inputs. M2.3 supplies the PR states and sizes, and
  M3.4 supplies the grace records.
- 03 §5 points here for the pruning order, unassociated runs, injected inputs and grace copies.
- The store adapter (M2.2) must list the store tree with sizes, and must apply the delete list and
  the new store.json in one CAS commit.
- Deleting history isn't secure erasure (01 §4.7, R4.7-03). GC removes paths from the next tree
  and the next site only.
- Out of scope: the Git store adapter, backup-ref deletion, orchestration, projection and
  changes@1 (M1.7), and migrations (M3.4).

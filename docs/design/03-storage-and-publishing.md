# 03 · Storage and publishing

## 1. Limits and budgets

GitHub Pages limits: 1 GB published site, 1 GB recommended source repo, 10-minute deployment
timeout, soft 100 GB/month bandwidth. The soft 10 builds/hour limit doesn't apply to custom
Actions deployments. Don't rely on an exact CDN cache TTL, Camo size limit or GitHub GC schedule.

Product budget for the **assembled site** (data, images, app, HTML, API, migration grace copies):

- **soft 400 MiB:** warn with a size breakdown;
- **hard 500 MiB:** prune eligible history deterministically (§5). If the protected roots plus
  the new run still don't fit, refuse the transaction and keep the previous site.

Never silently drop required evidence. Also report store-branch growth, which the site budget
doesn't measure.

## 2. Why a content-addressed pool

Per-run folders would store 8.96 MB × 2 × 60 runs ≈ 1.08 GB for PropertyScope alone, over the
Pages limit. Pages counts every served path, even when Git dedupes blobs. So pixels go in one
pool keyed by pixel hash, and run folders hold only JSON that references it. Unchanged views
cost nothing. Timelines are projections over retained runs.

The MVP still captures base and head every time. Reusing a stored main snapshot as the base
is M5 (`future/review-features.md` §5).

## 3. Store branch and served tree

The **store branch** `pixelwatch-data` contains only:

```text
store.json                          # ownership marker, repository ID, dataVersion, txn counter, run index
data/v1/runs/<runKey>/run.json      # immutable accepted run
blobs/<ab>/<pixelHash>.png          # canonical PNG, 2-hex fan-out
derived/<ab>/<bytesHash>.png        # trusted-generated previews/thumbnails
```

The projector builds the **served tree** in a fresh directory. It never copies arbitrary files
from the branch:

```text
<prefix>/                           # validated relative path, default "pixelwatch"
  index.html                        # generated entry, pins the release app by hash
  site.json                         # mutable: versions, generation, streams, theme preset
  app/<release>/app.js              # from the pinned release, integrity-pinned
  blobs/…  derived/…                # validated copies from the store
  data/v1/runs/…                    # validated copies from the store
  data/v1/streams/<streamId>.json   # stream@1, generated from store.json's run index
  runs/<runKey>/index.html          # generated permalink page (not data/…/index.html)
  api/v1/index.json
  api/v1/runs/<runKey>/changes.json
  api/v1/pr/<number>/latest.json
  llms.txt
```

- In the MVP, PixelWatch owns the whole Pages site. Serving inside an existing docs site is
  deferred (§8).
- Filenames contain only generated identifiers, never labels, paths or PR titles.
- `site.json` holds repository ID, `dataVersion`, viewer/writer release, generation, available
  data namespaces, sanitized presentation config and stream pointers. It **never** holds
  executable URLs or hashes; those come from the release at build time.
- **Generation ID** = SHA-256 of canonical JSON
  `{storeTip, releaseCommit, configCommit, projectionVersion}`. These are all known before
  building, so there's no self-reference.
- Store metadata uses a transaction counter, never its own future commit SHA.
- Streams aren't stored. Each `store.json` run entry names its stream, so the projector derives
  every stream's ordered run list and latest pointer; there's no second index to keep in sync.
- Generated HTML, indices and API files are rebuildable. Canonical PNGs and accepted run records
  are never changed in place.

## 4. Image format: PNG canonical

The publisher decodes the restricted bundle PNG, normalizes pixels (02 §3), and writes a
metadata-free canonical PNG with its own bounded encoder. That one codec serves validation,
recompute, imports and future migrations. An existing blob with the right name is reused as is
and never overwritten; it isn't decoded again (ADR 0010).

Lossless WebP measured −58 % on PropertyScope, but a WebP-only pool would need a second trusted
decoder. It's a possible **later derived representation** (immutable path including profile and
byte hash), only if storage or latency becomes a measured problem. Note that default lossless WebP
may alter RGB under fully transparent pixels; use `exact` mode. No stored full-size diff images:
the viewer computes diffs client-side. No tiles in the MVP.

## 5. Streams, retention and GC

MVP defaults:

- the latest **30** main runs;
- the latest **5** runs per PR;
- at most **30** PR streams, open PRs first (by most recent capture), then recently closed ones.

That's at most 180 run records, fewer if the byte budget requires it. Comments and history
disclose expiry. Pinning never bypasses the hard budget. Daily/weekly archive thinning is later.

- **Retention** is a pure function of (validated listing, policy, `now`, PR-state snapshot).
  Inject time and PR state. If a PR lookup fails, keep the last known state and report it; unknown
  isn't closed.
- **Order** runs by source-created time, numeric run ID, then attempt. Never by publish time or
  lexical order.
- **GC roots:** retained runs and their blobs/derived files, pins, migration grace namespaces and
  permitted backups.
- **Sweep:** rebuild indices from retained runs, and delete expired runs, API files, PR pointers
  and permalink pages as well as unreferenced blobs.
- GC is idempotent and has a dry run that lists exact paths and bytes. A malformed reference is an
  error, never a reason to widen deletion.
- **Over budget:** drop the oldest unpinned closed-PR history first, then other oldest unpinned
  runs. Always keep the latest main run and each retained open PR's latest run.
- ADR 0012 fills in the details:
  - Runs in no stream keep their latest `runsPerPr` and are pruned after closed-PR history.
  - Live grace copies are pruned before any history.
  - Pinned runs are pruned last.
  - The new run is protected.
  - An unknown PR state ranks and is protected like an open one.
  - Pins, PR states, grace records, derived-file references and projected sizes are injected
    inputs; there's no schema change.
- A `workflow_dispatch` maintenance run of the report workflow does GC and repair without new
  captures. No hidden background process.
- **Migration backups:** unique refs `pixelwatch/backup/<from>-<to>-<date>`, deleted by the
  maintenance command after 30 days (dry run first).
- Removing files is **not** secure erasure (01 §4.7).

## 6. Git strategy for the store branch

Each ingestion transaction:

1. Create a fresh isolated Git directory with a sanitized environment: no inherited credential
   helpers, `core.hooksPath`, `core.sshCommand`, filters or submodules, and no shell
   interpolation.
2. Fetch exactly `refs/heads/pixelwatch-data` with `--depth 1`.
3. Read the tree with `ls-tree`/`cat-file`. Validate the marker, repository ID, schema, paths,
   file types and sizes. Bound subprocess time and temporary disk.
4. Compute the new tree with `hash-object`/index plumbing and create a **parentless** commit.
5. Push the single ref with `--force-with-lease=refs/heads/pixelwatch-data:<expectedSha>`.
   First creation uses an expected-absent lease, never a plain `--force`.

- **On a lease conflict:** refetch, revalidate and recompute from the same accepted input and
  injected timestamp. At most 5 attempts with jittered backoff. Never `git rebase`.
- **Uncertain push outcome:** refetch and check for the run key before retrying (02 §8).
- **Refuse:** a store branch that's the default branch, unmarked or foreign-marked. Never
  "initialize" over existing content.
- The fresh depth-1 fetch matters. A local test found fetch + parentless commit sent only the new
  blob (≈ 525 KB for 512 KiB new), while an orphan commit without that fetch resent everything.
  Reachable history stays one commit, but physical repo size isn't guaranteed to stay bounded.
  Confirm on GitHub (S7).

## 7. Pages deployment and projection

Commits pushed with `GITHUB_TOKEN` don't trigger a branch Pages build, so the store is never
branch-served. Don't add a PAT to force it. Instead, the report workflow's second job:

1. Joins one concurrency group per repository/site with `cancel-in-progress: false`.
2. **After** taking the lock, fetches the latest store, reads config at the default-branch head
   resolved at that point (recorded in the generation), and builds the served tree (§3) plus the
   pinned app. A deployment never uses an older store tip than the one before it ("no stale
   generation"). The release is the job's own, so a queued older-release projector can still
   deploy once after a newer one. That's a documented residual risk: it can't lose data or roll
   back a comment, and `site.json` names its release (ADR 0004).
3. Uploads and deploys with the official `actions/upload-pages-artifact` / `actions/deploy-pages`
   into the `github-pages` environment.
4. **Readiness:** polls with a bounded timeout until the served `site.json` reports the expected
   `generation`, and, for each PR about to be commented, `api/v1/pr/<number>/latest.json` names
   the expected run key and generation. The SHA-256 of each fetched body must equal the bytes the
   projector built. That digest is compared in memory, not stored. HTTP 200 alone isn't
   readiness, because old edges and cached 404s exist. The whole check must pass on **3
   consecutive polls at least 10 s apart**; any failing poll resets the count. It also probes
   comment image URLs with a bounded GET before using them. Ready means "ready as observed from
   the runner". Other CDN edges can still serve an older or mixed generation for minutes (Pages
   sends `max-age=600`), so nothing claims global visibility (ADR 0005).
5. Reconciles sticky comments for **every** retained PR that needs an update, not just the
   triggering one (05 §2).

Pending projections may be coalesced safely, because every ingestion is already durable and the
next projector catches up. Never cancel an active deploy. On a timeout, a failed deploy step or
a cancelled job, report "stored; deployment/comment pending". A cancelled job may still have
deployed; readiness, not the job or deployment state, decides what's served. The job summary
records the numeric environment deployment ID (the Pages deployment ID repeats per commit),
store tip and comment operations. Manual `workflow_dispatch` repair reprojects the latest store
and reconciles comments idempotently. (`concurrency.queue: max` exists but isn't needed.)

## 8. Deferred serving modes

Not in the MVP, each needing its own ownership, credential and ordering design:

- fragment mode (drop into an existing docs build);
- separate store repository;
- branch-served Pages with explicit credentials;
- S3/object storage;
- artifact-only / private repos.

If the adopter already uses Pages, preflight **refuses** rather than overwriting their site,
and points to this limitation.

## 9. Size illustration (not a bound)

42 views; assume about 2.5 previously unseen images per run; 60 runs:
`42 + 60 × 2.5 = 192` unique images ≈ **41 MB PNG**. Six independent variants ≈ 246 MB. The
default retention can hold 180 runs, and a PR that changes every view adds far more. The actual
admission control is the §1 budget over the assembled tree, not this forecast.

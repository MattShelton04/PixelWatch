# 07 · Testing strategy

Tests prove named invariants. A skipped test is reported as skipped, never counted as green.

## 1. Layers

| Layer | Scope | When |
|---|---|---|
| 1 · Unit/property | Schemas, PNG, hash, comparator, identities, merge, coverage, retention, rendering | Every PR, no network |
| 2 · Golden | Bundles → run / `changes.json` / comment / site tree | Every PR |
| 3 · Local simulation | Fake GitHub, bare Git remote, fake CDN; races and failures | Every PR |
| 4 · Browser | Viewer shell, CSP/SRI, routes, modes, memory | Chromium, Firefox, WebKit |
| 5 · Live GitHub | Fixed e2e repos: same-repo, fork, hostile PRs, real Pages | Manual/nightly + every release |
| 6 · Canaries | TracePilot + a PropertyScope fork, with imported history | M3 exit |
| 7 · Self-review | The released publisher reviews the PR's own viewer screenshots | M3 |

Scripts:

- `pnpm check`: lint, typecheck, unit, golden, security lints. No network.
- `test:simulation`, `test:viewer`.
- `test:live`: needs explicit settings, fails clearly without them, and never runs on fork PRs.

## 2. Unit and property tests

Use seeded generators and save minimal failing cases.

- **Pixel hash:** depends only on width, height and normalized RGBA. Hidden RGB under alpha 0
  doesn't change it; any visible change does. Cover alpha 1/254, RGB vs RGBA, and dimension
  collisions. Fixed byte-level vectors.
- **PNG:** cross-check decoding against an independent decoder and the PNG test suite **in the
  test toolchain only**. Round-trip tests alone can hide shared bugs. Fuzz with time/memory limits.
- **Comparator:** parity with recorded prototype goldens (02 §9), plus boundaries, dimension
  changes, zero pixels and alpha.
- **Merge:** deterministic under input order. Rejects duplicates and conflicts. Never mixes
  attempts, providers or revisions. Missing catalogs keep unknown counts. The eight counts are
  exhaustive and disjoint.
- **Retention/GC:** pure over (`now`, PR states, listing). Idempotent. Nothing reachable is
  deleted, including API, permalink, derived and grace files. Protected roots are never silently
  dropped.
- **Rendering:** canonical safe text. The 60,000-byte cap after escaping. Warnings survive every
  degradation path. URL builders reject traversal, bad protocols and hosts.
- **Config/data:** unknown versions fail before mutation. Duplicate keys and prototype-pollution
  keys fail.

## 3. Goldens and compatibility

- Commit tiny hand-built bundles (4×4 images covering every state and threshold boundary), a
  few representative real images, and recorded expected outputs. Keep full-size or private data
  out of Git; a download script pins artifact IDs and checksums, with no credentials.
- The golden site v1 is the final model from M2 onward. Test migration machinery with a
  synthetic N → N+1. Test N−1 upcasting separately from writer migration and old-reader refusal.
  An old entry whose asset is gone must fail with the static reload message.
- Imported legacy sites are data only. Never run their JS/HTML. Converters recompute hashes,
  check counts and references, and mark provenance as legacy.

## 4. Local pipeline simulation (the workhorse)

An in-process typed fake GitHub API (shapes hand-written from the official docs, later replaced
by redacted real recordings), a local bare Git remote, a controllable static/CDN server, an
injected clock and deterministic barriers.

| Scenario | Must hold |
|---|---|
| Four ingestors fetch the same tip | Every valid run survives bounded CAS retries |
| Push accepted, client times out | Refetch finds the run key/digest; no duplicate or overwrite |
| Lease conflict, retries exhausted | Old consistent site remains; repair instruction reported |
| Projectors A and B reordered | Each reads the store after the lock; the final generation has both |
| Coalesced pending projector | The later projector publishes and comments for earlier runs too |
| Old/new PR head interleaving | An old publisher can't replace the new head's comment |
| Deploy OK, comment create times out | Rediscovery prevents duplicate comments |
| Store OK, deploy fails or is cancelled | Run stays stored; the next or manual projection completes it |
| 200 from an old CDN generation | Not treated as ready |
| Independently stale HTML/JS/JSON, cached 404 | Bounded reload then static fallback; no loop, no misparse |
| Migration/rollback vs active writer | Lease conflict forces a fresh loss preview |
| Expired artifact, rate limit, cross-origin 302, 410/5xx | Bounded retries; auth stripped; nothing secret logged; incompleteness visible |
| Unknown config/data version | No store write, deploy or comment |

Simulate several CDN TTLs (600 s is one case). Aim for ≤ 4 minutes, but never drop scenarios to
meet that.

## 5. Live GitHub e2e (fixed repos)

- One persistent public upstream test repo plus a bot-owned fork, in the e2e organisation. A
  trusted manual/nightly driver runs them. No repo factory, no test GitHub App, no
  create/delete tokens.
- Scoped test credentials live only in trusted default-branch workflows, separate from release
  credentials. PR workflows never see them.
- Record redacted event/API payloads for: fork PR, synchronize, approval-required, full rerun,
  partial rerun. Observe merge vs head SHA and base association (spike S11).
- If first-time-contributor approval blocks a run, the driver reports "pending". It never
  counts no-run as success. Manual fork verification before a release is an acceptable fallback.
- **Scenarios:** `first-run`, `pr-same-repo`, `pr-fork`, `pr-fork-hostile`, full rerun, stale PR
  head, store-OK/deploy-fail repair, old pinned release after a new release.
- **Hostile inputs:** traversal, huge dimensions, malformed PNG/ZIP, forged PR/run/attempt,
  missing parts, fake markers, active files, unknown versions, prompt-like text.
- Check actually served bytes and browser visibility, not just status codes.
- Track runner minutes, artifact bytes, store bytes and deploy bytes. Cleanup is by exact repo
  IDs with a dry run, never by prefix.

## 6. Security, viewer and self-review

- **Traceability:** every rule in 01 §4 maps to a named test or a manual evidence item
  (`docs/security/threat-model.md`).
- **Parser corpus:**
  - ZIP: central/local mismatch, duplicate and case-colliding names, links, ZIP64/encryption;
  - PNG: multiple IHDR/IEND, bad CRC or filter, inflate bombs, trailing data, integer overflow.
  - Record peak RSS and time.
- **Git:** default-branch refusal, unmarked or foreign store, hostile tree modes, hooks/filters
  disabled, lease conflict, unknown push outcome.
- **Workflows:** capture is read-only with no secrets; the report runs from the default branch;
  source IDs are validated; full-SHA pins; no PR checkout in the publisher.
- **Browser:**
  - Test injected HTML/script in labels, URL tricks, poisoned `localStorage`, fake app URLs,
    and CSP/SRI rejection.
  - Run at 390, 820 and 1440 px in three engines: keyboard, focus, contrast; axe plus manual
    checks.
  - Test long 1440×6000 images for memory, cancellation and serial fallback. Measure p95
    open/compare time and peak memory before setting budgets.
- **Self-review (M3):** the last released publisher reviews screenshots of the PR's viewer. PR
  viewer code runs only in capture, never with write tokens.

## 7. Canaries and evidence

- TracePilot (owner's repo) and a **fork** of PropertyScope (the shared university repo is not
  modified), each with imported history. Hand-check counts, hashes, classification deltas,
  links, warnings and rollback.
- M3 exit: **7 consecutive daily scheduled checks** with no unresolved correctness or security
  failure. This can overlap M3 work. Transient retries are logged; a deterministic failure is
  never rerun until green.
- Evidence records (in `docs/evidence/`): date, product SHA, repo/run/deployment IDs,
  browser/runner versions, redacted observations, pass/fail. Cover: Pages bootstrap, fork
  identity, Camo PNG, self-reference, final release metadata, migration/rollback, quickstart.

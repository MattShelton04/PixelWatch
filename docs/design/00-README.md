# PixelWatch design: start here

PixelWatch (working name) is a reusable, self-hosted visual-regression tool for public GitHub
repositories. It extracts what TracePilot and PropertyScope each built separately:

- capture screenshots in CI;
- compare base against head;
- keep a history site on GitHub Pages;
- maintain one sticky PR comment;
- publish a machine-readable `changes.json` for people and coding agents.

It needs no hosted service, GitHub App, secrets or AI in CI.

Status: M0 and M1 are implemented with recorded evidence; the current audit is in
[the MVP program record](../program/mvp-progress.md). M2.4 supplies simulation infrastructure,
with product cases still NOT RUN. Remaining publisher work starts with M2.1/M2.2 in
[08-implementation-plan.md](08-implementation-plan.md) §5.

## 1. Files and authority

| File | Owns |
|---|---|
| [01-architecture-and-security.md](01-architecture-and-security.md) | Trust model (**normative**), workflows, adopter files, source/base policy |
| [02-contracts.md](02-contracts.md) | **Canonical MVP contracts:** schemas, identities, hashing, result states, ingress limits, artifact naming/merge, `changes@1` |
| [03-storage-and-publishing.md](03-storage-and-publishing.md) | Store branch, site tree/paths, retention/GC, Git strategy, Pages deployment, projection serialization |
| [04-viewer.md](04-viewer.md) | Viewer app, routing, CSP, caching, data versioning and migrations |
| [05-pr-comment.md](05-pr-comment.md) | Fixed sticky comment, ordering, size budget, escaping |
| [06-repo-and-release.md](06-repo-and-release.md) | Monorepo layout, tooling, reusable-workflow self-reference, releases, adopter upgrade |
| [07-testing.md](07-testing.md) | Test layers, simulation scenarios, live e2e, security tests, canaries |
| [08-implementation-plan.md](08-implementation-plan.md) | **Milestone scope**, tasks with done-when, spikes, owner decisions, risks, agent workflow |
| [future/](future/README.md) | M4+ designs. **Not MVP. Do not implement during M0–M3.** |
| [reference/](reference/) | Background only: platform facts with sources, TracePilot lessons learned |

**Precedence:** 01 is normative for security. 08 owns what is in scope. 02 owns data contracts.
03 owns paths. 04 owns viewer compatibility. `future/` and `reference/` never override these.
If two files disagree, or the code shows a design is wrong, **stop, show the discrepancy and
propose the minimal fix**. Don't silently choose. Fix the doc in the same PR as the code, and
record decisions as ADRs in `docs/adr/`.

## 2. Fixed decisions (do not reopen)

1. Product repo on the owner's **personal** GitHub account. The e2e test repos live in a separate
   free organisation, so no test credential can touch personal repos.
2. **TypeScript** for everything that runs in Actions. One lockstep version for all shipped
   components. Python is capture-only and comes later (M4).
3. **Untrusted capture / trusted publisher split:** capture runs PR code with `contents: read`
   and no secrets. A `workflow_run` publisher on the default branch runs pinned, bundled release
   code and never executes anything from the PR.
4. **No AI reviewer in CI.** Structured output for external agents is in scope.
5. Free and serverless: public GitHub.com, standard hosted runners, GitHub Pages.
6. **MVP is exactly M0–M3.** Later ideas stay in `future/` until the MVP ships.

## 3. The MVP in one page

- **Capture stays as it is.** TracePilot and PropertyScope keep their capture code and add a
  small converter to the `bundle@1` format (PNGs + a JSON manifest), uploaded as one artifact per
  revision/provider/fixed shard. New capture tooling (recipes, SDK, CLI) is M4.
- **Publisher** (reusable workflow, triggered by `workflow_run`): authenticates the source run
  through the GitHub API, downloads and strictly validates artifacts, decodes PNGs with its own
  bounded decoder, hashes pixels, compares base against head, and writes an immutable run record.
- **Store:** a dedicated `pixelwatch-data` branch holds data and canonical PNGs in a
  content-addressed pool. Each write is one parentless commit, pushed with an explicit
  `--force-with-lease`. Concurrent publishers retry; nothing is dropped.
- **Serving:** the branch is **not** served directly. A separate serialized job builds the site
  from the latest store plus the pinned viewer release and deploys it with the official Pages
  actions. That job then updates the sticky PR comment.
- **Images:** canonical, metadata-free PNG. WebP is a possible later display format.
- **Viewer:** one JSON-driven app, pinned by hash in generated entry pages (strict hash CSP + SRI).
  M2 ships a minimal version, and M3 adds the full review modes, history and timelines.
- **Agent output:** a static `api/v1/` with `changes.json` per run and `llms.txt`.

What the MVP deliberately doesn't do: recipe runner, SDKs, public CLI, `init`, dynamic sharding
planner, baseline reuse, WebP, animation, layout findings, comment DSL, Studio, MCP, other
hosting modes, approval gating.

## 4. Superseded ideas: don't implement these

Earlier drafts (and `reference/`) mention these. They were replaced for concrete reasons:

| Earlier idea | Replaced by | Why |
|---|---|---|
| Push to `gh-pages` and let Pages build from the branch | Data branch + explicit Actions Pages deployment | GitHub docs: commits pushed with `GITHUB_TOKEN` do not trigger a Pages build. Actions deploy also avoids the 10 builds/hour limit and serves only trusted assets. |
| `script-src 'self'` + a mutable `loader.js` choosing the app version | Generated entry pages pin the exact app bytes (hash CSP + SRI) | All of an owner's project Pages share one origin, so `'self'` trusts other sites' scripts |
| Release pipeline rewrites internal `uses:` to the release commit's own SHA | `job.workflow_repository` / `job.workflow_sha` self-checkout | A commit can't contain its own SHA |
| Lossless WebP as the canonical pool | PNG canonical | A WebP-only pool needs a second trusted decoder for recompute/imports |
| Interim per-run gallery in M2, migrated to the app in M3 | Minimal final viewer in M2 | No throwaway renderer, no invented v2 migration |
| "An orphan branch never grows" | Only reachable history is bounded | Old objects can remain on GitHub; deletion isn't erasure |
| Ephemeral e2e repos created by a GitHub App | Fixed test repos + a bot fork | Less privilege and lifecycle code |
| npm/PyPI placeholder packages at 0.1.0 | Ship only what's implemented | No empty releases |
| Dropping failed/cancelled capture runs, "missing → unchanged" | Explicit `missing`/`failed`/`incomparable` states | Omitted work must never look like a pass |

## 5. Glossary

| Term | Meaning |
|---|---|
| Provider | One capture source/environment, e.g. PropertyScope's `fixture` and `stack` |
| View / variant | A captured screen / a named capture setting (viewport, theme) |
| Unit | The identity `(providerId, viewId, variantId)` |
| Part / shard | One uploaded artifact: one revision × provider × shard index |
| Run | A comparison of one attempt's base and head captures, with results. Key: `runKey = <sourceRunId>-a<attempt>` |
| Stream | Ordered run list, `main` or `pr-<number>`, derived from the store's run index |
| Store | The `pixelwatch-data` branch: `store.json`, `data/`, `blobs/`, `derived/` |
| Projection | Building the served site from the store plus the pinned release |
| Generation | One deployed site build, identified by `hash(storeTip, releaseSha, configSha, projectionVersion)` |
| Envelope | Source facts the publisher corroborated through the GitHub API (trusted) |
| Claims | Everything the capture side says (untrusted) |

## 6. Measured baseline (PropertyScope PR #123, Visual Capture run 36405830015)

42 views per revision (29 fixture + 13 stack), 1440 px wide, 1000–6000 px tall (median ≈ 1100).
PNG median 169 KB, 8.96 MB per revision. Lossless WebP measured 3.77 MB (−58 %). Capture job
totals: fixture ≈ 90 s, stack ≈ 135 s per revision. Use these for sizing. They're the
owner's observations, not PixelWatch benchmarks.

## 7. Open questions

- **Name:** "PixelWatch" collides with Google's Pixel Watch. Keep the name in one constant until
  a free name is chosen (candidates: Glance, Tessera, Parallax, Lookback).
- **Licence:** Apache-2.0 recommended. Owner to confirm before the first public release.
- Is the default "subtle" threshold (128 px, Δ 8/255) right across projects? Keep the prototype
  values for parity; revisit after the canaries.

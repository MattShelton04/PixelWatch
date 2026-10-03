# 08 · Implementation plan (M0–M3)

This file owns scope. The MVP is M0–M3. **Don't start a milestone's feature work until the
previous one has exited** (scaffolding ahead is fine). Don't implement anything from `future/`.

## 1. Before code

1. The repo exists on the owner's personal account. This folder lives at `docs/design/`, and
   `AGENTS.md` / `CLAUDE.md` are at the root. From now on the repo copy is the source of truth,
   and design changes go through PRs.
2. `docs/adr/` holds decisions (context → decision → consequences). Spike results and deliberate
   deviations become ADRs.
3. **Reference inputs.** Both prototypes are the owner's public repos. The agent fetches what it
   needs into a git-ignored `.reference/` folder and reads the real code rather than guessing
   from these docs:
   - **clone** both repos (`gh repo clone`), and read `scripts/visual/` and the
     `.github/workflows/visual-*.yml` workflows;
   - **artifacts:** fetch capture artifacts with `gh run download`. Use PropertyScope Visual
     Capture run 36405830015 (PR #123) if it hasn't expired; otherwise use the latest successful
     run.
   - **history:** the `gh-pages` branch of each repo.

   Record the repo URLs and commit SHAs used in `docs/adr/0001-reference-inputs.md`. The owner has
   approved reusing this code under the project licence. Nothing from `.reference/` is committed.

## 2. Milestones

| Milestone | Goal | Estimate | Exit demo |
|---|---|---|---|
| **M0 Foundations** | Scaffold, schemas, threat model, reference inputs, key platform spikes | 1–2 wks | Real converted bundles validate; comparator ADR + goldens recorded; S2/S4/minimal S11 done; `pnpm check` green |
| **M1 Core** | Pure engine | 2–3 wks | `pixelwatch-dev compare base/ head/` matches the prototype's goldens (or approved deltas); hostile corpus passes |
| **M2 Publisher** | Store, Actions Pages, sticky comment, minimal final viewer, live fork path | 3–4 wks | A real same-repo and fork PR each get a correct comment linking a served run page |
| **M3 MVP** | Full viewer, migrations/recovery, imports, canaries, docs, `0.1.0` | 2–3 wks | Both canaries with imported history, 7 daily green checks, final `0.1.0`, clean quickstart |
| M4 | Capture runner, public CLI, `init`, Node + capture-only Python SDK, cheap findings, first skills | plan after M3 | |
| M5 | Planner/sharding, variants, baseline reuse, flow stills, comment blocks | plan from data | |
| M6+ | Calibrated findings, flake/attribution, Studio, MCP, more serving modes | unscheduled | |

8–12 focused weeks for M0–M3, low confidence. Reforecast after M1. If blocked, finish
independent tests/docs or report the exact gate. Never pull in future features to fill time.

## 3. M0 · Foundations

**Read first:** 00; 01; 02; 03 §§3–4, 6–7; 04 §§1, 4; 06 §§2–4; 07 §§1–3.

| ID | Task | Done when |
|---|---|---|
| M0.1 | pnpm workspace per 06 §2 (only needed packages), strict TS, ESLint with the `innerHTML` ban, Vitest, fast-check, actionlint, zizmor, CI on Linux + Windows; scripts for `check`, `test:simulation`, `test:viewer`, `test:live` | `pnpm check` green in CI on real (non-empty) smoke fixtures; no network in `check`; `test:live` fails clearly without settings and never runs on fork PRs |
| M0.2 | Licence, README stub, `SECURITY.md`, `CONTRIBUTING.md`, Dependabot, CodeQL, pinned third-party actions, branch protection | Settings checked by the owner and noted with a date; capture template is read-only/no-secret; nothing claims settings the account can't enforce |
| M0.3 | `packages/schemas`: the 8 schemas in 02 §1, generated TS types, canonical serializer; bundle converters for PropertyScope and TracePilot | Every schema has valid and invalid fixtures (unknown versions, unsafe fields, duplicate keys rejected); real prototype output converts and validates; counts sum; provider and attempt identity work |
| M0.4 | `docs/security/threat-model.md` from 01 §4; diagram/state table of ingest vs serialized projection | Every trust boundary maps to a named test (07) or manual evidence item; CAS race and deploy/comment race are separate tests |
| M0.5 | Live spikes in a throwaway public repo: **S2** Actions Pages bootstrap + readiness, **S4** reusable-workflow self-checkout, **minimal S11** same-repo identity (fork → M2.6) | Each has an ADR with run/deployment IDs. S4: a SHA-pinned caller runs the pinned bundle, not caller code (if not, stop and redesign). S11 payloads confirm the base/head policy in 01 §4.4 or surface a decision. |
| M0.6 | `docs/adr/comparator-v1.md` from the prototype source (02 §9); golden outputs produced by **running** PropertyScope's comparator on the PR #123 bundles (plus two TracePilot runs with real changes, ADR 0001 M0.6 addendum); tiny 4×4 fixtures for every state/boundary; pixel-hash vectors | Goldens are recorded outputs, not hand-written guesses; tiny fixtures cover all 8 results and threshold edges |

**Order:**

- M0.1/M0.2 first, and fill in the AGENTS.md "Commands" section.
- M0.3 and M0.6 use the reference inputs (§1, item 3).
- M0.4 after the draft schemas.
- M0.5 needs the owner to authorize the throwaway repo. The agent asks; it never creates repos
  or tokens on its own.
- If something is unreachable (e.g. an expired artifact), finish the independent rows and report
  exactly what's missing.

## 4. M1 · Core (pure, no I/O)

**Read first:** 02 (all); 03 §§3–5; 04 §3; 07 §§2–3. Port the recorded prototype logic, not
logic imagined from file names.

| ID | Task | Done when |
|---|---|---|
| M1.1 | Restricted PNG validate/decode/encode in TS: bounded `node:zlib` inflate, filter reconstruction, 02 §5 limits, worker isolation. No third-party decoder in the trusted path. | Hostile corpus fails before large allocation; decoded RGBA matches an independent decoder on the real PNGs; output PNG fits the profile; peak RSS/time recorded |
| M1.2 | Pixel hash (02 §3) and canonical blob reuse | Fixed vectors pass; hidden-alpha RGB ignored; existing blobs reused, never overwritten (ADR 0010: not re-decoded). No WebP. |
| M1.3 | Diff, thresholds, regions, classification from `comparator-v1` | Real bundles and tiny fixtures match goldens, or each delta has an approved ADR + new comparator version; missing/failed/incomparable never become unchanged |
| M1.4 | Bounded ZIP/JSON ingress + fixed-part merge (02 §§5–6) | Traversal, duplicates, links, ZIP64, bombs rejected; name/attempt/provider/revision consistency enforced; no mixed attempts; missing parts have unknown counts |
| M1.5 | Runs and the store run index; envelope vs claims; idempotency by run key; streams derived from the index (02 §8, ADR 0010) | Permuted inputs build identical runs; an already-stored run key is a no-op, never an overwrite; ordering is numeric source order; same view name in two providers stays separate |
| M1.6 | Retention + GC + budget planning (03 §§1, 5) | Fixed time/PR-state inputs reproduce selection; nothing referenced deleted; budget includes API/stubs/derived/grace; protected-root overflow refuses; GC idempotent |
| M1.7 | `changes@1` projection and path generation (02 §7, 03 §3) | Schema-valid goldens for tiny + real bundles; counts sum; coverage/source/policy present (policy = `comparator` + `capabilities`, ADR 0013) |
| M1.8 | Internal `pixelwatch-dev compare base/ head/` | Reproduces M1.3 locally; no network or credentials; stable non-zero exit codes and bounded errors |

## 5. M2 · Trusted publisher + minimal final viewer

**Read first:** 01; 02 §§6–8; 03 §§3, 5–7; 04 §§1–2, 4; 05; 06 §§3–5; 07 §§4–5.

| ID | Task | Done when |
|---|---|---|
| M2.4 | **First:** local simulation harness (07 §4): fake GitHub, bare Git remote, fake CDN, barriers | All 07 §4 scenarios run deterministically on every PR, and the failure injection reaches the racy interleavings |
| M2.1 | `forge-github`: source run/attempt verification, PR association, paginated artifacts, manual-redirect download, bot-owned comments, Pages metadata | Fake-API tests: empty/multiple PR associations, merge vs head SHA, stale head, wrong repo/workflow/attempt, pagination, cross-origin 302 auth stripping, expiry, rate limits, unknown outcomes; ambiguous cases never guess |
| M2.2 | `store`: marked git-branch adapter (03 §6) + local-dir | Four-writer barrier test keeps every run; stale lease fails; bounded recompute-retry; accepted-push/client-timeout dedupes; default/unmarked/foreign branch refused |
| M2.3 | Orchestration: ingest job (CAS) → serialized project/deploy/readiness/comment job (03 §7, 05 §2) | Simulation shows no dropped ingestion, no stale generation, no comment rollback; coalesced projector repairs earlier PRs; summary reports stored/deployed/served/commented separately with a repair command |
| M2.5 | Bundled `actions/publish` (esbuild, node24), reusable `report.yml` with self-checkout (06 §3), pinned refs, release tooling up to an **RC** | Foreign SHA-pinned caller and an older release after a newer one both run their own bundle; permissions/environment verified; dist rebuild reproducible; RC reports its RC version |
| M2.6 | Fixed e2e repos + trusted driver; `first-run`, `pr-same-repo`, `pr-fork`, `pr-fork-hostile`, full rerun (07 §5) | Real fork capture is read-only with no secrets; the trusted report publishes; the sticky comment on the current head links the served run; partial rerun shows incomplete; approvals show as pending, never green |
| M2.7 | **Minimal final viewer** (04 §6 M2 list) | A real Pages run page loads in all three engines with matching CSP/SRI, no store code, safe fallbacks; URL is `runs/<runKey>/`; PNG preview renders through Camo (S1) or the text link works |

No interim gallery. M2 doesn't exit without the live fork test (S11 complete).

## 6. M3 · Viewer, compatibility, imports, release

**Read first:** 04 (all); 03 §§3–7; 05; 06 §§5–6; 07 §§3, 5–7. `future/review-features.md` §1.2 is
background only.

| ID | Task | Done when |
|---|---|---|
| M3.1 | Full shell/routing/cache fallback | Deep links, OG tags, project prefix, expired routes, stale HTML/JS/JSON/404 permutations pass; no CSP/SRI violations in three engines; max one auto-reload |
| M3.2 | Prototype feature parity: side-by-side, wipe, overlay, diff, zoom, regions, keyboard; worker + serial fallback | The prototype gallery's feature checklist (from source) is met; 390/820/1440 px; keyboard/focus/axe + manual; long images degrade safely |
| M3.3 | History home, PR view, provider-qualified per-view timeline, 4 theme presets | Counts/links match streams; missing/failed/incomparable visible; injection tests pass |
| M3.4 | Migration framework + maintenance commands: preview, migrate, rollback, GC, reproject (04 §3) | Synthetic N→N+1, v1 goldens, newer-writer refusal, immutable namespaces, backup expiry, grace over budget, rollback loss preview and lease-conflict tests pass. No production v2. |
| M3.5 | Importers for PropertyScope (`visual/runs/<id>/entry.json`, `images.json`, `img/<sha256>.png`) and TracePilot history, run unprivileged | Formats documented from real samples; no legacy JS/HTML run; counts, image hashes and known classifications preserved or deltas explained; `import-<digest>` IDs; rerun is idempotent |
| M3.6 | Self-review workflow (07 §6) | A viewer PR shows its own visual changes; the PR's publisher code never runs with write tokens |
| M3.7 | Canaries: TracePilot and a PropertyScope **fork** on the RC, with imported history; clean-repo manual quickstart | Imports hand-verified; comments correct on current heads; repair and rollback exercised; 7 consecutive daily green checks |
| M3.8 | Final `0.1.0`: rebuild at final version, docs, changelog, support statement | Deterministic + release checks and live smoke pass on the **final** commit; SHA published; a fresh adopter succeeds from the docs alone; no npm/PyPI/GHCR placeholders |

**MVP exit:** every row above, plus M2's live safety evidence and the canary window.

## 7. Spikes

| ID | Question | When | Default if "no" |
|---|---|---|---|
| S1 | Does a publisher-generated PNG render in a PR comment via Camo? (Animated formats later) | M2 | Text link only |
| S2 | Fresh-repo Actions Pages bootstrap, environment, readiness polling, repair after a failed deploy | M0 minimal, M2 integrated | — (this is the chosen path; fix issues found) |
| S3 | Artifact behaviour on full vs failed-jobs-only rerun | Full rerun M2; partial M5 | MVP requires "re-run all jobs" |
| S4 | `job.workflow_repository`/`job.workflow_sha` self-checkout: pinned, nested, old release | **M0**, then every release | Stop and redesign; never moving refs |
| S5 | Do Dependabot/Renovate bump SHA-pinned reusable workflows correctly? | M3, optional | Manual SHA bumps |
| S7 | Store push sizes and repo growth on GitHub over ~50 publishes | M2 | Linear history with periodic squash (PropertyScope's current approach), by ADR |
| S8 | WebP encode/decode cost | M5, only if needed | Stay PNG |
| S11 | Same-repo/fork/synchronize/rerun identities and PR association | **M0 minimal = same-repo** (ADR 0007); fork identity deferred to M2.6, still required before M2 exits | Ambiguous → unassociated with diagnostic |
| S6, S10, S12 | Studio prefill; DOM collector cost; findings precision | M4–M6 | See `future/` |

(S9, pixel-hash normalization, is resolved by 02 §3.)

## 8. Owner decisions (needed now)

1. Reuse of the prototype code is approved. The agent fetches it from the public repos (§1, item 3).
2. Confirm the licence (Apache-2.0 recommended) and the working repo name.
3. Authorize the throwaway spike repo, and later the e2e organisation and bot fork, when M0.5 and
   M2.6 need them.

## 9. Risks

| Risk | Early signal | Response |
|---|---|---|
| TS port doesn't match the prototype | M1.3 golden diffs | Decide per difference: bug in old code (fix + ADR + comparator version) or in the port. Never loosen a golden silently. |
| Orphan-commit store misbehaves on GitHub | S7 push sizes grow | Linear history + squash threshold, by ADR |
| Self-checkout fields unreliable | S4 fails | Stop, redesign release pinning with tests; no moving refs |
| Live fork tests flaky or blocked by approvals | Retries > 1/week | Move timing checks into simulation; manual fork check before release |
| Viewer parity slips | M3.2 > 2 weeks | Ship 0.1 with the M2 viewer plus history; parity modes in 0.2 (same data model) |
| Scope creep | `future/` features appearing in PRs | Park as issues labelled `later` |
| Solo bandwidth | Repeated slips | Cut M4+ scope, never quality gates |

## 10. Definition of done (every task)

- Tests at the right layer (07 §1): unit/property for logic, goldens for outputs, simulation for
  pipeline behaviour, written **before** the implementation for parity and security criteria.
- Trusted-path code (`forge-github`, `store`, `publisher`, `actions/publish`, `report.yml`) gets
  a second review pass against the threat model, and the PR names the threats it touches.
- A schema change includes a migration (or proof none is needed), goldens and a changelog entry.
- `pnpm check` is green, plus the simulation suite for trusted-path changes.
- The handoff lists changed files, commands run with results, acceptance evidence, anything not
  run, and design-doc changes.

## 11. Working with a coding agent

- One task, or a small dependency-complete group, per session. Never "implement PixelWatch".
- Turn §§3–6 into GitHub issues (one per row, "Read first" + "Done when" in the body, milestone
  labels). `gh issue create` can script this.
- Freeze and commit schemas before parallel work consumes them. One writer per shared contract.
- Kick-off template:

  ```text
  Read AGENTS.md, docs/design/00-README.md and the "Read first" sections for <milestone>
  in docs/design/08-implementation-plan.md.
  Implement <task ID>: <task text>. Acceptance: <done-when text>.
  Write the named tests first. Keep core pure. No new runtime dependency in the
  trusted path without an ADR. Start in plan mode and show me the plan before editing.
  Run pnpm check (and the relevant suite) before handing off; report what ran,
  what didn't, and any doc conflict you found instead of guessing.
  ```

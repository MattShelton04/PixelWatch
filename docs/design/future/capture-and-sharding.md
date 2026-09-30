# Future · Capture tooling and sharding (M4–M5)

Not MVP. In M0–M3 adopters keep their own capture code and emit `bundle@1` (`../02-contracts.md`).

## 1. Integration levels

| Level | Adopter writes | Milestone |
|---|---|---|
| 0 · Bundle | Anything that emits valid `bundle@1` (native apps, Cypress, existing suites) | MVP (via converters) |
| 1 · Recipe | `.pixelwatch/views.yml`: targets, determinism, variants, views | M4 |
| 2 · Recipe + hooks | Level 1 + a small `hooks.ts` / `hooks.py` for auth, seeding, custom waits | M4 |
| 3 · SDK | `await snap(page, "f1-overview")` inside existing Playwright e2e tests | M4 |

Levels can mix. Each source writes its own provider-qualified parts.

## 2. Recipe (`views.yml`)

```yaml
version: 1
targets:
  fixture:
    start: npm run fixture
    ready: http://127.0.0.1:5990/healthz
    baseUrl: http://127.0.0.1:5990
determinism:
  clock: 2026-01-01T09:00:00+10:00
  timezone: Australia/Sydney
  locale: en-AU
  random: 42            # seeds Math.random / test UUIDs; don't replace crypto in real auth flows
  animations: freeze
  fonts: wait
  caret: hide
  mask: ["[data-visual-mask]"]
  stableFor: 300ms      # heuristic, not proof of readiness
variants:
  desktop: { viewport: [1440, 1000], deviceScaleFactor: 1 }
  mobile:  { viewport: [390, 844], deviceScaleFactor: 3 }
  light:   { colorScheme: light }
  dark:    { colorScheme: dark }
variantSets:
  full: { axes: [[desktop, mobile], [light, dark]] }
views:
  - id: shared-home
    target: fixture
    path: /
    variants: full
  - id: f1-upload-errors
    target: fixture
    path: /features/data-platform/upload
    steps:
      - click: { role: button, name: Upload }
      - waitFor: ".error-summary"
    capture: { fullPage: true }
```

Before shipping, M4 must define:

- variant-combination precedence, generated variant IDs, and duplicate rejection;
- that every target, variant and include resolves;
- that includes stay inside the config root, with bounded depth and no cycles.

Steps are a closed vocabulary: goto, click, fill, press, hover, focus, select, check, file
input, waitFor, scroll, named hook. Start with the two real adapters' needs. Defer
Storybook/sitemap/route generators until an adopter needs them.

Keep PropertyScope's CSP-safe determinism approach: serve the freeze stylesheet from the page's
own origin via route interception, and don't use `bypassCSP` (see
`../reference/tracepilot-visual-regression-review.md` item 10).

**Capture layout:** one `harness/` checkout of HEAD (recipe, hooks, runner) and one `app/`
checkout of BASE or HEAD, so both revisions are captured with the head's view list. A view
failing on base because its route doesn't exist yet is `failed`/`incomparable`, not `added`,
unless the catalog explicitly marks it absent.

## 3. Hooks and SDK

- Hooks: `beforeTarget`, `context` (auth), `ready` (custom waits). TS and Python share one
  capture-only schema.
- Hooks use synthetic fixture credentials only, since the artifacts are public. Per-hook
  timeouts and cleanup.
- SDK: `test` from `@pixelwatch/playwright/test` adds `snap`. It's a no-op unless
  `PIXELWATCH_OUT` is set, and must be proven not to change ordinary test runs. A failed step
  emits explicit states. The Python equivalent is a pytest-playwright fixture.

## 4. Public CLI and onboarding

- **CLI:** `capture`, `compare`, `serve`, `baseline save|compare`, `pull`, `probe`, `bundle
  init|add|close`, `--in-docker`, `--json`.
  - One TS implementation, also shipped as standalone executables (Node SEA) later.
  - `probe`, `capture` and `lint` **execute project code**; they're not "read-only".
- **`init`:**
  - detects the stack;
  - previews files, then writes pinned workflows and config;
  - asks before any settings change (Pages source, environment);
  - never pushes without asking.
- **Migration:** PropertyScope's `cases.py`/`capture.py` → `views.yml` + `hooks.py`; its
  `dev.py ui visual` → a thin wrapper around `pixelwatch baseline`. Do this in PropertyScope
  only with the team's agreement.

## 5. Dynamic sharding (M5)

- The planner runs on the **untrusted** side. It enumerates the catalog, partitions units
  deterministically (hash or contiguous first, duration-aware bin packing once timings exist),
  and emits a bounded matrix plus a plan digest.
- The publisher can check internal consistency, but can't prove the plan covered everything.
- Trusted config bounds providers, shard counts, units and resources.
- Shard count: a lower bound is `ceil(W / (T − S))` for total work W, setup S and target job
  time T (T > S). Count revision × provider × shard × variant against the 256-job matrix
  limit. `max-parallel` throttles concurrency, not matrix size.
- **Measured PropertyScope job totals** (setup included):

  | Provider | Views | Job time per revision |
  |---|---|---|
  | fixture | 29 | 88–96 s |
  | stack | 13 | 133–135 s |

  More shards repeat setup, so they can raise total minutes while cutting wall time.
- **In-job workers:** start from each adapter's tested value. Standard public Ubuntu runners have
  4 vCPU / 16 GB. Memory may require fewer workers than cores.
- **Caches:** don't cache Playwright browsers by default (Playwright's own advice). Never restore
  capture caches in the publisher.
- **Mixed-attempt reruns** (reusing successful shards from attempt 1 with rerun failed shards)
  need an explicit provenance design and spike S3.
- "1,000 Storybook stories in under 10 minutes" is a benchmark hypothesis, not a promise.

# 04 · Viewer, versioning and migrations

One JSON-driven app renders every run. Trusted, generated entry pages pin the app's exact bytes.
M2 ships a minimal version of **this same app**, and M3 expands it. There is no interim gallery
and no production v1 → v2 migration invented to replace one.

## 1. Entry pages and routing

- App JS lives at `app/<release>/app.js`. It's shared and immutable.
- Each entry page (`<prefix>/index.html`, `<prefix>/runs/<runKey>/index.html`) is generated
  during projection. It contains:
  - title and escaped summary;
  - an absolute `og:image` when a generated PNG preview exists;
  - a loading/error message and a static reload/home link that works without JS;
  - a hash-authorized inline stylesheet;
  - one external **classic** script with `defer`, the exact release path and `integrity`.
- Entries are regenerated on every projection, so upgrades need no data rewrite. Measure their
  size rather than promising "1 KB".
- Routes:
  - `<prefix>/` — history home;
  - `<prefix>/runs/<runKey>/` — one run;
  - `<prefix>/#/pr/<number>` — a PR's runs;
  - `<prefix>/#/views/<unitId>` — a view's timeline.
- In-run state lives in the fragment: provider/view/variant/mode (include provider to avoid
  collisions). Parse and validate fragments before use.
- Resolve paths correctly for a project site (`owner.github.io/repo/`) and a root site. Never
  use root-relative `/app/...`.
- A known expired run gets a static "expired or unavailable" page. Pages has no rewrites, and a
  custom 404 only works at the real site root.
- `file://` isn't supported. Local preview is `pixelwatch-dev serve <dir>` on loopback.
  Single-file export is future.

## 2. Caching and compatibility

- Release paths and `data/v1/...` paths are immutable. `site.json`, streams, PR pointers and
  entry HTML are mutable. Fetch mutable JSON with `cache: "no-cache"`, but assume browser cache,
  Pages CDN, negative (404) caches and Camo are independent and may be stale. Don't assume a
  specific TTL; `max-age=600` is one simulation case.
- The app knows which data versions it supports. If the fetched data doesn't match, it either
  loads a supported immutable namespace or shows an upgrade/reload message. At most **one**
  automatic cache-busting reload, then manual retry. Never loop.
- Ship only the current release's assets. A cached old page whose script is gone shows the
  static reload link. An old cached app that meets new data says so and offers a reload. Never
  copy executable files from the store to keep old clients alive.

## 3. Data versioning and migrations

- The MVP writes `data/v1/`. Run records are immutable, including their comparison
  policy, config hash and provenance. `api/v1` is versioned separately; incompatible API changes
  need `api/v2`.
- **The writer refuses** newer or unrecognized store metadata **before** any mutation ("site
  written by a newer PixelWatch; pin a newer release").
- **Real format change:**
  1. preview affected paths and bytes;
  2. validate the whole retained graph;
  3. create a backup ref (03 §5);
  4. build a new `data/vN/` namespace;
  5. CAS the store tip only when the new records validate;
  6. regenerate indices, API files and entries.

  Never rewrite a file behind an existing `data/v1/` URL.
- Keep the old namespace as a GC root for a 14-day grace period if the budget allows. If the
  migration can't fit the hard budget, refuse and say how many bytes are needed.
- **Reader compatibility:** the new viewer upcasts N−1 data. That does **not** make an old
  viewer understand N+1. Test both directions.
- Migrations are pure: they get bounded blob reads, policy and time injected, with no network.
- **Recompute beats transform, within the evidence available:**
  - new metrics may be absent on old runs;
  - recompute only what retained PNGs support, and record the algorithm version;
  - new thresholds never silently reclassify history, since explicit reanalysis writes a new
    record.
- **View rename:** a bounded, acyclic alias over full unit identity. It can't merge two existing
  histories.
- **Rollback:**
  1. put publishing in maintenance mode;
  2. preview the backup, affected runs and bytes, and require confirmation for any loss;
  3. restore with the **current** expected-tip lease, never a raw `--force`;
  4. reproject and reconcile comments.

  Pinning an older action can't undo a migration, and must fail safely against newer data.
- Until a real v2 exists, test the machinery with a **test-only** future schema.

## 4. Security (shared origin)

- `owner.github.io/repo-a/` and `/repo-b/` share an origin. No tokens, credentials, approvals or
  private data in `localStorage`, `sessionStorage` or cookies. Validate stored preferences on
  every read. A dedicated custom domain is the real isolation option; recommend it.
- The CSP meta tag comes first in `<head>`, generated with real digests, e.g.:

  ```text
  default-src 'none'; script-src 'sha256-<app>'; style-src 'sha256-<inline-css>';
  img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  Add a directive only when a browser test proves it's needed. `worker-src blob:` is allowed only
  with a test proving no data/config selects worker code. Never add `'self'`, `unsafe-inline` or
  `unsafe-eval` to `script-src` to make tests pass.
- No service worker. Never mirror captured HTML/SVG/scripts/DOM into the served tree.
- Render all data with text nodes. Lint bans `innerHTML`, `outerHTML` and `insertAdjacentHTML`.
- **Config into the viewer:** closed theme presets and typed tokens, sections and labels from
  the trusted config. Custom links must be HTTPS with an allowlisted host and typed,
  percent-encoded substitutions, and the **final** URL is validated. No arbitrary CSS, HTML, JS,
  remote fonts or plugins.

## 5. Performance

- Fetch one run and only the images selected. Virtualize long lists.
- Decode and compare one pair at a time in a worker; release bitmaps, buffers and canvases.
- A 1440×6000 RGBA buffer is 34.6 MB, and decoders, copies and GPU surfaces add more. Provide a
  chunked, cancellable main-thread fallback. No `SharedArrayBuffer`.
- If a full diff can't be allocated, degrade to side-by-side plus stats, never a blank page.
- Measure cold/warm open time and peak memory on fixed fixtures (07 §6) before setting a budget.

## 6. Features by milestone

- **M2 (minimal):**
  - run page with before/after images;
  - counts, failures and coverage;
  - source links;
  - the final shell and CSP.
- **M3 (parity with the prototypes):**
  - side-by-side, wipe, overlay, diff, zoom, regions and keyboard;
  - history home, PR view, provider-qualified per-view timeline;
  - theme presets (GitHub light/dark, Fieldbook from PropertyScope, Midnight from TracePilot).

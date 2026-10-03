# ADR 0021: Minimal final viewer and local three-engine acceptance

- Status: accepted (inferred implementation details under the authorized MVP program)
- Date: 2026-10-03
- Task: M2.7

## Context

04 requires one final JSON-driven app, generated entry pages with hash-only CSP/SRI and a
supported loopback preview. M2 implements images, counts, coverage, failures and source links;
full prototype modes/history/themes/cache routing remain M3 after the live M2 exit.

## Decision

Generate trusted entry HTML from validated changes@1 and trusted repository/SiteUrls inputs.
Keep summary/source/reload/home links outside the app root. Compute real script/style hashes
from exact release bytes; never let data select code. One classic deferred app consumes the
static validators in ADR 0020 and renders text nodes with a bounded result selector and only
the chosen pair's images. CSS consists of fixed trusted classes in the hashed entry stylesheet.

In production the observed site base must equal the canonical HTTPS base. Literal HTTP
loopback preview remaps only fixed JSON/pool paths to its observed base after validating
canonical image paths/hash identities; it never proxies remote Pages. Missing/incompatible
JSON or unavailable PNGs retain useful static recovery links. M2 performs no automatic reload.

Add exact development dependency @playwright/test 1.63.0, implementing the Playwright choice
already recorded in 06 §2. It tests the actual esbuild app and generated entries in Chromium,
Firefox and WebKit; it is not a publisher runtime dependency. Keep install scripts disabled.
Install pinned browser binaries separately in ignored .tools/playwright, and enforce a browser
request guard allowing only the actual preview origin. Root owns build/fixture/preview tools,
manifest/lockfile, DOM type libraries and workflow integration.

The preview captures a bounded inventory of generated files before listening. Requests only
select inventory keys. Opening a file binds a checked descriptor to its captured identity,
size and single-link status; bounded reads use that descriptor rather than reopening a path.
This closes a reproduced substitution race after canonical-path validation. Newly generated
files require restarting the preview, which is not a live-reload development server.

## Consequences

No schema/golden/changes@1 byte or trust-model changes. Test fixtures project actual canonical
store/run inputs using core and the final entry/app implementations; they prove local browser
behavior, not served Pages or live fork safety. Three-engine results, an actual local entrypoint
and integrated adversarial review remain required before claiming M2.7 acceptance. No M3
features or production v2 are introduced. Release/tag publication still needs owner approval.

Owner approved a traceability bookkeeping clarification on 2026-10-03: `passing` identifies
the actual named acceptance suite, including separate unfiltered three-engine browser tests.
It does not imply whole-rule/M2/MVP acceptance. Local evidence and remaining hosted/Pages/live
gates are recorded separately in `docs/evidence/m2.7-minimal-viewer.md`.

Primary tooling reference: [Playwright 1.63.0](https://github.com/microsoft/playwright/releases/tag/v1.63.0).

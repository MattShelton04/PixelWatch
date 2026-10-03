# W2-A-BUILD contract and assignment

Root owns action source/action.yml/manifests/lock/workflows/ADRs/version policy and integration.
Build author owns only tools/release/build.ts, build-cli.ts, build.test.ts and bundle-fixture.ts.
Base29393100a2cbf165a878491d2f7e657dce5561b2. Read AGENTS,01 §4,06 §§3–7,07,08 M2.5, ADR0006/
0014/0020/0021/0025/0029, m2-action-release-plan and actual schemas/core PNGworker/viewer builder.

No empty actions package or runtime publisher substitute. Source entry is fixed
actions/publish/src/main.ts. Production release outputs, relative to actions/publish/dist/:
index.js (ESM Node24 host), png-worker.js (separate ESM core worker), app.js (actual classic final
viewer), release.json (canonical metadata/inventory). Root adds action-local type:module with
actual host implementation. The release commit retains that file; source root type is not the
only runtime module-mode proof. No source maps or source TS is needed at runtime.

`buildPublisherArtifacts({sourceRoot,version,sourceCommit})` returns a sorted immutable inventory
of {path,bytes,sha256} for those fixed output paths. Validate full40hex sourceCommit and actual
0.1.0 / 0.1.0-rc.<positive integer> version. No release commit self-embedding; runtime own
job.workflow_sha is actual releaseCommit. Deterministic release.json includes schemaVersion1,
exact version/sourceCommit, Node24 target, artifact paths/sizes/SHA256 and bundled dependency/
license inventory. Do not hash release.json into itself. No timestamps/absolutepaths/randomIDs.

Use existing pinned esbuild0.28.2, no new dependency. Bundle workspace/runtime dependencies and
schema JSON. Host defines __PIXELWATCH_VERSION__ and __PIXELWATCH_SOURCE_COMMIT__ constants.
Actual host later loads only its own fixed sibling app.js/release.json and constructs PngWorker
with new URL('./png-worker.js',import.meta.url). Builder may not replace publisher stage logic.
The PNG worker and final viewer must be actual production entries, not test implementations.
Missing host/main must fail clearly before writing artifacts and remain an integration gate.

The build function performs no Git mutation/network/package install/tag/release. build-cli
writes only a fresh internally bounded directory below sourceRoot/.tools/release-build/, refuses
existing outputs/links/traversal/drive overrides and never force-cleans a caller path. Root alone
adds package scripts. Release branch/clean-worktree creation/force-add-dist/tag decisions are a
following root-owned tool slice; this builder cannot publish or move tags.

Tests FIRST, meaningful named acceptance:

- "missing production action source refuses before creating release artifacts"
- "two isolated builds have identical complete artifact hashes"
- "release metadata records the exact RC or final version and approved source SHA"
- "bundled production PNG worker decodes encodes and compares without source TypeScript"
- "bundled final viewer declares the exact release and uses generated entry CSP SRI"
- "release outputs contain no absolute source paths dynamic TS loader or unbundled dependency"
- "invalid versions short SHAs and unsafe output paths refuse without replacing files"

Unit fixtures for a compiler host may test bundling, but they are explicitly tooling fixtures,
never a publisher or product simulation. Whole production-host bundle acceptance remains pending
until actual main.ts is implemented and built. Do not claim a fixture host satisfies M2.5.
Use actual core worker/viewer/fixtures, offline cached packages/no-network guard, fake canary raw
error/result/output scans; no tests read .reference/GH_TOKEN/real credentials. No changes to
goldens/budgets or generated corpora. No new devDependency or third-party tool download.

Handoff exact immutableSHA, allowed-files-only diff, strict red/final completeunfiltered tests,
lint/types and repeat hashes/actual worker/viewer runtime checks, complete retained raw logs,
what did not run. Independent reviewer A/C who did not author attacks production bundle/metadata/
path safety and final action integration. Root runs fullcheck/fullsimulation/all3browser plus
hosted Linux/Windows reproduction/self-reference. RC/final publication requires explicit owner
approval. No external permission is needed for this local build-tool slice.

# ADR 0020: Static browser validation and viewer build tooling

- Status: accepted (inferred implementation details under the authorized MVP program)
- Date: 2026-10-03
- Task: M2.7 preparation

## Context

04 §4 requires hash-authorized classic app code without unsafe-eval. The schemas entrypoint
initializes Ajv.compile, which generates functions at runtime, and its text helpers use Node's
Buffer. A browser must validate untrusted JSON under the final CSP. 06 §2 already selects
esbuild and Playwright; their implementations have not been installed yet.

## Decision

Generate static site@1 and changes@1 validators with the existing pinned Ajv 8.20.0 during
development/build. Bundle its required existing runtime helpers into one generated ESM file;
no Ajv compiler runs in the browser. The browser entrypoint combines these validators with
the existing bounded strict parser and semantic checks. Unknown versions still refuse. Use
an allocation-free UTF-8 length calculation with the same replacement semantics as Buffer;
do not allocate an encoded copy before checking a string's byte limit.

Pin new development dependency esbuild 0.28.2 for static validator and later app/action builds.
Its native platform executable comes from the pinned optional package; keep dependency install
scripts disabled. No new trusted-path runtime dependency is introduced. The generated file
is regenerated only with the documented command and checked for staleness. It is generated
JavaScript, with generator provenance and a narrow generated-file lint/type-check exclusion;
the typed public wrapper, source schemas, generator and semantic checks remain checked.

## Consequences

Canonical schema contracts and goldens do not change. Tests compare existing site/changes
fixtures, semantic failures and hostile JSON against the Node validator, exercise UTF-8
boundaries without Buffer and execute the static bundle with string code generation disabled.
Three-engine actual viewer CSP/SRI tests remain M2.7 acceptance, not proved by this preparation.
Playwright Test/browser installation is the next owning viewer-test slice, not added unused here.

Primary references: [Ajv standalone code](https://ajv.js.org/standalone.html),
[esbuild 0.28.2](https://github.com/evanw/esbuild/releases/tag/v0.28.2).

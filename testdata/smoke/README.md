# Smoke fixtures

Deliberately bad inputs that prove each `pnpm check` gate actually rejects something. They're
excluded from the normal lint and workflow-lint targets, and are only read by tests under
`tools/`. Never "fix" the bad fixtures.

| File | Used by | Must be rejected for |
|---|---|---|
| `html-sinks.bad.ts` | `tools/eslint-smoke.test.ts` | one HTML-sink error per marked line |
| `html-sinks.good.ts` | `tools/eslint-smoke.test.ts` | nothing (clean) |
| `workflows/insecure.yml` | `tools/lint-workflows.test.ts` | zizmor audits listed in the test |
| `workflows/broken.yml` | `tools/lint-workflows.test.ts` | actionlint errors |

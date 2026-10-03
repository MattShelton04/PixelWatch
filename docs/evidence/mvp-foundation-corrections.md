# MVP audit and foundation corrections

- Date: 2026-10-03; local Windows, Node 22.19.0, pnpm 10.34.6, Git 2.41.0.windows.3.
- Baseline: `59221ba4bfd3b8214440990e5c044503e9c53049`, verified remote main; PR #15 merged.
- Corrective source: committed with this record on codex/mvp-foundations; ADR 0016.
- Independent agents: audit_m0_m1, audit_m2_m3, review_program; four total including root.

## Actual commands and results

- `pnpm check` at the unchanged baseline: exit 0, 27 files / 672 tests; lint/types and
  actionlint/zizmor passed. Vitest 50.35 s. A sandbox attempt first failed at startup with
  spawn EPERM; permitted execution reran it. Output captured in ignored
  `.tools/program-baseline-check.log`.
- `pnpm -s test:simulation`: permitted baseline execution exit 2, 9 harness checks
  passed, 0 product cases ran, 14 NOT RUN / 11 IDs. Normalized lease digest remained
  `81ffc411a10649a6271b55652ccc84c0fa1a8c5bba637e776d0cb995f53d49fe`.
  First sandbox attempt exit 1 because isolated Git could not start (7 PASS / 2 FAIL).
- AUDIT-A `node tools/check-reference-conversion.ts`: exit 0, 8/8 parts validated;
  PropertyScope 42 units/revision, TracePilot 105. Pinned source and eight recorded
  comparator/vector digests inspected. Reference files are ignored and never test inputs.
- Tests before implementation: housekeeping/ingest exit 1, 3 failed / 32 passed (35).
  Missing-provenance identity regression exit 1, 1 failed / 6 passed (7).
  Review's grace regression exit 1, 1 failed / 27 passed (28).
  Cancellation-before-staging regression exit 1, 1 failed / 7 passed (8).
- After primary fixes, targeted housekeeping/ingest exit 0, 2 files / 35 tests.
- After grace/provenance corrections, targeted housekeeping/ingest/projection/identity/
  generated-types command exit 0, 5 files / 63 tests. Exact projection goldens unchanged.
- `pnpm schemas:types`: exit 0; regenerated optional provenance fields.
- Independent REVIEW-PRE: permitted no-network suite exit 0, 2 files / 36 tests;
  separate hostile probes reproduced both original graph bugs and verified their fixes,
  selected unknown-schema refusal, ignored/duplicate artifacts and injected deadline.
  Review's first sandbox attempt failed at startup; no tests ran in that attempt.

## Review and limits

Two P1 graph findings fixed with tests: unknown expired indexed run, and malformed expired
grace references. Reviewer found cancellation during decoding still staging a blob; a new
red regression and post-decode cancellation check fix that path. REVIEW-PRE-FINAL independently
verified it and the optional-provenance/schema/golden/traceability changes: the command
`pnpm test packages/core/test/housekeeping.test.ts packages/core/test/ingest.test.ts packages/core/test/changes-projection.test.ts packages/schemas/test/identity.test.ts packages/schemas/test/generated.test.ts tools/threat-model.test.ts`
exited 0, 6 files / 70 tests (4.63 s), under the existing no-network guard.
Publisher must still stage privately and never commit after a refused ingestion, and pass
the combined cancellation signal to its production codec. Cross-shard unit overflow can
still do bounded admission work before its existing refusal; no bound was removed.

Optional provenance was explicitly approved after read-only REST investigation. No capture
OIDC permission or invented authority. All existing changes.json bytes remain pinned;
inlined served schema definitions change as disclosed in ADR 0016. No recorded golden or
hostile corpus was edited, no dependency added, no GitHub setting changed.

Corrective `pnpm check`: exit 0, 27 files / 679 tests (42.02 s), lint/typecheck/actionlint/zizmor
passed. An initial attempt stopped at one unnecessary type assertion; corrected and rerun.
`pnpm -s test:simulation`: exit 2, 9 harness PASS, 0 product cases ran, 14 NOT RUN / 11 IDs.
Logs: `.tools/program-pre-check.log`, `.tools/program-pre-simulation.log` (ignored).
Hosted PR #16 exact head `3ef45da`, CI run `37096070619`: Ubuntu 24.04 and Windows 2025
checks pass, 27 files / 679 tests each. Both full simulation commands report exit 2, 9 harness
PASS / 14 NOT RUN and identical normalized digest above. Jobs remain red; Windows wrapper
reports job exit 1 after pnpm's exit 2. CodeQL and dependency review pass. Logs read with
`gh run view 37096070619 --repo MattShelton04/PixelWatch --log`, saved in ignored
`.tools/foundation-ci.log`. No complete product coverage claim.
Core exports additionally expose the
existing bounded PNG structure and store-path validators for adapters; no new validator or dependency.
All 14 product simulations, browser, live fork, real publisher Pages/comments, action/release,
canaries and adoption remain unproved. Historical spikes are not product acceptance.

# ADR 0032: Scoped report workflow lint policy

- Status: accepted development policy, inferred under ADR 0014 and independently reviewed; publisher/runtime/live acceptance remains gated
- Date: 2026-10-04
- Scope: M2 trusted reusable workflow and fixed report caller

## Context

01 §3 requires an adopter-side `workflow_run` trigger followed by a full-SHA-pinned reusable
workflow. That trigger ingests failed and cancelled captures as evidence. The capture workflow
has only contents-read authority; the trusted publisher independently authenticates source,
repository, workflow, attempt and PR association and validates all data before writes.
ADR 0006 retains the publisher's own-workflow self-checkout and verified HEAD mechanism.

The original generated caller produces one HIGH `dangerous-triggers` finding in
zizmor 1.30.1, exit 14. This is a general warning about the architectural privilege boundary,
not evidence that merely avoiding PR checkout proves safety. Argument injection, environment
injection and local file inclusion also need the publisher's bounded parsers, fixed API targets,
sanitized Git, owned filesystem and no capture execution boundaries. Full production simulations,
same-repository and fork live runs, released self-reference and served-byte evidence remain gates.

The pinned tools are unchanged: actionlint 1.7.12 and zizmor 1.30.1 from
`tools/lint-tools.json`. Verified local executable SHA-256 values are
`54ca21be3de4c7cfa26914aa8b61bd76bf573ef3caac5f80d110558cdf241718` (Windows actionlint) and
`4ace959d58c0dc48659c3eeefc4bb9e3b18197c174e5e997d2f8e0896f0d3c9e` (Windows zizmor).
The pinned archive digests for each supported platform remain in that manifest.
ADR 0006 already records actionlint's unknown `job.workflow_*` fields and zizmor's LOW
`self-repository` findings. The new own-identity guard uses bounded `toJSON(job)` followed by
exact fixed repository and full SHA validation. Actual serialization of the own fields must
still be proved in released GitHub runs; missing fields refuse with no fallback.

## Decision and remaining product gates

Keep both linters enabled, offline, with their existing exit semantics. Keep every existing
insecure and broken fixture unchanged, including the `dangerous-triggers` detection assertion.
Never ignore unknown contexts, disable an audit globally, filter arbitrary findings, or replace
the normative trigger with an inapplicable event merely to pass lint.

A one-line trigger annotation may apply only to the exact fixed report caller: top-level empty
permissions, one job using the canonical PixelWatch reusable workflow at one validated full SHA,
the exact permission union, and no steps, caller code, caches, extra jobs, inputs or inherited
secrets. A structural gate must reject a changed trigger, added run/checkout/cache job, secret
forwarding, moving/foreign pin, duplicate fields or other bytes outside that fixed contract.
The manual older-RC caller has no dangerous trigger and needs no such annotation.

The four local action uses in the actual reusable workflow may receive only their individual
`self-repository` annotations after independent validation of both own guards, fixed self-checkout,
HEAD verification, exact per-job permissions, and the one stable project lock. An exact reviewed
workflow digest must make subsequent source changes fail the development gate until reviewed.
Tests must reject caller checkout, moving ref, bypassed HEAD verification, changed lock or
cancellation policy, unconditional projection, foreign local action and restored cache.

Annotations require tests-first negative controls, independent security review and unchanged
original reproducer closure. Their unannotated diagnostics and raw logs remain evidence. They
do not approve runtime publishing, external setup, RC publication or M2 exit. This policy
does not change 01 §4's security model or assert an owner decision to adopt `$/`.

The actual lint CLI now calls the approved fixed-tree consumer before target
enumeration, tool lookup or subprocess creation. Its hard-coded reviewed workflow SHA-256 is
`cacf24fb75cec62a16989d61763f3633a7dc16fdda202dc47799c89599d5c619`; no environment or caller
argument can replace it. It differs from the independently approved unannotated
workflow only by the four individual comments described above. The CLI's two new tests first
fail against the unchanged implementation, and its complete nine tests pass after integration.
The annotation regression first reports 12 PASS / 1 FAIL, then the integrated four-file suite
passes 30/30 with focused lint, whole types and both actual pinned workflow linters. Independent
integrated replay also passes all 30 tests (10.48s), focused lint, whole types and actual workflow
lint. The preserved 47 policy, 28 native tree, 22 own-identity and 22 mutant probes pass.
Eleven actual guarded CLI refusals retain annotations and receive a matching digest through
environment/extra arguments, yet perform zero tool lookup or spawning. Its valid control
reaches the absent-tool failure. Forty-four physical artifacts and decoded raw values have
zero scan failures. Original unannotated diagnostics, strict-red logs and all insecure/broken
fixtures remain intact; the annotations do not establish runtime or live proof. The generated
capture caller integration also has independent scoped closure: its complete 22 cases,
unchanged 15 guarded standalone children, two-root six-file hashes, both actual linters and
original hostile controls pass. That approval covers local capture tooling, with production
bundles and live publishing still unproved.

## References

- [zizmor dangerous-triggers](https://docs.zizmor.sh/audits/#dangerous-triggers): retained triggers
  need case-specific elimination of execution risk.
- [zizmor inline annotations](https://docs.zizmor.sh/usage/#ignoring-results): a single finding
  can be annotated without disabling its audit elsewhere.
- [ADR 0006](0006-s4-reusable-workflow-self-checkout.md),
  [M2 action plan](../program/m2-action-release-plan.md), and
  [normative architecture](../design/01-architecture-and-security.md).

# ADR 0030: Native store lifetime and test scheduling

- Status: inferred corrective implementation contract under ADR 0014; scoped independent review approved; complete corrected local acceptance passed
- Date: 2026-10-03
- Task: M2.2 lifecycle correction and complete integrated check

## Context

The final integrated check at `83330d2` failed two existing Git-branch tests at the unchanged
30000ms deadline and then failed cleanup with EBUSY. Vitest timeout does not cancel the
underlying promise. Code inspection found that synchronous close could remove the client
scratch while a pack read still owned an open descriptor or a Git child whose cwd was inside
that scratch. That is a concrete lifetime gap; it does not establish the original timeout
cause or prove that concurrent suite load caused those two failures.

## Decision

`GitBranchStore.close(): Promise<void>` becomes terminal and idempotent. It stops admission
of new reads/CAS/file reads, cancels privately owned asynchronous work, waits for native child
and descriptor cleanup, and only then removes the validated internally generated scratch.
Injected checkpoints/transport waits cannot indefinitely prevent closure. A new close does
not reinitialize the store. Callers await it before deleting their isolated remote/fixture.

Cancellation before sending a push prevents that push. Cancellation after a sent push does
not claim remote refusal or undo accepted state: preserve the adapter's existing accepted or
unknown outcome and private attempted commit receipt for bounded recovery. Native diagnostics
and cancellation reasons remain private fixed errors. No credential/config/protocol/ref,
process bound, byte limit or explicit-lease requirement changes.

Unit/property files and native fixture files run in disjoint ordered Vitest projects. The
native phase has fileParallelism:false; harmful actors inside each race test still execute
together. Both phases keep the same discovery patterns, no-network setup, empty-run failure
and 30000ms default. Simulation's already-governed deterministic timeout exemptions remain
unchanged. This makes native file scheduling explicit rather than widening test deadlines.

Runtime discovery found that a parent test.include array is concatenated into project-local
arrays by the pinned Vitest/Vite merge. The initial integrated command passed2060tests/102files
in684.36s, but45unit files/872cases ran twice; this was not disjoint scheduling acceptance.
Discovery now lives only inside each project. Root and independent runtime inventories both
find exactly57unique files (45unit/12native), matching every original include/exclude path
with zero duplicates, omissions, additions or misclassification. Approved build tooling adds
one native file, giving58unique=45unit/13native. Actual corrected complete check exits0 with
1197tests/58files/630.46s, including lint/types/workflow lint. The duplicated first command
result remains retained as historical evidence and is not substituted for this corrected run.
Full simulation executes3product cases with11NOTRUN/exit2; all25hashes match prior/reviewed
evidence. All24browser cases pass across three engines. Exact-head hosted evidence remains a gate.

## Consequences

Existing tests, native harmful interleavings, cancellation/cleanup regressions and independent
falsification review remain required. A passing targeted suite is not a green complete check.
The original failure remains in its evidence log; exact new complete check/full simulation,
browser and hosted Linux/Windows evidence must be recorded after execution. No source/schema,
canonical golden, comparator, public API byte, dependency or GitHub setting changes are implied.

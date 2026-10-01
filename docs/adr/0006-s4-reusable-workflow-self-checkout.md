# ADR 0006: S4 confirms reusable-workflow self-checkout

- Status: accepted
- Date: 2026-09-30
- Task / spike: M0.5 / S4

## Context

06 §3 says the publisher loads its own bundle by checking out `job.workflow_repository` at
`job.workflow_sha`, failing if either is missing, and never using moving refs or the caller's
`github.sha`/`github.repository`. Release acceptance must prove three cases: a foreign caller
pinned by full SHA, a nested call, and an old release after a newer one exists. Until now this
rested on GitHub's documentation only (`platform-facts.md`, "S4 pending"). If it failed, 08 §9
says stop and redesign.

Evidence: [docs/evidence/s4-self-reference.md](../evidence/s4-self-reference.md). Two throwaway
public repos: `MattShelton04/pixelwatch-spike-lib` (ID 1397667754) holds the reusable workflow and
bundle at commit A `9c54426c3e5e46bdb6df13819e055a14376fc449` (`v0.0.1`, bundle v1) and commit B
`7f0ec44808846b50c31387574fac840c21ed85f2` (`v0.0.2`, bundle v2). `MattShelton04/pixelwatch-spike-app`
(ID 1397668282) calls it and contains an impostor `actions/publish/` at the same relative path.

Observed on 2026-09-30 (runs 36706474440, 36706493124, 36706504065, 36706509879, 36706515828,
36706519711 in the app; 36706524252 in the lib; all attempt 1):

- **Foreign SHA pin.** A caller pinned to B ran bundle v2 from B in both the ingest-shaped and the
  project-shaped job. `job.workflow_repository`/`job.workflow_sha` named the library and B, and the
  checked-out `HEAD` equalled B. The caller's `github.repository`, `github.sha` and
  `github.workflow_sha` all named the caller.
- **Old release after a newer one.** A caller pinned to A, dispatched after B was pushed and
  tagged, ran bundle v1 from A.
- **Nested calls.** app → lib `outer.yml@B` → `./.github/workflows/report.yml` ran v2 from B, and
  the outer job's own fields also named B. app → local `wrap.yml` → lib `report.yml@A` ran v1
  from A.
- **Negative control.** A lib workflow that uses the default checkout plus `uses: ./actions/publish`
  ran the caller's impostor. The hazard 06 §3 describes is real, and the assertions detect it.
- **Missing fields.** The guard failed before any checkout for blank repository, blank SHA, both
  blank, SHA `main`, SHA `v0.0.1` and a 7-character SHA. GitHub.com always populated the fields in
  practice, so "missing" could only be exercised by feeding the guard blank values.
- **Permissions.** The called jobs got exactly their own 01 §4.2 sets out of the caller's union
  (log section "GITHUB_TOKEN Permissions").
- **`uses: $/…`.** GitHub added a self-repository syntax on 2026-07-30 that resolves to the
  running workflow's own repository and commit with no checkout. It gave the same results as the
  self-checkout for the foreign pin, the old pin and a nested call (`$/.github/workflows/…`).
- **Tooling.** actionlint 1.7.12 rejects the `job.workflow_*` properties and `$/`. zizmor 1.30.1
  flags every `uses: ./…` with `self-repository`.

## Decision

1. S4 passes. 06 §3's self-checkout stays the MVP mechanism: the guard (full 40-hex SHA and an
   `owner/repo` repository, else fail) runs before any checkout, and after checkout the job
   verifies `HEAD` equals `job.workflow_sha`. No moving refs.
2. `job.workflow_ref` is **not** used to locate code. For a direct run it holds a branch ref
   (`…@refs/heads/main`), not a SHA.
3. `uses: $/…` is recorded as a verified **alternative**. Switching to it is an owner decision,
   not made here. It would remove the checkout step, the `_pixelwatch` path and the
   `HEAD` check, but it is two months old and actionlint doesn't parse it yet.
4. The S4 acceptance cases (foreign pin, nested call, old release, missing-field guard, negative
   control) become the M2.5 release self-reference test (`tools/release/self-reference.test.ts`).

## Consequences

- Threat model: R4.2-03's S4 evidence row becomes `recorded`, pointing here. The M2.5 live test
  row stays `planned`. A `recorded` row for R4.2-06 records the per-job permissions seen inside a
  foreign-called reusable workflow (the M2.6 report-run row stays).
- `platform-facts.md`: the `job.workflow_*` row's "Live" column points here.
- M2.5 must bump actionlint (or add a narrow ignore) before `report.yml` can pass
  `pnpm lint:workflows`, and must decide how to treat zizmor's `self-repository` finding.
- Open for the owner: adopt `$/` instead of the self-checkout in M2.5 (would need a 06 §3 edit and
  a rerun of these cases), or keep the self-checkout.

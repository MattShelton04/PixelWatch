# Evidence

Manual and live evidence records (07 §7). Each record states the date, the PixelWatch commit,
the repository/run/attempt/deployment IDs, runner and browser versions, redacted observations,
and pass/fail. Decisions drawn from evidence go in `docs/adr/`. The threat model
(`docs/security/threat-model.md`) points at these files from its `recorded` rows.

Everything here is public. Records hold IDs, SHAs, logins and synthetic content only: no tokens,
signed URLs, emails or real screenshots.

| Record | Spike / task | Result | ADR |
|---|---|---|---|
| [s2-pages-bootstrap.md](s2-pages-bootstrap.md) | M0.5 / S2 Actions Pages bootstrap, readiness, repair | pass, readiness wording corrected | [0005](../adr/0005-s2-actions-pages-bootstrap-and-readiness.md) |
| [s4-self-reference.md](s4-self-reference.md) | M0.5 / S4 reusable-workflow self-checkout | pass | [0006](../adr/0006-s4-reusable-workflow-self-checkout.md) |
| [s11-same-repo-identity.md](s11-same-repo-identity.md) | M0.5 / S11 same-repo PR identity (fork → M2.6) | pass (same-repo only) | [0007](../adr/0007-s11-same-repo-identity.md) |

`recordings/` holds machine-readable data behind these records: `s2/timings.json` and the redacted
S11 payloads and REST responses, one directory per run and attempt (`capture-<run>-a<n>`,
`report-<run>-a<n>`).

## Spike repositories (M0.5)

Throwaway public repos on the owner's account, authorized by the owner on 2026-09-30. They hold
only spike code and synthetic data. Deleting or archiving them is the owner's call.

- https://github.com/MattShelton04/pixelwatch-spike-lib (ID 1397667754): reusable workflows and
  the stand-in bundle.
- https://github.com/MattShelton04/pixelwatch-spike-app (ID 1397668282): caller, synthetic Pages
  site, S11 capture/report recorders.

Their Actions logs expire about 90 days after the runs (GitHub's default for public repos). The
records and `recordings/` here are the durable copy.

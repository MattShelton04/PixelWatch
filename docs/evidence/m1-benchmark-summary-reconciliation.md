# M1 benchmark summary reconciliation

Read-only reconciliation on 2026-10-03. No benchmark command was run and no measured record,
prototype output, golden, assertion or budget was changed.

The evidence index and ingestion threat row still summarized the pre-ADR 0010 measurements.
Git history establishes the origin and replacement of those numbers:

| Committed record | Earlier record | ADR 0010 record (`b7e1cde`) |
|---|---|---|
| `m1.1-png-bench.md`, max-canonical peak RSS | 209 MiB at `94f21c0` | 202 MiB |
| `m1.4-ingest-bench.md`, tall-ingest-worker peak RSS | 195 MiB at `a70eece` | 177 MiB |
| `m1.4-ingest-bench.md`, max-zip expanded bytes | 495.3 MiB at `a70eece` | 495.0 MiB |

The replacement records are the existing committed 2026-10-02 benchmark tables. ADR 0010
explicitly records rerunning the PNG/ingestion benchmarks after its one-inflate-pass and
contract simplifications. The summary correction now names those tables' values. Earlier
values remain valid descriptions of their earlier records, rather than evidence of a fresh
run or of the current integration's acceptance.

Verification used `git show <commit>:docs/evidence/<record>` for each of the three commits
above and read the present tables and ADR 0010. Every read exited 0. Individual raw child
measurements were not recovered or remeasured in this session; this reconciles committed
record provenance, not a new independent peak-RSS experiment. Current native lifecycle,
full-check, simulation, browser and live gates remain separate.

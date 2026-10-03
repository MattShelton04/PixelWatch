# Local simulation (M2.4, ADR 0015)

`pnpm -s test:simulation` runs nine real harness checks and reports the 11 stable product
scenario IDs (14 table cases). All product cases currently say **NOT RUN**; the command exits 2.
This is deliberate incomplete coverage, not a successful pipeline test. A failing harness
check exits 1. Help/bad arguments exit 4. There is no filtered or empty success mode.

`pnpm check` runs the separate harness tests in `self.test.ts`. It does not claim that absent
store, forge, publisher, viewer or migration code passed. The full coverage CI job remains
non-green until those adapters actually execute all cases.

- `schedule.ts`: explicit generator checkpoints/barriers, xorshift32 seeds and injected time.
- `faults.ts`: actor/point/occurrence injection, with mandatory reachability assertions.
- `git.ts`: only generated temporary bare repositories and explicit leases; never the checkout.
- `github-shapes.ts` / `github.ts`: typed official-doc subsets and strict scripted responses.
- `cdn.ts`: independently cached paths/edges, virtual TTLs and explicit regression scripts.
- `capture.ts`: bounded/redacted captured output plus independent canary assertions.
- `checks.ts`: shared executable harness checks; normalized trace hashes are repeatable.
- `scenarios/`: written stimuli, prerequisites, barriers, faults and executable assertions.
  Two files also export explicitly partial GitHub/lease probes. Their product cases stay NOT RUN.

There is no network, real token lookup, sleep or ambient randomness in the suite. No dependencies
are added. All I/O stays here. ADR 0015 records the owner-approved scope correction, inferred
decisions, official shape sources and the prerequisites for activating real product cases.

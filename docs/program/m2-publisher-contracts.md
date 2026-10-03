# M2.3 publisher contracts — freeze 1

Dependency source: merged main `ce226ca` (forge/config/store/real drivers) plus independently
reviewed viewer source, integrated branch `47e0626`. This contract freezes disjoint authors;
it does not prove absent publisher code. ADR 0022 records inferred details and owner decisions.

## Shared DTOs (root owns the actual types, exports and manifests)

```ts
interface PublisherContext {
  readonly config: Config;
  readonly configCommit: string;
  readonly pages: PagesSite;
  readonly repository: { readonly repositoryId: string; readonly owner: string; readonly name: string };
  readonly assets: { readonly release: string; readonly releaseCommit: string; readonly script: Uint8Array };
}
interface AssemblyInput extends PublisherContext { readonly snapshot: StoreSnapshot }
interface SizingInput extends PublisherContext { readonly tree: StoreTree }
interface AssembledFile {
  readonly path: string; // relative to validated prefix, applied exactly once by later writer
  readonly bytes: Uint8Array;
  readonly category: SiteCategory;
  readonly immutable: boolean;
  readonly sha256: string; // computed from captured bytes, never caller claims
}
interface AssembledSite {
  readonly generation: string;
  readonly storeTip: string;
  readonly configCommit: string;
  readonly releaseCommit: string;
  readonly urls: SiteUrls;
  readonly files: readonly AssembledFile[];
  readonly totalBytes: number;
  readonly breakdown: Breakdown;
  readonly overSoftLimit: boolean;
}
// Implemented by assembly author. No filesystem/network/store mutation.
assembleSite(input: AssemblyInput): Promise<AssembledSite>;
measureSite(input: SizingInput): ProjectedSizes;

interface AdmissionDependencies {
  readonly context: PublisherContext;
  readonly metadata: CommitMetadata;
  readonly now: string;
  readonly prStates: ReadonlyMap<string, PrState>;
  readonly pins?: ReadonlySet<string>;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly jitter: (attempt: number) => number;
  readonly checkpoint?: (event: WriterCheckpoint) => Promise<void>;
}
type AdmissionResult = WriteRunResult | {
  readonly status: "expired";
  readonly runKey: string;
  readonly tip: string;
  readonly reason: ExpiryReason;
  readonly attempts: number;
};
admitRun(adapter: StoreAdapter, input: WriteRunInput, dependencies: AdmissionDependencies): Promise<AdmissionResult>;
```

No caller generation override, retention recompute callback, omission flag, size override,
write destination or artifact-selected release is introduced. Policy/limits derive from the
privately captured trusted config. Fixed errors use `PublisherError` and redact no secrets by
echoing untrusted errors. Root owns that error/type module, source exports and package manifests.

## Assembly and measurement invariants

- Synchronously privately capture all config/store/runs/listing/repository/Pages/release/app
  bytes and the bounded read callback before any await. Copy each returned byte array once
  immediately. Preflight unknown versions and the complete reference graph before reads or
  selection, including records which retention might expire. Validate repo identity and OIDs.
- Assembly requires a real nonnull tip; reuse `generationId` with captured actual tip,
  releaseCommit/configCommit and `PROJECTION_VERSION`. A marked empty store can render home.
  Absent store refuses; no fake served tip/generation.
- Use existing `projectSite` and actual `renderEntry` for home and EVERY indexed snapshot
  run. The caller supplies the validated post-GC snapshot; assembler has no retention authority.
  Preserve canonical immutable run/PNG/changes bytes. Revalidate run-record bytes against
  private records, exact listed size, PNG structure and derived byte hashes. Existing pixel
  blobs are neither decoded nor rehashed (ADR 0010).
- Copy only indexed records, referenced canonical blobs and all validated derived files
  (references unknown under ADR 0012). No store.json, orphan blobs, stored JS/HTML/SVG, old
  app releases or arbitrary active files. Sort unique relative generated paths. Derive
  categories/digests internally; reuse core generated-file immutable flags; run/changes/blob/
  derived/current-app bytes immutable, generated HTML and mutable metadata remain rebuildable.
- Measure all final served bytes/category, shared pools once, with configured limits. Refuse
  hard budget before read-heavy output allocation; warn soft overage with exact breakdown.
  Generated/served JSON must remain within the actual viewer's 1 MiB limit. No budget changes
  to make a failing case pass. Owner approved 400/500 MiB as configurable defaults, keeping
  existing config@1/core limits up to 1 GiB; schema/goldens unchanged.
- `measureSite` is pure: actual trusted app and entry HTML sizes plus core `projectedSizes`.
  Pre-CAS uses a fixed-width 64-hex measurement-only generation, never emitted as provenance.
  Fixed site/index sizes are conservative upper bounds over retained subsets; exact assembly
  total need not equal planner total but must not exceed that bound. Never use fake renderer
  sizes or test-only publisher code. Later consumers recapture output and validate hashes and
  path/category ownership before async writing/deployment/readiness.

## Controlled admission and receipt invariants

- Keep foundation `writeRun` strict. `admitRun` privately captures input/bytes/context/policy,
  now/metadata/PR states/pins and injected operations before first await, validates the complete
  appended candidate, calls real `measureSite` and `planHousekeeping`, then applies ONLY exact
  GC store/deletion output. No arbitrary caller callback can remove an accepted run.
- Existing immutable run admission returns the actual stored record without replacing it.
  New retained record/blob bytes remain unchanged. If actual successful housekeeping has
  `newRunExpired`, output `expired` only after confirming this exact transaction. It has no
  retained page/comment availability. Malformed input is not exempt merely because it expires.
- Minimal root-owned `CasResult` extension: `unknown` may carry `attemptedTip: string` supplied
  by the adapter from its own completed candidate commit. Native Git knows this OID before
  push; no token/error/transport data chooses it. Unknown without a receipt stays unconfirmed.
  Accepted and conflict contracts stay unchanged; no schema or canonical byte change.
- Expired unknown recovery requires refetched actual tip equal to captured attemptedTip AND
  complete path/byte equality with the privately validated final candidate. An absent run key,
  same transaction counter, timestamps, partial bytes or a later writer's tree cannot prove it.
  If superseded, revalidate/recompute from original input/time under a fresh lease, at most five
  attempts. Exhausted ambiguous recovery refuses without claiming stored/deployed/served.
- Retained unknown admission may prove the actual immutable existing record using the existing
  accepted-first semantics; never overwrite it. Backoff uses injected delay/deterministic jitter;
  no wall clock/random/sleeps/credentials in simulations. Production default remains bounded.

## Ownership, assignments and acceptance

- W2-P-A: assembly author `audit_m2_m3`; isolated branch/worktree, only
  `packages/publisher/src/assemble.ts`, `sizing.ts`, `assembly-input.ts` and
  `packages/publisher/test/assemble.test.ts`, `sizing.test.ts`. No shared types/exports/manifests.
  Tests first: complete real allowlist; unchanged changes@1 goldens; prefix once; deterministic
  sorted hashes; all graph/unknown/ref mismatches before reads; async metadata/byte mutation;
  same-size run/derived changes; canonical PNG reuse; exact pool/category sizes; soft/hard refusal;
  actual JSON limit; conservative bound for every retained subset. No I/O/deploy/comment.
- W2-P-B: admission author `audit_m0_m1`; separate worktree, only
  `packages/publisher/src/admission.ts`, `admission-input.ts` and
  `packages/publisher/test/admission.test.ts`. Consumes frozen root DTO and W2-P-A `measureSite`;
  tests/preparation may proceed before its implementation, final passing acceptance depends on it.
  Tests first: normal unchanged stored admission; real policy-expired input; unknown accepted
  expired exact receipt/tree; later writer supersession; unknown without receipt; mismatched
  candidate bytes; five conflicts/unknowns; malformed expiring graph; mutable context/time/bytes;
  protected hard-budget refusal; malicious omission callback is absent/strict writeRun remains.
- Root: store receipt regression and minimal Git adapter extension, actual shared type/error/index/
  manifests/lockfile, threat-model exact titles, ADR numbering, cross-cutting docs/workflows,
  directory writer/orchestration/deploy/readiness/comments and simulation integration. Do not
  commit an empty publisher package; commit it with actual implemented source after tests.
- Independent reviewer `review_program`: both security and correctness/concurrency passes on
  authors' actual committed code, hostile inputs and harmful interleavings; verify every blocker
  fix. Then review integrated output again. Authors cannot approve their own implementation.
- Handoffs: exact base/source SHAs, diff/files, initial red tests, actual commands/exits/counts/logs,
  raw fake-canary/signed-URL scan, remaining gates. Focused tests/lint/types, then integrated
  `pnpm check`, unfiltered `pnpm test:simulation` (honest exit2 pending12cases) and
  `pnpm test:viewer` all three engines. Hosted Linux/Windows proof before merge.
- No external permissions for these local slices. Live infrastructure, M2 exit, full14case
  coverage and M3 remain distinct gates; no production v2 or future work.

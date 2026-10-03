import { canonicalBytes, type Run } from "@pixelwatch/schemas";
import { addRun, runRecordPath } from "@pixelwatch/core";
import { cloneCandidate, immutableBeforeWrite, metadata, validateCandidate } from "./validate.ts";
import { refuse, type CasResult, type CommitMetadata, type StoreAdapter, type StoreCandidate, type StoreSnapshot } from "./types.ts";

export interface WriteRunInput { readonly run: Run; readonly blobs: ReadonlyMap<string, Uint8Array> }
export interface WriterCheckpoint { readonly point: "after-read" | "before-cas" | "after-cas" | "after-unknown-read"; readonly attempt: number; readonly tip: string | null; readonly result?: CasResult["status"] }
export interface WriteRunDependencies {
  readonly metadata: CommitMetadata;
  readonly delay: (milliseconds: number) => Promise<void>;
  /** Deterministic/injected integer 0–1000; no ambient random source. */
  readonly jitter: (attempt: number) => number;
  readonly checkpoint?: (event: WriterCheckpoint) => Promise<void>;
  /** M2.3 supplies retention/budget/GC admission. Default append is foundation only. */
  readonly recompute?: (snapshot: StoreSnapshot, candidate: StoreCandidate) => Promise<StoreCandidate>;
}
export interface WriteRunResult { readonly status: "stored"; readonly tip: string; readonly run: Run; readonly added: boolean; readonly attempts: number }
function existing(snapshot: StoreSnapshot, runKey: string, attempts: number): WriteRunResult | undefined {
  const run = snapshot.runs.get(runKey); if (run === undefined) return undefined;
  if (snapshot.tip === null) refuse("store-graph-invalid");
  return { status: "stored", tip: snapshot.tip, run: structuredClone(run), added: false, attempts };
}
export async function writeRun(adapter: StoreAdapter, input: WriteRunInput, dependencies: WriteRunDependencies): Promise<WriteRunResult> {
  // Freeze accepted inputs before the first asynchronous boundary/retry.
  const run = structuredClone(input.run); const blobs = new Map([...input.blobs].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
  const acceptedBytes = canonicalBytes(run);
  const acceptedMetadata = { ...dependencies.metadata }; metadata(acceptedMetadata);
  let prior: StoreSnapshot | undefined;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = prior ?? await adapter.read(); prior = undefined;
    await dependencies.checkpoint?.({ point: "after-read", attempt, tip: current.tip });
    const done = existing(current, run.runKey, attempt); if (done !== undefined) return done;
    const files = new Map<string, Uint8Array>();
    for (const file of current.files) files.set(file.path, await current.readFile(file.path));
    for (const [path, bytes] of blobs) {
      if (!path.startsWith("blobs/")) refuse("staged-blob-path-refused");
      if (!files.has(path)) files.set(path, bytes);
    }
    const store = addRun(current.store, run).store;
    files.set(runRecordPath(run.runKey), Uint8Array.from(acceptedBytes)); files.set("store.json", canonicalBytes(store));
    let candidate: StoreCandidate = { store, runs: new Map([...current.runs, [run.runKey, structuredClone(run)]]), files, metadata: { ...acceptedMetadata } };
    candidate = cloneCandidate(await dependencies.recompute?.(current, candidate) ?? candidate);
    if (candidate.metadata.timestamp !== acceptedMetadata.timestamp) refuse("accepted-metadata-changed");
    const accepted = candidate.runs.get(run.runKey);
    if (accepted === undefined || !Buffer.from(canonicalBytes(accepted)).equals(Buffer.from(acceptedBytes)) || !Buffer.from(candidate.files.get(runRecordPath(run.runKey)) ?? []).equals(Buffer.from(acceptedBytes))) refuse("accepted-run-changed");
    await validateCandidate(run.source.repositoryId, candidate); await immutableBeforeWrite(current, candidate);
    await dependencies.checkpoint?.({ point: "before-cas", attempt, tip: current.tip });
    const result = await adapter.cas(current.tip, candidate);
    await dependencies.checkpoint?.({ point: "after-cas", attempt, tip: current.tip, result: result.status });
    if (result.status === "accepted") return { status: "stored", tip: result.tip, run, added: true, attempts: attempt };
    if (result.status === "unknown") {
      prior = await adapter.read();
      await dependencies.checkpoint?.({ point: "after-unknown-read", attempt, tip: prior.tip });
      const recovered = existing(prior, run.runKey, attempt); if (recovered !== undefined) return recovered;
    }
    if (attempt < 5) {
      const jitter = dependencies.jitter(attempt); if (!Number.isInteger(jitter) || jitter < 0 || jitter > 1000) refuse("jitter-invalid");
      await dependencies.delay(100 * 2 ** (attempt - 1) + jitter);
    }
  }
  return refuse("lease-exhausted");
}

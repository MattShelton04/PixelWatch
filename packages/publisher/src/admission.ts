import { canonicalBytes } from "@pixelwatch/schemas";
import { addRun, planHousekeeping, retentionPolicy, runRecordPath, sizeLimits } from "@pixelwatch/core";
import type { StoreAdapter, StoreCandidate, StoreSnapshot, WriteRunInput } from "@pixelwatch/store";
import { captureAdmission, captureSnapshot, checkedTip, checkImmutable, copyCandidate, existing, materialize, matchesCandidate, preflightCancellation, validateTree } from "./admission-input.ts";
import { measureSite } from "./sizing.ts";
import { guarded, refuse, type AdmissionDependencies, type AdmissionResult } from "./types.ts";

interface ReadView { readonly snapshot: StoreSnapshot; readonly bytes: ReadonlyMap<string, Uint8Array> }
/** Admission alone owns retention authority; callers supply trusted context, never deletion plans. */
export function admitRun(adapter: StoreAdapter, input: WriteRunInput, dependencies: AdmissionDependencies): Promise<AdmissionResult> {
  return guarded(async () => {
    const accepted = captureAdmission(input, dependencies); const run = accepted.input.run; const deps = accepted.dependencies;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the captured operation to this same adapter.
    const readOperation = adapter.read;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the captured operation to this same adapter.
    const casOperation = adapter.cas;
    if (typeof readOperation !== "function" || typeof casOperation !== "function") refuse("publisher-input-invalid");
    const read = (): Promise<StoreSnapshot> => Reflect.apply<StoreAdapter,[],Promise<StoreSnapshot>>(readOperation,adapter,[]);
    const cas = (...args: Parameters<StoreAdapter["cas"]>): ReturnType<StoreAdapter["cas"]> => Reflect.apply<StoreAdapter,Parameters<StoreAdapter["cas"]>,ReturnType<StoreAdapter["cas"]>>(casOperation,adapter,args);
    const repositoryId = deps.context.repository.repositoryId;
    const acceptedBytes = canonicalBytes(run); const policy = retentionPolicy(deps.context.config); const limits = sizeLimits(deps.context.config);
    const readView = async (): Promise<ReadView> => {
      const snapshot = captureSnapshot(await read(), repositoryId); const bytes = await materialize(snapshot);
      if (snapshot.tip !== null) validateTree({store: snapshot.store, runs: snapshot.runs, files: bytes, metadata: deps.metadata}, repositoryId);
      return {snapshot, bytes};
    };
    let prior: ReadView | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      preflightCancellation(deps.signal);
      const current = prior ?? await readView(); prior = undefined; const snapshot = current.snapshot;
      await deps.checkpoint?.({point: "after-read", attempt, tip: snapshot.tip});
      const found = existing(snapshot, run.runKey, attempt); if (found !== undefined) return found;
      const files = new Map(current.bytes);
      for (const [path, bytes] of accepted.input.blobs) if (!files.has(path)) files.set(path, bytes);
      const store = addRun(snapshot.store, run).store;
      files.set(runRecordPath(run.runKey), Uint8Array.from(acceptedBytes)); files.set("store.json", canonicalBytes(store));
      const appended: StoreCandidate = {store, runs: new Map([...snapshot.runs, [run.runKey, run]]), files, metadata: deps.metadata};
      validateTree(appended, repositoryId); checkImmutable(current.bytes, appended);
      const tree = {store: appended.store, runs: appended.runs, files: [...files].map(([path, bytes]) => ({path, bytes: bytes.byteLength}))};
      const projected = measureSite({...deps.context, tree});
      const plan = planHousekeeping({...tree, policy, limits, now: deps.now, prStates: deps.prStates, pins: deps.pins, projected, newRun: run.runKey});
      if (!plan.ok) refuse("admission-budget-refused");
      const removed = new Set(plan.gc.delete.map((file) => file.path)); const kept = new Set(plan.gc.store.runs.map((entry) => entry.runKey));
      const finalFiles = new Map([...files].filter(([path]) => !removed.has(path))); finalFiles.set("store.json", canonicalBytes(plan.gc.store));
      const candidate: StoreCandidate = {store: plan.gc.store, runs: new Map([...appended.runs].filter(([key]) => kept.has(key))), files: finalFiles, metadata: deps.metadata};
      validateTree(candidate, repositoryId); checkImmutable(current.bytes, candidate);
      const expiry = plan.retention.expired.find((entry) => entry.runKey === run.runKey);
      if (plan.newRunExpired) {
        if (expiry === undefined || kept.has(run.runKey) || candidate.files.has(runRecordPath(run.runKey))) refuse("admission-plan-invalid");
      } else if (!kept.has(run.runKey) || !Buffer.from(candidate.files.get(runRecordPath(run.runKey)) ?? []).equals(Buffer.from(acceptedBytes))) refuse("admission-plan-invalid");
      await deps.checkpoint?.({point: "before-cas", attempt, tip: snapshot.tip});
      preflightCancellation(deps.signal);
      // The private recovery proof never shares a mutable map/array with an adapter or callback.
      const reply = await cas(snapshot.tip, copyCandidate(candidate));
      const status = reply.status; const acceptedTip = status === "accepted" ? reply.tip : undefined;
      const attemptedTip = status === "unknown" && "attemptedTip" in reply ? reply.attemptedTip : undefined;
      if (!["accepted", "conflict", "unknown"].includes(status)) refuse("admission-cas-invalid");
      if (status === "accepted" && typeof acceptedTip !== "string") refuse("admission-cas-invalid");
      if (acceptedTip !== undefined) checkedTip(acceptedTip);
      if (attemptedTip !== undefined) {if (typeof attemptedTip !== "string") refuse("admission-cas-invalid"); checkedTip(attemptedTip);}
      await deps.checkpoint?.({point: "after-cas", attempt, tip: snapshot.tip, result: status});
      const complete = (tip: string): AdmissionResult => plan.newRunExpired && expiry !== undefined
        ? {status: "expired", runKey: run.runKey, tip, reason: expiry.reason, attempts: attempt}
        : {status: "stored", run: structuredClone(run), tip, added: true, attempts: attempt};
      if (status === "accepted" && acceptedTip !== undefined) return complete(acceptedTip);
      if (status === "unknown") {
        prior = await readView(); await deps.checkpoint?.({point: "after-unknown-read", attempt, tip: prior.snapshot.tip});
        if (!plan.newRunExpired) {const recovered = existing(prior.snapshot, run.runKey, attempt); if (recovered !== undefined) return recovered;}
        else if (typeof attemptedTip === "string" && prior.snapshot.tip === attemptedTip && matchesCandidate(prior.snapshot, prior.bytes, candidate)) return complete(attemptedTip);
      }
      // A reply already sent is recovered above even after cancellation. No new attempt starts.
      preflightCancellation(deps.signal);
      if (attempt < 5) {const jitter = deps.jitter(attempt); if (!Number.isInteger(jitter) || jitter < 0 || jitter > 1000) refuse("admission-jitter-invalid"); await deps.delay(100 * 2 ** (attempt - 1) + jitter);}
    }
    return refuse("admission-lease-exhausted");
  });
}

import { PngError, PngWorker, baselineFor, blobPath, buildRun, comparatorPolicy, ingestArtifacts, pngErrorCode, selectArtifacts, unitKeyString, type Comparison, type RawPixels } from "@pixelwatch/core";
import { copyBytes } from "./assembly-input.ts";
import { captureSnapshot } from "./admission-input.ts";
import { admitRun } from "./admission.ts";
import { captureDependencies, captureDownloads, captureInput, captureListing, capturePixels, captureSource, isCancelled, preflight, race, type SourceLifetime } from "./ingress-input.ts";
import { StagingPool } from "./staging-pool.ts";
import { onSignalAbort } from "./signal-input.ts";
import { PublisherError, refuse, sanitizePublisherError, type SourceJobDependencies, type SourceJobInput, type SourceJobResult } from "./types.ts";
/** Authenticated source to durable data only; projection remains a separately serialized stage. */
export async function ingestJob(input: SourceJobInput, supplied: SourceJobDependencies): Promise<SourceJobResult> {
  let deps: SourceJobDependencies | undefined, worker: NonNullable<SourceJobDependencies["worker"]> | undefined;
  let signal: AbortSignal | undefined, dispose: (() => void) | undefined, closed = false, deadlineStarted = false, timingFailed = false, proven: SourceJobResult | undefined;
  // Cleanup can still be raced if dependency acquisition fails before a real deadline exists.
  const fallbackCleanup = new AbortController();
  let refusal: PublisherError | undefined;
  const lifetime: SourceLifetime = {};
  const unlink: (() => void)[] = [];
  const startDeadline = () => {
    if (deadlineStarted || lifetime.timing === undefined)
      return;
    deadlineStarted = true;
    const combined = new AbortController();
    signal = combined.signal;
    try {
      const deadline = lifetime.timing.deadline(600000);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured disposer is rebound to this same deadline with Reflect.apply.
      const deadlineDispose = deadline.dispose;
      if (typeof deadlineDispose !== "function")
        refuse("source-job-timing-invalid");
      dispose = () => {
        Reflect.apply(deadlineDispose, deadline, []);
      };
      const deadlineSignal = deadline.signal;
      for (const source of lifetime.signal === undefined ? [deadlineSignal] : [deadlineSignal, lifetime.signal]) {
        if (isCancelled(source))
          combined.abort();
        else {
          unlink.push(onSignalAbort(source, () => {
            combined.abort();
          }));
          if (isCancelled(source))
            combined.abort();
        }
      }
    }
    catch {
      timingFailed = true;
      combined.abort();
      refuse("source-job-timing-invalid");
    }
  };
  const close = async () => {
    if (closed || lifetime.close === undefined)
      return;
    closed = true;
    const unavailable = signal === undefined;
    if (unavailable)
      fallbackCleanup.abort();
    const cleanupSignal = signal ?? fallbackCleanup.signal;
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(lifetime.close());
      await race(pending, cleanupSignal);
    }
    catch {
      // Preserve the privately reconstructed preflight refusal; fallback abort adds no new cause.
      if (unavailable && refusal !== undefined)
        throw refusal;
      if (timingFailed)
        refuse("source-job-timing-invalid");
      if (isCancelled(cleanupSignal))
        refuse("source-job-cancelled");
      refuse("source-job-codec-failed");
    }
  };
  try {
    deps = captureDependencies(supplied, lifetime);
    worker = deps.worker ?? new PngWorker();
    if (lifetime.close === undefined) {
      const operation = worker.close;
      lifetime.close = () => Reflect.apply(operation, worker, []);
    }
    const context = captureInput(input);
    startDeadline();
    if (signal === undefined)
      refuse("source-job-timing-invalid");
    const activeSignal = signal;
    preflight(activeSignal);
    const check = async (point: Parameters<NonNullable<SourceJobDependencies["checkpoint"]>>[0]) => {
      preflight(activeSignal);
      if (deps?.checkpoint !== undefined)
        await race(Promise.resolve(deps.checkpoint(point)), activeSignal);
      preflight(activeSignal);
    };
    // A transport seam owns its request DTO; it cannot mutate the private policy used below.
    const verified = await race(deps.forge.verifySource({
      event: copyBytes(context.event, 1024 * 1024), config: structuredClone(context.config), configSha: context.configCommit, releaseSha: context.assets.releaseCommit, signal: activeSignal
    }), activeSignal, value => captureSource(value, context));
    await check("verified");
    const snapshot = await race(deps.store.read(), activeSignal, value => captureSnapshot(value, context.repository.repositoryId));
    const pool = new StagingPool(snapshot, activeSignal);
    const listed = await race(deps.forge.listArtifacts(verified.envelope.runId, activeSignal), activeSignal, captureListing);
    await check("listed");
    const selected = selectArtifacts({
      config: context.config, attempt: verified.envelope.attempt, baseline: baselineFor(verified.envelope), artifacts: listed.metadata
    });
    const descriptors = selected.selected.map(part => {
      const descriptor = listed.descriptors[listed.metadata.indexOf(part.artifact)];
      if (descriptor === undefined)
        refuse("source-job-download-invalid");
      return descriptor;
    });
    const downloads = await race(deps.forge.downloadArtifacts(descriptors, activeSignal), activeSignal, value => captureDownloads(value, selected.selected.map(part => part.artifact)));
    await check("downloaded");
    const ownedWorker = worker;
    const codecCall = async <T, Owned>(operation: () => Promise<T>, capture: (value: T) => Owned): Promise<Owned> => {
      preflight(activeSignal);
      try {
        return await race(operation(), activeSignal, capture);
      }
      catch (error) {
        if (isCancelled(activeSignal))
          refuse("source-job-cancelled");
        const code = pngErrorCode(error);
        throw new PngError(code ?? "worker-crash", "trusted image operation failed");
      }
    };
    const decode = (bytes: Uint8Array): Promise<RawPixels> => codecCall(() => ownedWorker.decode(copyBytes(bytes, 32 * 1024 * 1024), { signal: activeSignal }), capturePixels);
    const encode = (image: RawPixels): Promise<Uint8Array> => codecCall(() => ownedWorker.encode(capturePixels(image), { signal: activeSignal }), value => copyBytes(value, 32 * 1024 * 1024));
    const ingestion = await race(ingestArtifacts({
      config: context.config, attempt: verified.envelope.attempt, baseline: baselineFor(verified.envelope), artifacts: downloads.artifacts, listedArtifacts: listed.metadata, pool, codec: { decode, encode }, signal: activeSignal, deadline: activeSignal
    }), activeSignal);
    const comparisons = new Map<string, Comparison>();
    const policy = comparatorPolicy(context.config.comparator?.version ?? 1);
    for (const unit of ingestion.units) {
      if (unit.base.state !== "captured" || unit.head.state !== "captured")
        continue;
      preflight(activeSignal);
      const base = await decode(await pool.read(blobPath(unit.base.pixelHash)));
      const head = await decode(await pool.read(blobPath(unit.head.pixelHash)));
      const comparison = await codecCall(() => ownedWorker.compare(base, head, policy, { signal: activeSignal }), value => structuredClone(value));
      comparisons.set(unitKeyString(unit), comparison);
    }
    const run = buildRun(verified.envelope, ingestion, comparisons, {
      release: context.assets.release, config: 1, comparator: 1, bundle: 1, data: 1
    });
    await check("analysed");
    const blobs = await pool.files(run);
    await close();
    await check("before-admission");
    const admission = await admitRun(deps.store, { run, blobs }, {
      ...deps.admission, context, signal: activeSignal
    });
    proven = {
      admission, projection: admission.status === "expired" ? "not-retained" : "pending", diagnostics: {
        source: verified.diagnostics, missing: downloads.missing.map(({ artifactId, reason }) => ({ artifactId, reason })), ignored: ingestion.ignored.map(({ artifactId, reason }) => ({ artifactId, reason })), ignoredOverflow: ingestion.ignoredOverflow, excludedCount: ingestion.excluded.count, cleanup: []
      }
    };
    return proven;
  }
  catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- startDeadline changes this captured flag before throwing into this outer catch.
    if (timingFailed)
      refusal = new PublisherError("source-job-timing-invalid");
    else if (signal !== undefined && isCancelled(signal))
      refusal = new PublisherError("source-job-cancelled");
    else
      refusal = sanitizePublisherError(error, "source-job-operation-failed");
    throw refusal;
  }
  finally {
    try {
      try {
        if (lifetime.close !== undefined)
          startDeadline();
      }
      finally {
        await close();
      }
    }
    finally {
      let cleanupFailed = false;
      for (const remove of unlink) {
        try {
          remove();
        }
        catch {
          cleanupFailed = true;
        }
      }
      if (dispose !== undefined) {
        try {
          dispose();
        }
        catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        if (proven === undefined)
          refuse("source-job-timing-invalid");
        (proven.diagnostics as {
          cleanup: readonly "timing-disposal-failed"[];
        }).cleanup = ["timing-disposal-failed"];
      }
    }
  }
}

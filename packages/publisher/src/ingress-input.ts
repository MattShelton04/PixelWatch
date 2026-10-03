import { INGEST_LIMITS, MAX_PIXELS, MAX_DIMENSION, PngError, pngErrorCode, expectedParts, type RawPixels } from "@pixelwatch/core";
import { canonicalBytes, formatRunKey, isGitHubId, validateDocument, type SourceEnvelope } from "@pixelwatch/schemas";
import { type ArtifactDescriptor, type DownloadResult, type SourceDiagnostic, type VerifiedSource } from "@pixelwatch/forge-github";
import { captureContext, copyBytes, JSON_BYTES } from "./assembly-input.ts";
import { isSignalAborted, onSignalAbort } from "./signal-input.ts";
import { PublisherError, refuse, sanitizePublisherError, type PublisherContext, type SourceJobDependencies, type SourceJobInput } from "./types.ts";
// Native operations authenticate signals and collections; caller accessors cannot substitute state.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Explicit native Reflect.apply receivers below.
const mapEach = Map.prototype.forEach, setEach = Set.prototype.forEach;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply uses the native promise as its receiver.
const promiseThen = Promise.prototype.then;
const sourceCodes = new Set<SourceDiagnostic>(["source-workflow-provenance-unavailable", "pr-association-none", "pr-association-ambiguous", "pr-association-disagreement", "pr-base-unavailable", "pr-head-stale"]);
const missingCodes = new Set(["expired", "unavailable", "retry-exhausted"]);
export function isCancelled(signal: AbortSignal): boolean {
  try {
    return isSignalAborted(signal);
  }
  catch {
    return refuse("source-job-input-invalid");
  }
}
export function preflight(signal: AbortSignal): void {
  if (isCancelled(signal))
    refuse("source-job-cancelled");
}
/** Race ignored native signals; both late success and late rejection retain handlers. */
export function race<T>(pending: Promise<T>, signal: AbortSignal): Promise<T>;
export function race<T, Owned>(pending: Promise<T>, signal: AbortSignal, capture: (value: T) => Owned): Promise<Owned>;
export function race<T, Owned = T>(pending: Promise<T>, signal: AbortSignal, capture: (value: T) => Owned = value => value as unknown as Owned): Promise<Owned> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let remove = () => {
    };
    const cleanup = () => {
      remove();
    };
    const fail = (error: unknown) => {
      if (settled)
        return;
      // Constructor-private identities never inspect a rejected value's public fields/prototype.
      const pngCode = pngErrorCode(error);
      let safe: Error = pngCode === undefined ? sanitizePublisherError(error, "source-job-operation-failed") : new PngError(pngCode, "trusted image operation failed");
      settled = true;
      try {
        cleanup();
      }
      catch {
        safe = new PublisherError("source-job-operation-failed");
      }
      reject(safe);
    };
    const finish = (value: T) => {
      if (settled)
        return;
      let owned: Owned;
      try {
        preflight(signal);
        // Capture within this fulfillment reaction, before a queued producer mutation can run.
        owned = capture(value);
      }
      catch (error) {
        fail(error);
        return;
      }
      settled = true;
      try {
        cleanup();
      }
      catch {
        reject(new PublisherError("source-job-operation-failed"));
        return;
      }
      resolve(owned);
    };
    const cancelled = () => {
      fail(new PublisherError("source-job-cancelled"));
    };
    try {
      // Attach both handlers before registration can fail; late rejection always remains handled.
      Reflect.apply(promiseThen, pending, [finish, fail]);
      remove = onSignalAbort(signal, cancelled);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A native listener hook can synchronously dispatch during registration.
      if (settled)
        cleanup();
      if (isCancelled(signal))
        cancelled();
    }
    catch (error) {
      fail(error);
    }
  });
}
/** Capture a callable exactly once without invoking a supplied bind method. */
function method<T extends (...args: never[]) => unknown>(owner: object, operation: T): T {
  if (typeof operation !== "function")
    refuse("source-job-input-invalid");
  return ((...args: Parameters<T>) => Reflect.apply(operation, owner, args) as ReturnType<T>) as T;
}
export interface SourceLifetime {
  timing?: SourceJobDependencies["timing"];
  signal?: AbortSignal;
  close?: () => Promise<void>;
}
export function captureDependencies(deps: SourceJobDependencies, lifetime: SourceLifetime): SourceJobDependencies {
  // Own cleanup before later dependency getters can refuse. The close method is read only once.
  const worker = deps.worker;
  let closeOperation: (() => Promise<void>) | undefined;
  if (worker !== undefined) {
    const close = worker.close;
    closeOperation = method(worker, close);
    lifetime.close = closeOperation;
  }
  const timing = deps.timing, deadline = timing.deadline;
  const ownedTiming = { deadline: method(timing, deadline) };
  lifetime.timing = ownedTiming;
  const signal = deps.signal;
  if (signal !== undefined) {
    isCancelled(signal);
    lifetime.signal = signal;
  }
  let ownedWorker: SourceJobDependencies["worker"];
  if (worker !== undefined && closeOperation !== undefined) {
    const decode = worker.decode, encode = worker.encode, compare = worker.compare;
    ownedWorker = {
      decode: method(worker, decode), encode: method(worker, encode), compare: method(worker, compare), close: closeOperation
    };
  }
  const forge = deps.forge, store = deps.store, admission = deps.admission, checkpoint = deps.checkpoint;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- These operations are captured once and rebound to the original owner with Reflect.apply.
  const verify = forge.verifySource, list = forge.listArtifacts, download = forge.downloadArtifacts, read = store.read, cas = store.cas;
  const metadataSource = admission.metadata;
  const timestamp = metadataSource.timestamp, now = admission.now;
  const suppliedStates = admission.prStates, suppliedPins = admission.pins;
  const states = new Map<string, "open" | "closed" | "unknown">(), pins = new Set<string>();
  Reflect.apply(mapEach, suppliedStates, [(value: "open" | "closed" | "unknown", key: string) => {
      if (states.size >= 1024)
        refuse("source-job-input-invalid");
      states.set(key, value);
    }]);
  if (suppliedPins !== undefined)
    Reflect.apply(setEach, suppliedPins, [(key: string) => {
        if (pins.size >= 100000)
          refuse("source-job-input-invalid");
        pins.add(key);
      }]);
  const delay = admission.delay, jitter = admission.jitter, admissionCheckpoint = admission.checkpoint;
  if (checkpoint !== undefined && typeof checkpoint !== "function")
    refuse("source-job-input-invalid");
  return {
    forge: {
      verifySource: method(forge, verify), listArtifacts: method(forge, list), downloadArtifacts: method(forge, download)
    }, store: { read: method(store, read), cas: method(store, cas) },
    admission: {
      metadata: { timestamp }, now, prStates: states, pins, delay: method(admission, delay), jitter: method(admission, jitter), ...(admissionCheckpoint === undefined ? {} : { checkpoint: method(admission, admissionCheckpoint) })
    },
    timing: ownedTiming, ...(ownedWorker === undefined ? {} : { worker: ownedWorker }), ...(signal === undefined ? {} : { signal }), ...(checkpoint === undefined ? {} : { checkpoint: method(deps, checkpoint) })
  };
}
export function captureInput(input: SourceJobInput): SourceJobInput {
  const context = captureContext(input);
  const supplied = input.event;
  const event = copyBytes(supplied, JSON_BYTES);
  return { ...context, event };
}
export function captureSource(value: VerifiedSource, context: PublisherContext): VerifiedSource {
  const envelope: SourceEnvelope = structuredClone(value.envelope);
  const sourceDiagnostics = value.diagnostics;
  const count = sourceDiagnostics.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > sourceCodes.size)
    refuse("source-job-source-invalid");
  const diagnostics: SourceDiagnostic[] = [];
  for (let index = 0; index < count; index++) {
    const code = sourceDiagnostics[index];
    if (code === undefined || !sourceCodes.has(code) || diagnostics.includes(code))
      refuse("source-job-source-invalid");
    diagnostics.push(code);
  }
  if (envelope.repositoryId !== context.repository.repositoryId || envelope.configSha !== context.configCommit || envelope.releaseSha !== context.assets.releaseCommit
    || !context.config.source.workflowIds.includes(envelope.workflowId) || !context.config.source.events.includes(envelope.event))
    refuse("source-job-source-invalid");
  // Internal schema carrier only: never persisted, returned or logged; no envelope is invented.
  const carrier = {
    schemaVersion: 1, runKey: formatRunKey(envelope.runId, envelope.attempt), source: envelope, claims: {}, versions: {
      release: context.assets.release, config: 1, comparator: 1, bundle: 1, data: 1
    }, parts: [],
    coverage: {
      status: "unknown", declaredUnits: 0, accountedUnits: 0, missingParts: expectedParts(context.config, envelope.commits.base === undefined ? "none" : "expected").map(part => ({ ...part, reason: "not-received" }))
    },
    counts: {
      missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: 0, subtle: 0, changed: 0
    }, results: []
  };
  if (canonicalBytes(carrier).byteLength > JSON_BYTES || !validateDocument("run", carrier).ok)
    refuse("source-job-source-invalid");
  return { envelope, diagnostics };
}
export function captureListing(source: readonly ArtifactDescriptor[]): {
  descriptors: ArtifactDescriptor[];
  metadata: {
    artifactId: string;
    artifactName: string;
  }[];
} {
  const count = source.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > INGEST_LIMITS.maxArtifacts)
    refuse("source-job-download-invalid");
  const descriptors: ArtifactDescriptor[] = [], metadata: {
    artifactId: string;
    artifactName: string;
  }[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index++) {
    const value = source[index];
    if (value === undefined)
      refuse("source-job-download-invalid");
    const artifactId = value.artifactId, artifactName = value.artifactName, size = value.sizeBytes, expired = value.expired;
    if (!isGitHubId(artifactId) || ids.has(artifactId) || typeof artifactName !== "string" || Buffer.byteLength(artifactName) > 1024 || !Number.isSafeInteger(size) || size < 0 || typeof expired !== "boolean")
      refuse("source-job-download-invalid");
    ids.add(artifactId);
    descriptors.push(value);
    metadata.push({ artifactId, artifactName });
  }
  return { descriptors, metadata };
}
export function captureDownloads(source: DownloadResult, selected: readonly {
  artifactId: string;
  artifactName: string;
}[]): DownloadResult {
  const artifactsSource = source.artifacts, missingSource = source.missing;
  const expected = new Map(selected.map(value => [value.artifactId, value.artifactName]));
  const seen = new Set<string>();
  const archives: DownloadResult["artifacts"][number][] = [], missing: DownloadResult["missing"][number][] = [];
  const archiveCount = artifactsSource.length, missingCount = missingSource.length;
  if (!Number.isSafeInteger(archiveCount) || !Number.isSafeInteger(missingCount) || archiveCount < 0 || missingCount < 0 || archiveCount + missingCount !== selected.length)
    refuse("source-job-download-invalid");
  const owned: {
    artifactId: string;
    artifactName: string;
    source: DownloadResult["artifacts"][number] | DownloadResult["missing"][number];
    reason?: DownloadResult["missing"][number]["reason"];
  }[] = [];
  for (let index = 0; index < archiveCount + missingCount; index++) {
    const value = index < archiveCount ? artifactsSource[index] : missingSource[index - archiveCount];
    if (value === undefined)
      refuse("source-job-download-invalid");
    const artifactId = value.artifactId, artifactName = value.artifactName;
    if (expected.get(artifactId) !== artifactName || seen.has(artifactId))
      refuse("source-job-download-invalid");
    seen.add(artifactId);
    if (index < archiveCount)
      owned.push({
        artifactId, artifactName, source: value
      });
    else {
      const reason = (value as DownloadResult["missing"][number]).reason;
      if (!missingCodes.has(reason))
        refuse("source-job-download-invalid");
      owned.push({
        artifactId, artifactName, source: value, reason
      });
    }
  }
  let compressed = 0;
  for (const value of owned) {
    const { artifactId, artifactName, reason } = value;
    if (reason !== undefined) {
      missing.push({
        artifactId, artifactName, reason
      });
      continue;
    }
    const bytes = (value.source as DownloadResult["artifacts"][number]).zip;
    const zip = copyBytes(bytes, Math.min(INGEST_LIMITS.maxArchiveBytes, INGEST_LIMITS.maxCompressedBytes - compressed));
    compressed += zip.byteLength;
    archives.push({
      artifactId, artifactName, zip
    });
  }
  return { artifacts: archives, missing };
}
export function capturePixels(source: RawPixels): RawPixels {
  const width = source.width, height = source.height, channels: unknown = source.channels, supplied = source.data;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS || (channels !== 3 && channels !== 4))
    refuse("source-job-codec-failed");
  return {
    width, height, channels, data: copyBytes(supplied, MAX_PIXELS * 4, width * height * channels)
  };
}

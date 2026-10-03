import { createHash } from "node:crypto";
import { canonicalBytes, isGitHubId, parseDocument, parseRunKey, validateDocument, type Run } from "@pixelwatch/schemas";
import { classifyStorePath, parsePngStructure, readStoreTree, runRecordPath } from "@pixelwatch/core";
import { STORE_LIMITS, type StoreCandidate, type StoreSnapshot, type WriteRunInput } from "@pixelwatch/store";
import { captureContext, copyBytes } from "./assembly-input.ts";
import { isSignalAborted } from "./signal-input.ts";
import { refuse, type AdmissionDependencies } from "./types.ts";

export interface AdmissionCapture { readonly input: WriteRunInput; readonly dependencies: AdmissionDependencies }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Trusted native controller state, with explicit refusal of Proxy and malformed DTOs. */
function cancelled(signal: AbortSignal): boolean {
  try {return isSignalAborted(signal);} catch {return refuse("admission-signal-invalid");}
}
export function preflightCancellation(signal: AbortSignal | undefined): void {
  if (signal !== undefined && cancelled(signal)) refuse("admission-cancelled");
}
export function checkedTip(value: string | null): void { if (value !== null && (typeof value !== "string" || !OID.test(value))) refuse("admission-tip-invalid"); }
function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace("Z", ".000Z")) refuse("admission-time-invalid");
}
/** Capture trusted policy and accepted bytes before any injected operation or await. */
export function captureAdmission(input: WriteRunInput, dependencies: AdmissionDependencies): AdmissionCapture {
  const run = structuredClone(input.run);
  if (!validateDocument("run", run).ok || canonicalBytes(run).byteLength > STORE_LIMITS.maxJsonBytes) refuse("admission-run-invalid");
  const blobs = new Map<string, Uint8Array>(); let stagedBytes = 0;
  for (const [path, bytes] of input.blobs) {
    if (blobs.size >= STORE_LIMITS.maxFiles || classifyStorePath(path)?.kind !== "blob") refuse("admission-blob-invalid");
    const captured = copyBytes(bytes, Math.min(STORE_LIMITS.maxPngBytes, STORE_LIMITS.maxTreeBytes - stagedBytes));
    stagedBytes += captured.byteLength; blobs.set(path, captured);
  }
  const context = captureContext(dependencies.context);
  const metadata = {timestamp: dependencies.metadata.timestamp}; const now = dependencies.now;
  const prStates = new Map(dependencies.prStates); const pins = new Set(dependencies.pins ?? []);
  const delay = dependencies.delay; const jitter = dependencies.jitter; const checkpoint = dependencies.checkpoint;
  const signal = dependencies.signal; if (signal !== undefined) cancelled(signal);
  if (typeof delay !== "function" || typeof jitter !== "function" || (checkpoint !== undefined && typeof checkpoint !== "function")) refuse("publisher-input-invalid");
  const copied: AdmissionDependencies = {context, metadata, now, prStates, pins, delay, jitter,
    ...(checkpoint === undefined ? {} : {checkpoint}), ...(signal === undefined ? {} : {signal})};
  if (context.repository.repositoryId !== run.source.repositoryId) refuse("admission-repository-invalid");
  timestamp(now); timestamp(metadata.timestamp);
  for (const [pr, state] of prStates) if (!isGitHubId(pr) || !["open", "closed", "unknown"].includes(state)) refuse("admission-pr-state-invalid");
  for (const pin of pins) if (parseRunKey(pin) === undefined) refuse("admission-pin-invalid");
  let total = 0;
  for (const [path, bytes] of blobs) {
    if (classifyStorePath(path)?.kind !== "blob" || bytes.byteLength > STORE_LIMITS.maxPngBytes || (total += bytes.byteLength) > STORE_LIMITS.maxTreeBytes) refuse("admission-blob-invalid");
    try {parsePngStructure(bytes);} catch {refuse("admission-blob-invalid");}
  }
  return {input: {run, blobs}, dependencies: copied};
}
/** A snapshot DTO and its byte-reader are privately owned before any callback or read. */
export function captureSnapshot(snapshot: StoreSnapshot, repositoryId: string): StoreSnapshot {
  const tip = snapshot.tip; checkedTip(tip); const store = structuredClone(snapshot.store);
  const sourceFiles = snapshot.files; const count = sourceFiles.length;
  if (!Number.isSafeInteger(count) || count < 0) refuse("admission-listing-invalid");
  if (count > STORE_LIMITS.maxFiles) refuse("admission-files-limit");
  const files: {path: string; bytes: number}[] = [];
  for (let index = 0; index < count; index++) {
    const file = sourceFiles[index] as StoreSnapshot["files"][number] | null; if (typeof file !== "object" || file === null) refuse("admission-listing-invalid");
    files.push({path: file.path, bytes: file.bytes});
  }
  const runs = new Map([...snapshot.runs].map(([key, value]) => [key, structuredClone(value)]));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds this captured reader to the same source snapshot.
  const originalRead = snapshot.readFile;
  if (typeof originalRead !== "function") refuse("store-reader-invalid");
  if (store.repositoryId !== repositoryId) refuse("admission-foreign-store");
  if (tip === null && (files.length !== 0 || runs.size !== 0 || store.runs.length !== 0 || store.txn !== 0)) refuse("admission-absent-store-invalid");
  let total = 0; const listing = new Map<string, number>();
  for (const file of files) {
    const kind = classifyStorePath(file.path); const json = kind?.kind === "index" || kind?.kind === "run";
    if (kind === undefined || kind.kind === "grace" || listing.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > (json ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes) || (total += file.bytes) > STORE_LIMITS.maxTreeBytes) refuse("admission-listing-invalid");
    listing.set(file.path, file.bytes);
  }
  if (tip !== null && !listing.has("store.json")) refuse("admission-unmarked-store");
  if (runs.size !== store.runs.length || store.runs.some((entry) => !runs.has(entry.runKey))) refuse("admission-store-graph-invalid");
  try {readStoreTree({store, runs, files});} catch {refuse("admission-store-graph-invalid");}
  return {tip, store, runs, files, readFile: async (path) => {
    const expected = listing.get(path); if (expected === undefined) refuse("admission-file-missing");
    return copyBytes(await Reflect.apply<typeof snapshot,[string],Promise<Uint8Array>>(originalRead,snapshot,[path]), expected, expected);
  }};
}
function equal(first: Uint8Array, second: Uint8Array): boolean { return Buffer.from(first).equals(Buffer.from(second)); }
/** Validate every byte before selection, including files the GC plan will remove. */
export function validateTree(tree: StoreCandidate, repositoryId: string): void {
  captureSnapshot({tip: "0".repeat(40), store: tree.store, runs: tree.runs, files: [...tree.files].map(([path, bytes]) => ({path, bytes: bytes.byteLength})), readFile: () => Promise.reject(new Error("unreachable"))}, repositoryId);
  const index = tree.files.get("store.json"); if (index === undefined || !equal(index, canonicalBytes(tree.store)) || !parseDocument("store", index).ok) refuse("admission-index-mismatch");
  for (const [key, run] of tree.runs) {
    const bytes = tree.files.get(runRecordPath(key));
    if (bytes === undefined || !equal(bytes, canonicalBytes(run)) || !parseDocument("run", bytes).ok) refuse("admission-record-mismatch");
  }
  for (const [path, bytes] of tree.files) {
    const kind = classifyStorePath(path)?.kind;
    if (kind === "blob" || kind === "derived") {
      try {parsePngStructure(bytes);} catch {refuse("admission-png-invalid");}
      if (kind === "derived" && !path.endsWith(`/${createHash("sha256").update(bytes).digest("hex")}.png`)) refuse("admission-derived-mismatch");
    }
  }
}
export async function materialize(snapshot: StoreSnapshot): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>(); for (const file of snapshot.files) files.set(file.path, await snapshot.readFile(file.path)); return files;
}
export function copyCandidate(tree: StoreCandidate): StoreCandidate {
  return {store: structuredClone(tree.store), runs: new Map([...tree.runs].map(([key, run]) => [key, structuredClone(run)])), files: new Map([...tree.files].map(([path, bytes]) => [path, copyBytes(bytes, path.endsWith(".json") ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes)])), metadata: {...tree.metadata}};
}
export function checkImmutable(before: ReadonlyMap<string, Uint8Array>, after: StoreCandidate): void {
  for (const [path, bytes] of before) {const next = after.files.get(path); if (path !== "store.json" && next !== undefined && !equal(bytes, next)) refuse("admission-immutable-file");}
}
export function matchesCandidate(snapshot: StoreSnapshot, bytes: ReadonlyMap<string, Uint8Array>, candidate: StoreCandidate): boolean {
  if (snapshot.files.length !== candidate.files.size) return false;
  for (const file of snapshot.files) {const expected = candidate.files.get(file.path); const actual = bytes.get(file.path); if (expected === undefined || actual === undefined || file.bytes !== expected.byteLength || !equal(actual, expected)) return false;}
  return true;
}
export function existing(snapshot: StoreSnapshot, runKey: string, attempts: number): {readonly status: "stored"; readonly tip: string; readonly run: Run; readonly added: false; readonly attempts: number} | undefined {
  const run = snapshot.runs.get(runKey); if (run === undefined) return undefined; if (snapshot.tip === null) refuse("admission-store-graph-invalid");
  return {status: "stored", tip: snapshot.tip, run: structuredClone(run), added: false, attempts};
}

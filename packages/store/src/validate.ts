import { createHash } from "node:crypto";
import { canonicalBytes, canonicalJson, isGitHubId, parseDocument, type Run, type Store } from "@pixelwatch/schemas";
import { classifyStorePath, newStore, parsePngStructure, readStoreTree, runRecordPath, type StoreFile } from "@pixelwatch/core";
import { STORE_LIMITS, StoreError, guarded, refuse, type CommitMetadata, type StoreCandidate, type StoreIdentity, type StoreSnapshot } from "./types.ts";

/** Synchronous ownership transfer: callers never retain mutable bytes or records used after an await. */
export function cloneCandidate(candidate: StoreCandidate): StoreCandidate {
  return { store: structuredClone(candidate.store), runs: new Map([...candidate.runs].map(([key, value]) => [key, structuredClone(value)])),
    files: new Map([...candidate.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)])), metadata: { ...candidate.metadata } };
}

export function identity(options: StoreIdentity): string {
  const branch = options.branch ?? "pixelwatch-data";
  const valid = (value: string) => /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,127}$/.test(value) && value.split("/").every((s) => s !== "" && !s.startsWith(".") && !s.endsWith(".") && !s.endsWith(".lock")) && !value.includes("..") && !value.startsWith("refs/");
  if (!isGitHubId(options.repositoryId) || !valid(branch) || !valid(options.defaultBranch) || branch === options.defaultBranch) refuse("store-target-refused");
  return branch;
}
export function metadata(value: CommitMetadata): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) || new Date(value.timestamp).toISOString() !== value.timestamp.replace("Z", ".000Z")) refuse("metadata-invalid");
}
export function tip(value: string | null): void { if (value !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) refuse("lease-invalid"); }
export function checkedPath(path: string): "index" | "run" | "blob" | "derived" {
  const kind = classifyStorePath(path);
  if (kind === undefined || kind.kind === "grace") refuse("store-path-refused");
  return kind.kind;
}
export function listing(files: readonly StoreFile[]): void {
  if (files.length > STORE_LIMITS.maxFiles) refuse("store-files-limit");
  let total = 0; const seen = new Set<string>();
  for (const file of files) {
    const kind = checkedPath(file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) refuse("store-listing-invalid");
    seen.add(file.path); total += file.bytes;
    if (file.bytes > (kind === "index" || kind === "run" ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes)) refuse("store-file-limit");
    if (total > STORE_LIMITS.maxTreeBytes) refuse("store-tree-limit");
  }
}
function document<K extends "store" | "run">(kind: K, bytes: Uint8Array): K extends "store" ? Store : Run {
  const parsed = parseDocument(kind, bytes);
  if (!parsed.ok) refuse(parsed.issue.code === "unsupported-version" ? "store-version-refused" : "store-document-invalid");
  return parsed.value as K extends "store" ? Store : Run;
}
/** Eager validation covers every indexed record and reference, including expired history. */
export async function snapshot(repositoryId: string, currentTip: string | null, files: readonly StoreFile[], read: (path: string) => Promise<Uint8Array>): Promise<StoreSnapshot> {
  tip(currentTip); listing(files);
  if (currentTip === null) {
    if (files.length !== 0) refuse("unmarked-store");
    return { tip: null, store: newStore(repositoryId), runs: new Map(), files: [], readFile: () => Promise.reject(new StoreError("store-file-missing")) };
  }
  const allowed = new Map(files.map((f) => [f.path, f.bytes]));
  const boundedRead = (path: string) => guarded(async () => {
    const size = allowed.get(path); if (size === undefined) refuse("store-file-missing");
    const bytes = await read(path); if (bytes.byteLength !== size) refuse("store-file-changed"); return bytes;
  });
  if (!allowed.has("store.json")) refuse("unmarked-store");
  const store = document("store", await boundedRead("store.json"));
  if (store.repositoryId !== repositoryId) refuse("foreign-store");
  const runs = new Map<string, Run>();
  for (const entry of store.runs) runs.set(entry.runKey, document("run", await boundedRead(runRecordPath(entry.runKey))));
  // Validate pooled bytes without decoding/re-hashing existing pixels (ADR 0010).
  for (const file of files) {
    const kind = checkedPath(file.path); if (kind !== "blob" && kind !== "derived") continue;
    const bytes = await boundedRead(file.path);
    try { parsePngStructure(bytes); } catch { refuse("stored-png-invalid"); }
    if (kind === "derived" && !file.path.endsWith(`/${createHash("sha256").update(bytes).digest("hex")}.png`)) refuse("derived-hash-mismatch");
  }
  try {
    const graph = readStoreTree({ store, runs, files });
    for (const key of graph.entries.keys()) graph.refs(key);
  } catch { refuse("store-graph-invalid"); }
  return { tip: currentTip, store, runs, files: files.map((f) => ({ ...f })), readFile: boundedRead };
}
export async function validateCandidate(repositoryId: string, candidate: StoreCandidate): Promise<StoreSnapshot> {
  metadata(candidate.metadata);
  const files = [...candidate.files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength }));
  const result = await snapshot(repositoryId, "0".repeat(40), files, (path) => {
    const bytes = candidate.files.get(path); if (bytes === undefined) refuse("store-file-missing"); return Promise.resolve(bytes);
  });
  if (canonicalJson(result.store) !== canonicalJson(candidate.store) || result.runs.size !== candidate.runs.size) refuse("candidate-graph-mismatch");
  for (const [key, value] of result.runs) { const supplied = candidate.runs.get(key); if (supplied === undefined || canonicalJson(value) !== canonicalJson(supplied)) refuse("candidate-graph-mismatch"); }
  if (!Buffer.from(candidate.files.get("store.json") ?? []).equals(Buffer.from(canonicalBytes(result.store)))) refuse("candidate-noncanonical");
  for (const [key, value] of result.runs) if (!Buffer.from(candidate.files.get(runRecordPath(key)) ?? []).equals(Buffer.from(canonicalBytes(value)))) refuse("candidate-noncanonical");
  return result;
}
export async function immutableBeforeWrite(before: StoreSnapshot, candidate: StoreCandidate): Promise<void> {
  if (candidate.store.txn < before.store.txn) refuse("transaction-rollback");
  for (const file of before.files) {
    if (file.path === "store.json") continue; const bytes = candidate.files.get(file.path);
    if (bytes !== undefined && !Buffer.from(bytes).equals(Buffer.from(await before.readFile(file.path)))) refuse("immutable-file");
  }
}
export function candidateDigest(candidate: StoreCandidate): string {
  const hash = createHash("sha256"); hash.update(canonicalBytes(candidate.metadata));
  for (const [path, bytes] of [...candidate.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(canonicalBytes({ path, bytes: bytes.byteLength, hash: createHash("sha256").update(bytes).digest("hex") }));
  return hash.digest("hex");
}

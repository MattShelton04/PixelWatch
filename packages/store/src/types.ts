import type { Run, Store } from "@pixelwatch/schemas";
import type { StoreFile } from "@pixelwatch/core";

export interface CommitMetadata { readonly timestamp: string }
export interface StoreCandidate {
  readonly store: Store;
  readonly runs: ReadonlyMap<string, Run>;
  /** Complete tree, including canonical store.json and run records. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly metadata: CommitMetadata;
}
export interface StoreSnapshot {
  /** Null is a verified absent ref/directory, never a failed fetch. */
  readonly tip: string | null;
  readonly store: Store;
  readonly runs: ReadonlyMap<string, Run>;
  readonly files: readonly StoreFile[];
  readFile(path: string): Promise<Uint8Array>;
}
export type CasResult = { readonly status: "accepted"; readonly tip: string } | { readonly status: "conflict" } | {
  readonly status: "unknown";
  /** Adapter-computed candidate commit, never proof of acceptance without an exact refetch. */
  readonly attemptedTip?: string;
};
export interface StoreAdapter {
  read(): Promise<StoreSnapshot>;
  cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult>;
}
export interface StoreIdentity { readonly repositoryId: string; readonly defaultBranch: string; readonly branch?: string }
export const STORE_LIMITS = Object.freeze({ maxFiles: 100_000, maxTreeBytes: 1024 * 1024 * 1024, maxJsonBytes: 1024 * 1024, maxPngBytes: 32 * 1024 * 1024, processTimeoutMs: 60_000 });
const DIAGNOSTIC_CODES = new Set([
  "accepted-metadata-changed", "accepted-run-changed", "candidate-graph-mismatch", "candidate-noncanonical",
  "derived-hash-mismatch", "foreign-store", "git-child-stop-failed", "git-cleanup-refused", "git-command-failed",
  "git-credential-invalid", "git-disk-limit", "git-not-initialized", "git-object-invalid", "git-pack-checksum-invalid",
  "git-pack-command-failed", "git-pack-deadline", "git-pack-delta-base-invalid", "git-pack-delta-copy-invalid",
  "git-pack-delta-limit", "git-pack-delta-literal-invalid", "git-pack-delta-offset-invalid", "git-pack-delta-result-invalid",
  "git-pack-delta-truncated", "git-pack-expanded-limit", "git-pack-header-invalid", "git-pack-inflate-invalid",
  "git-pack-limit", "git-pack-negotiation-invalid", "git-pack-object-limit", "git-pack-object-type-refused",
  "git-pack-objects-limit", "git-pack-response-invalid", "git-pack-tail-invalid", "git-pack-truncated",
  "git-pack-write-failed", "git-path-refused", "git-ref-invalid", "git-ref-not-commit", "git-remote-refused",
  "git-scratch-link", "git-test-remote-refused", "git-test-root-refused", "git-tree-mode-refused", "immutable-file",
  "jitter-invalid", "lease-exhausted", "lease-invalid", "local-cleanup-refused", "local-file-changed",
  "local-file-refused", "local-link-refused", "local-lock-failed", "local-path-refused", "local-pending-exists",
  "local-tip-invalid", "local-version-conflict", "metadata-invalid", "staged-blob-path-refused", "store-file-changed",
  "store-file-limit", "store-file-missing", "store-files-limit", "store-graph-invalid", "store-listing-invalid",
  "store-operation-failed", "store-path-refused", "store-target-refused", "store-tree-limit", "stored-png-invalid",
  "transaction-rollback", "unmarked-store", "store-version-refused", "store-document-invalid",
]);
const diagnosticIdentity = new WeakMap<object, string | undefined>();
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    const known = typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : undefined;
    const safe = known ?? "store-operation-failed";
    super(`pixelwatch-store: ${safe}`); this.name = "StoreError"; this.code = safe;
    diagnosticIdentity.set(this, known);
  }
}
export function refuse(code: string): never { throw new StoreError(code); }
/** No native filesystem/process diagnostic crosses the trusted adapter boundary. */
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    const known = typeof error === "object" && error !== null ? diagnosticIdentity.get(error) : undefined;
    throw new StoreError(known ?? "store-operation-failed");
  }
}

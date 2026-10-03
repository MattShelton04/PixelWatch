import type { Breakdown, ExpiryReason, PagesSite, PrState, ProjectedSizes, SiteCategory, SiteUrls, StoreTree } from "@pixelwatch/core";
import type { Config } from "@pixelwatch/schemas";
import type { CommitMetadata, StoreSnapshot, WriteRunResult, WriterCheckpoint } from "@pixelwatch/store";

/** Trusted default-branch policy, authenticated target and pinned release inputs. */
export interface PublisherContext {
  readonly config: Config;
  readonly configCommit: string;
  readonly pages: PagesSite;
  readonly repository: { readonly repositoryId: string; readonly owner: string; readonly name: string };
  readonly assets: { readonly release: string; readonly releaseCommit: string; readonly script: Uint8Array };
}
export interface AssemblyInput extends PublisherContext { readonly snapshot: StoreSnapshot }
export interface SizingInput extends PublisherContext { readonly tree: StoreTree }
export interface AssembledFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly category: SiteCategory;
  readonly immutable: boolean;
  readonly sha256: string;
}
export interface AssembledSite {
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
export interface AdmissionDependencies {
  readonly context: PublisherContext;
  readonly metadata: CommitMetadata;
  readonly now: string;
  readonly prStates: ReadonlyMap<string, PrState>;
  readonly pins?: ReadonlySet<string>;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly jitter: (attempt: number) => number;
  readonly checkpoint?: (event: WriterCheckpoint) => Promise<void>;
}
export type AdmissionResult = WriteRunResult | {
  readonly status: "expired";
  readonly runKey: string;
  readonly tip: string;
  readonly reason: ExpiryReason;
  readonly attempts: number;
};
/** Signature frozen separately from implementation for parallel consumers. */
export type SiteMeasurement = (input: SizingInput) => ProjectedSizes;
const DIAGNOSTIC_CODES = new Set([
  "publisher-operation-failed", "publisher-input-invalid", "invalid-commit", "json-limit",
  "unsupported-document-version", "invalid-document", "repository-invalid", "app-invalid",
  "site-budget-refused", "repository-mismatch", "store-graph-invalid", "store-files-limit",
  "store-path-refused", "store-listing-invalid", "store-file-limit", "store-tree-limit",
  "generated-path-refused", "store-absent", "store-reader-invalid", "site-listing-invalid",
  "store-read-failed", "stored-file-changed", "stored-run-changed", "stored-png-invalid",
  "stored-derived-changed", "run-missing", "byte-array-invalid", "byte-array-limit",
  "admission-tip-invalid", "admission-time-invalid", "admission-blob-invalid",
  "admission-release-invalid", "admission-config-invalid", "admission-run-invalid",
  "admission-repository-invalid", "admission-pr-state-invalid", "admission-pin-invalid",
  "admission-foreign-store", "admission-absent-store-invalid", "admission-files-limit",
  "admission-listing-invalid", "admission-unmarked-store", "admission-store-graph-invalid",
  "admission-file-missing", "admission-file-changed", "admission-index-mismatch",
  "admission-record-mismatch", "admission-png-invalid", "admission-derived-mismatch",
  "admission-immutable-file", "admission-budget-refused", "admission-plan-invalid",
  "admission-cas-invalid", "admission-jitter-invalid", "admission-lease-exhausted",
]);
const diagnosticIdentity = new WeakMap<object, string | undefined>();
export class PublisherError extends Error {
  readonly code: string;
  constructor(code: string) {
    const known = typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : undefined;
    const safe = known ?? "publisher-operation-failed";
    super(`pixelwatch-publisher: ${safe}`); this.name = "PublisherError"; this.code = safe;
    diagnosticIdentity.set(this, known);
  }
}
export function refuse(code: string): never { throw new PublisherError(code); }
/** Caller-visible error fields and prototypes never authenticate a diagnostic. */
export function sanitizePublisherError(error: unknown, fallback: string): PublisherError {
  const known = typeof error === "object" && error !== null ? diagnosticIdentity.get(error) : undefined;
  const code = known ?? (DIAGNOSTIC_CODES.has(fallback) ? fallback : "publisher-operation-failed");
  return new PublisherError(code);
}
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw sanitizePublisherError(error, "publisher-operation-failed"); }
}

import type { Breakdown, ExpiryReason, IgnoredArtifact, PagesSite, PngWorker, PrState, ProjectedSizes, SiteCategory, SiteUrls, StoreTree } from "@pixelwatch/core";
import type { Config, Run, Store } from "@pixelwatch/schemas";
import type { CommitMetadata, StoreAdapter, StoreSnapshot, WriteRunResult, WriterCheckpoint } from "@pixelwatch/store";
import type { DeploymentHistory, EnvironmentMetadata, GitHubClient, HttpTransport, MissingArtifact, PublicPagesMetadata, ReportJobIdentity, SourceDiagnostic, Timing } from "@pixelwatch/forge-github";

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
  /** Checked before each new CAS; an already-sent push still completes bounded recovery. */
  readonly signal?: AbortSignal;
}
export type AdmissionResult = (WriteRunResult | {
  readonly status: "expired";
  readonly runKey: string;
  readonly tip: string;
  readonly reason: ExpiryReason;
  readonly attempts: number;
}) & { readonly warnings?: readonly "checkpoint-failed"[] };
/** Signature frozen separately from implementation for parallel consumers. */
export type SiteMeasurement = (input: SizingInput) => ProjectedSizes;
/** Authenticated workflow_run input; target/policy/release always come from trusted context. */
export interface SourceJobInput extends PublisherContext { readonly event: Uint8Array }
export type SourceJobCheckpoint = "verified" | "listed" | "downloaded" | "analysed" | "before-admission";
export interface SourceJobDependencies {
  readonly forge: Pick<GitHubClient, "verifySource" | "listArtifacts" | "downloadArtifacts">;
  readonly store: StoreAdapter;
  readonly admission: Omit<AdmissionDependencies, "context" | "signal">;
  readonly timing: Pick<Timing, "deadline">;
  /** Production defaults to the real PngWorker; deterministic simulations inject equivalent ports. */
  readonly worker?: Pick<PngWorker, "decode" | "encode" | "compare" | "close">;
  readonly signal?: AbortSignal;
  readonly checkpoint?: (point: SourceJobCheckpoint) => Promise<void>;
}
export interface SourceJobDiagnostics {
  readonly source: readonly SourceDiagnostic[];
  /** Fixed categories and authenticated numeric IDs; no signed URLs or raw names in summaries. */
  readonly missing: readonly Pick<MissingArtifact, "artifactId" | "reason">[];
  readonly ignored: readonly Pick<IgnoredArtifact, "artifactId" | "reason">[];
  readonly ignoredOverflow: number;
  readonly excludedCount: number;
  /** Cleanup failure cannot conceal a proven durable admission. */
  readonly cleanup: readonly "timing-disposal-failed"[];
}
export interface SourceJobResult {
  readonly admission: AdmissionResult;
  readonly diagnostics: SourceJobDiagnostics;
  /** This stage makes no deployment/readiness/comment claim. */
  readonly projection: "pending" | "not-retained";
}
/** Internal workflow_dispatch GC, without a synthetic capture or caller deletion plan. */
export interface MaintenanceDependencies extends AdmissionDependencies {
  readonly timing: Pick<Timing, "deadline">;
}
export interface MaintenanceResult {
  readonly status: "absent" | "unchanged" | "updated" | "recovered";
  readonly tip: string | null;
  readonly attempts: number;
  /** Lost replies observed, including any superseded transaction whose acceptance is unproved. */
  readonly unknownPushes: number;
  /** Exact deletions of the confirmed transaction; empty for absent/unchanged observations. */
  readonly deleted: readonly {readonly path: string; readonly bytes: number}[];
  readonly removedRuns: readonly string[];
  readonly warnings?: readonly ("checkpoint-failed" | "timing-disposal-failed")[];
}
export interface ReadinessTarget {
  readonly prNumber: string;
  readonly runKey: string;
  readonly headSha: string;
}
export interface ReadinessInput {
  readonly context: PublisherContext;
  readonly site: AssembledSite;
  readonly targets: readonly ReadinessTarget[];
  readonly signal?: AbortSignal;
}
export type ReadinessPollCode = "matched" | "http-status" | "redirect-refused" | "json-invalid"
  | "unsupported-version" | "identity-mismatch" | "generation-mismatch" | "pointer-mismatch"
  | "digest-mismatch" | "body-limit" | "request-timeout" | "transport-failed";
export interface ReadinessPoll {
  readonly poll: number;
  readonly startedMilliseconds: number;
  readonly finishedMilliseconds: number;
  readonly passed: boolean;
  readonly code: ReadinessPollCode;
}
export interface ReadinessDependencies {
  readonly transport: HttpTransport;
  readonly timing: Timing;
  /** Monotonic injected clock. Production caller supplies performance.now(). */
  readonly now: () => number;
  readonly checkpoint?: (poll: ReadinessPoll) => Promise<void>;
}
export interface ReadinessResult {
  readonly status: "served" | "pending";
  readonly reason: "ready" | "timeout" | "cancelled";
  readonly generation: string;
  readonly pollCount: number;
  readonly consecutivePasses: number;
  readonly elapsedMilliseconds: number;
  readonly polls: readonly ReadinessPoll[];
}
export interface CommentStamp {
  readonly runKey: string;
  readonly headSha?: string;
  readonly generation: string;
}
export interface ProjectionPrepareInput {
  readonly repository: PublisherContext["repository"];
  readonly assets: PublisherContext["assets"];
  readonly report: ReportJobIdentity;
}
export type ProjectionDeferredReason = "comment-disabled" | "pr-closed" | "pr-unavailable"
  | "no-eligible-run" | "pointer-mismatch" | "head-changed" | "comment-order-unproved";
export interface ProjectionDeferred {readonly prNumber: string; readonly reason: ProjectionDeferredReason}
export type ProjectionWarning = "timing-disposal-failed" | "store-close-failed" | "listener-cleanup-failed";
/** Exact prepared generation. Persisted capsules omit and reconstruct derived URL methods. */
export interface PreparedProjection {
  readonly schemaVersion: 1;
  readonly context: PublisherContext;
  readonly defaultBranch: string;
  readonly report: ReportJobIdentity;
  readonly environment: EnvironmentMetadata;
  readonly deployment: DeploymentHistory;
  readonly store: Store;
  readonly records: readonly Run[];
  readonly site: AssembledSite;
  readonly targets: readonly ReadinessTarget[];
  readonly deferred: readonly ProjectionDeferred[];
  readonly warnings?: readonly ProjectionWarning[];
}
export type ProjectionPreparation = {readonly status: "absent"; readonly repositoryId: string; readonly warnings?: readonly ProjectionWarning[]}
  | {readonly status: "prepared"; readonly projection: PreparedProjection};
export interface ProjectionPrepareDependencies {
  readonly forge: Pick<GitHubClient, "readDefaultConfig" | "getPages" | "getPullRequest">;
  readonly metadata: PublicPagesMetadata;
  /** Constructed from fresh authenticated policy after the workflow lock, never preloaded. */
  readonly openStore: (input: {readonly repository: PublisherContext["repository"]; readonly defaultBranch: string; readonly branch: string})
    => Promise<{readonly store: Pick<StoreAdapter, "read">; close(): void | Promise<void>}>;
  readonly transport: HttpTransport;
  readonly timing: Timing;
  readonly signal?: AbortSignal;
}
export interface ProjectionDeploymentObservation {
  readonly outcome: "success" | "failure" | "cancelled" | "unknown" | "not-attempted";
}
export type ProjectionCommentResult = {readonly prNumber: string; readonly runKey: string} & (
  {readonly status: "unchanged" | "created" | "updated" | "recovered"; readonly commentId: string}
  | {readonly status: "deferred"; readonly reason: ProjectionDeferredReason | "readiness-pending"}
  | {readonly status: "failed"; readonly reason: "comment-operation-failed"}
  | {readonly status: "disabled"}
);
export interface ProjectionFinishDependencies {
  readonly forge: Pick<GitHubClient, "getRepository" | "getPullRequest" | "getPublishingBot" | "reconcileComment">;
  readonly readiness: ReadinessDependencies;
  readonly signal?: AbortSignal;
}
export interface ProjectionResult {
  readonly defaultBranch: string;
  readonly reportWorkflowPath: string;
  readonly storeTip: string;
  readonly generation: string;
  readonly configCommit: string;
  readonly releaseCommit: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly deployment: ProjectionDeploymentObservation["outcome"];
  readonly readiness: ReadinessResult;
  readonly comments: readonly ProjectionCommentResult[];
  readonly deferred: readonly ProjectionDeferred[];
  readonly warnings?: readonly ProjectionWarning[];
}
export interface CommentRenderInput {
  readonly context: PublisherContext;
  readonly run: Run;
  readonly generation: string;
}
export type RenderedComment = { readonly status: "disabled" } | {
  readonly status: "rendered";
  readonly body: string;
  readonly fallbackBody: string;
  readonly bytes: number;
  readonly degradation: "full" | "shortened" | "summary";
  readonly stamp: CommentStamp;
};
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
  "admission-cancelled", "admission-signal-invalid",
  "admission-checkpoint-failed",
  "readiness-input-invalid", "readiness-timing-invalid", "readiness-operation-failed",
  "source-job-input-invalid", "source-job-operation-failed", "source-job-cancelled",
  "source-job-source-invalid", "source-job-download-invalid", "source-job-codec-failed",
  "source-job-staging-invalid", "source-job-staging-limit", "source-job-timing-invalid",
  "comment-input-invalid", "comment-budget-refused",
  "maintenance-input-invalid", "maintenance-budget-refused", "maintenance-plan-invalid",
  "maintenance-cas-invalid", "maintenance-checkpoint-failed", "maintenance-lease-exhausted",
  "maintenance-cancelled", "maintenance-operation-failed", "maintenance-timing-invalid",
  "projection-input-invalid", "projection-operation-failed", "projection-cancelled",
  "projection-site-ownership-refused", "projection-pages-setup-required", "projection-state-invalid",
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

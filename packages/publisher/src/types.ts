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
export class PublisherError extends Error {
  readonly code: string;
  constructor(code: string) { super(`pixelwatch-publisher: ${code}`); this.name = "PublisherError"; this.code = code; }
}
export function refuse(code: string): never { throw new PublisherError(code); }
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (error instanceof PublisherError) throw error; return refuse("publisher-operation-failed"); }
}

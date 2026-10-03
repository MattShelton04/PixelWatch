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
export type CasResult = { readonly status: "accepted"; readonly tip: string } | { readonly status: "conflict" } | { readonly status: "unknown" };
export interface StoreAdapter {
  read(): Promise<StoreSnapshot>;
  cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult>;
}
export interface StoreIdentity { readonly repositoryId: string; readonly defaultBranch: string; readonly branch?: string }
export const STORE_LIMITS = Object.freeze({ maxFiles: 100_000, maxTreeBytes: 1024 * 1024 * 1024, maxJsonBytes: 1024 * 1024, maxPngBytes: 32 * 1024 * 1024, processTimeoutMs: 60_000 });
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(`pixelwatch-store: ${code}`); this.name = "StoreError"; this.code = code; }
}
export function refuse(code: string): never { throw new StoreError(code); }
/** No native filesystem/process diagnostic crosses the trusted adapter boundary. */
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (error instanceof StoreError) throw error; return refuse("store-operation-failed"); }
}

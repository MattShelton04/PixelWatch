import { blobPath, classifyStorePath, parsePngStructure, type BlobPool } from "@pixelwatch/core";
import type { Run } from "@pixelwatch/schemas";
import { STORE_LIMITS, type StoreSnapshot } from "@pixelwatch/store";
import { copyBytes } from "./assembly-input.ts";
import { preflight, race } from "./ingress-input.ts";
import { refuse } from "./types.ts";
/** Private canonical staging; validated existing paths are reused without reading their pixels. */
export class StagingPool implements BlobPool {
  readonly #snapshot: StoreSnapshot;
  readonly #signal: AbortSignal;
  readonly #existing: Map<string, number>;
  readonly #staged = new Map<string, Uint8Array>();
  readonly #loaded = new Map<string, Uint8Array>();
  #bytes = 0;
  constructor(snapshot: StoreSnapshot, signal: AbortSignal) {
    this.#snapshot = snapshot;
    this.#signal = signal;
    this.#existing = new Map(snapshot.files.filter(file => classifyStorePath(file.path)?.kind === "blob").map(file => [file.path, file.bytes]));
  }
  has(path: string): Promise<boolean> {
    preflight(this.#signal);
    return Promise.resolve(this.#existing.has(path) || this.#staged.has(path));
  }
  add(path: string, supplied: Uint8Array): Promise<void> {
    preflight(this.#signal);
    if (classifyStorePath(path)?.kind !== "blob" || this.#existing.has(path) || this.#staged.has(path))
      refuse("source-job-staging-invalid");
    if (this.#staged.size + this.#loaded.size >= STORE_LIMITS.maxFiles)
      refuse("source-job-staging-limit");
    const bytes = copyBytes(supplied, Math.min(STORE_LIMITS.maxPngBytes, STORE_LIMITS.maxTreeBytes - this.#bytes));
    parsePngStructure(bytes);
    this.#bytes += bytes.byteLength;
    this.#staged.set(path, bytes);
    return Promise.resolve();
  }
  async read(path: string): Promise<Uint8Array> {
    preflight(this.#signal);
    const staged = this.#staged.get(path);
    if (staged !== undefined)
      return copyBytes(staged, STORE_LIMITS.maxPngBytes);
    const listed = this.#existing.get(path);
    if (listed === undefined)
      refuse("source-job-staging-invalid");
    let loaded = this.#loaded.get(path);
    if (loaded === undefined) {
      if (this.#staged.size + this.#loaded.size >= STORE_LIMITS.maxFiles || listed > STORE_LIMITS.maxTreeBytes - this.#bytes)
        refuse("source-job-staging-limit");
      loaded = await race(this.#snapshot.readFile(path), this.#signal, supplied => copyBytes(supplied, Math.min(STORE_LIMITS.maxPngBytes, STORE_LIMITS.maxTreeBytes - this.#bytes), listed));
      preflight(this.#signal);
      this.#bytes += loaded.byteLength;
      this.#loaded.set(path, loaded);
    }
    return copyBytes(loaded, STORE_LIMITS.maxPngBytes);
  }
  /** Carry only accepted-run references across concurrent GC, without pixel verification or reencoding. */
  async files(run: Run): Promise<ReadonlyMap<string, Uint8Array>> {
    const paths = new Set<string>();
    for (const result of run.results)
      for (const side of [result.base, result.head])
        if (side.state === "captured")
          paths.add(blobPath(side.pixelHash));
    if (paths.size > STORE_LIMITS.maxFiles)
      refuse("source-job-staging-limit");
    const files = new Map<string, Uint8Array>();
    for (const path of paths) {
      preflight(this.#signal);
      files.set(path, await this.read(path));
    }
    return files;
  }
}

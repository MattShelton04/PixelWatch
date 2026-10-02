// The store tree as a validated reference graph (03 §§3, 5; ADR 0012): store.json, run records,
// the blob and derived pools, and grace namespaces, each file with its size. Budget and GC plan
// over this graph. Anything it can't account for is an error, never something to delete:
//
// - a path outside the 03 §3 layout, a run record with no index entry, a namespace with no grace
//   record, or an index entry with no record;
// - a run record that disagrees with its index entry, or a reference to a file that isn't there;
// - derived references supplied, but not for a run that needs them.
import { type Run, type Store, compareGitHubIds, parseRunKey, validateDocument } from "@pixelwatch/schemas";
import { blobPath } from "../blob-pool.ts";
import { streamFor } from "../run/store.ts";
import { checkBytes, checkTimestamp, refuse } from "./errors.ts";
import { classifyStorePath, derivedPath, isOtherNamespace, runRecordPath } from "./paths.ts";
import { checkStore } from "./retention.ts";

export interface StoreFile {
  readonly path: string;
  readonly bytes: number;
}

/** An older data namespace kept after a migration (04 §3). Nothing writes one until M3.4. */
export interface GraceNamespace {
  /** `data/v<N>`, any namespace but the current `data/v1`. */
  readonly namespace: string;
  /** A GC root while `now` is before this time. */
  readonly until: string;
  /** Pixel hashes its records reference. */
  readonly blobs: readonly string[];
  /** Byte hashes of derived files its records reference. */
  readonly derived?: readonly string[];
}

export interface StoreTree {
  readonly store: Store;
  /** Every file in the store tree, with its size. */
  readonly files: readonly StoreFile[];
  /** Run records by run key: at least every run a plan keeps. */
  readonly runs: ReadonlyMap<string, Run>;
  readonly grace?: readonly GraceNamespace[] | undefined;
  /**
   * Derived files (byte hashes) each run references. run@1 doesn't record them, so the writer of
   * derived files supplies them. Absent: references are unknown, so every derived file is a root.
   */
  readonly derived?: ReadonlyMap<string, readonly string[]> | undefined;
}

/** Store paths a run or grace namespace holds alive. */
export interface References {
  readonly blobs: readonly string[];
  readonly derived: readonly string[];
}

type Entry = Store["runs"][number];

const SHA256 = /^[0-9a-f]{64}$/;
const byPath = (a: StoreFile, b: StoreFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function checkHashes(hashes: readonly string[], what: string): readonly string[] {
  for (const hash of hashes) if (!SHA256.test(hash)) refuse("invalid-input", `${what} must be 64-hex hashes`);
  return hashes;
}

export class StoreGraph {
  readonly store: Store;
  readonly entries: ReadonlyMap<string, Entry>;
  readonly grace: ReadonlyMap<string, GraceNamespace>;
  /** Each grace namespace's files, by path. */
  readonly graceFiles: ReadonlyMap<string, readonly StoreFile[]>;
  /** False when no derived references were supplied: every derived file is then a root. */
  readonly derivedKnown: boolean;
  readonly derivedFiles: readonly string[];
  private readonly sizes: ReadonlyMap<string, number>;
  private readonly runs: ReadonlyMap<string, Run>;
  private readonly derivedRefs: ReadonlyMap<string, readonly string[]> | undefined;
  private readonly cache = new Map<string, References>();

  constructor(tree: StoreTree) {
    this.store = checkStore(tree.store);
    this.entries = new Map(this.store.runs.map((e) => [e.runKey, e]));
    this.runs = tree.runs;

    const grace = new Map<string, GraceNamespace>();
    for (const g of tree.grace ?? []) {
      if (!isOtherNamespace(g.namespace)) refuse("invalid-input", "a grace namespace is data/v<N>, other than data/v1");
      if (grace.has(g.namespace)) refuse("invalid-input", "grace namespace listed twice");
      checkTimestamp(g.until, "grace until");
      checkHashes(g.blobs, "grace blobs");
      checkHashes(g.derived ?? [], "grace derived files");
      grace.set(g.namespace, g);
    }
    this.grace = grace;

    if (tree.derived !== undefined) {
      for (const [key, hashes] of tree.derived) {
        if (parseRunKey(key) === undefined) refuse("invalid-input", "derived references are keyed by run key");
        checkHashes(hashes, "derived references");
      }
    }
    this.derivedKnown = tree.derived !== undefined;
    this.derivedRefs = tree.derived;

    const sizes = new Map<string, number>();
    const graceFiles = new Map<string, StoreFile[]>();
    const derivedFiles: string[] = [];
    const records = new Set<string>();
    for (const file of tree.files) {
      if (typeof file.path !== "string") refuse("invalid-input", "a store path must be a string");
      if (sizes.has(file.path)) refuse("invalid-input", "a store path is listed twice");
      sizes.set(file.path, checkBytes(file.bytes, "a store file's size"));
      const kind = classifyStorePath(file.path);
      if (kind === undefined) refuse("unrecognized-path", "a store path is outside the 03 §3 layout");
      if (kind.kind === "run") {
        if (!this.entries.has(kind.runKey)) refuse("orphan-file", `run record ${kind.runKey} has no store.json entry`);
        records.add(kind.runKey);
      } else if (kind.kind === "derived") {
        derivedFiles.push(file.path);
      } else if (kind.kind === "grace") {
        if (!grace.has(kind.namespace)) refuse("orphan-file", `${kind.namespace} has no grace record`);
        const files = graceFiles.get(kind.namespace) ?? [];
        files.push({ path: file.path, bytes: file.bytes });
        graceFiles.set(kind.namespace, files);
      }
    }
    for (const key of this.entries.keys()) if (!records.has(key)) refuse("missing-file", `store.json lists ${key} but its run record is missing`);
    for (const files of graceFiles.values()) files.sort(byPath);
    this.sizes = sizes;
    this.graceFiles = graceFiles;
    this.derivedFiles = derivedFiles.sort();
  }

  /** Every file in the tree, by path. */
  files(): StoreFile[] {
    return [...this.sizes].map(([path, bytes]) => ({ path, bytes })).sort(byPath);
  }

  bytes(path: string): number {
    const size = this.sizes.get(path);
    if (size === undefined) refuse("missing-file", "a referenced store file is missing");
    return size;
  }

  /** The blobs and derived files a run's record references. Checks the record against its entry. */
  refs(runKey: string): References {
    const cached = this.cache.get(runKey);
    if (cached) return cached;
    const entry = this.entries.get(runKey);
    if (entry === undefined) refuse("invalid-input", `${runKey} isn't in the store`);
    const run = this.runs.get(runKey);
    if (run === undefined) refuse("missing-run-data", `no run record was supplied for ${runKey}`);
    const valid = validateDocument("run", run);
    if (!valid.ok) refuse("run-mismatch", `the record supplied for ${runKey} is invalid: ${valid.issue.message}`);
    if (
      run.runKey !== runKey ||
      run.source.createdAt !== entry.sourceCreatedAt ||
      streamFor(run.source) !== entry.stream ||
      compareGitHubIds(run.source.repositoryId, this.store.repositoryId) !== 0
    ) {
      refuse("run-mismatch", `the record supplied for ${runKey} disagrees with its store.json entry`);
    }
    const blobs = new Set<string>();
    for (const r of run.results) {
      for (const side of [r.base, r.head]) if (side.state === "captured") blobs.add(blobPath(side.pixelHash));
    }
    let derived: readonly string[] = [];
    if (this.derivedRefs !== undefined) {
      const hashes = this.derivedRefs.get(runKey);
      if (hashes === undefined) refuse("unknown-references", `derived references for ${runKey} weren't supplied`);
      derived = [...new Set(hashes.map(derivedPath))];
    }
    const refs = this.existing({ blobs: [...blobs].sort(), derived: [...derived].sort() }, runKey);
    this.cache.set(runKey, refs);
    return refs;
  }

  /**
   * What a grace namespace holds alive. A namespace whose files are all gone holds nothing. While
   * derived references are unknown every derived file is a root anyway, so none are listed.
   */
  graceRefs(namespace: string): References {
    const g = this.grace.get(namespace);
    if (g === undefined) refuse("invalid-input", `${namespace} has no grace record`);
    if (!this.graceFiles.has(namespace)) return { blobs: [], derived: [] };
    const refs = this.existing({ blobs: [...new Set(g.blobs.map(blobPath))].sort(), derived: [...new Set((g.derived ?? []).map(derivedPath))].sort() }, namespace);
    return this.derivedKnown ? refs : { blobs: refs.blobs, derived: [] };
  }

  private existing(refs: References, owner: string): References {
    for (const path of [...refs.blobs, ...refs.derived]) {
      if (!this.sizes.has(path)) refuse("missing-file", `${owner} references ${path}, which isn't in the store`);
    }
    return refs;
  }

  runRecordBytes(runKey: string): number {
    return this.bytes(runRecordPath(runKey));
  }
}

export function readStoreTree(tree: StoreTree): StoreGraph {
  return new StoreGraph(tree);
}

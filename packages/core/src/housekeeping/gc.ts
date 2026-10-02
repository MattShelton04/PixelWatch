// GC planning (03 §5; ADR 0012): from the runs and grace namespaces a plan keeps, the roots, the
// rebuilt store index and the exact store-tree delete list with sizes. It's a dry run: the store
// adapter (M2.2) applies it. Planning again on the result deletes nothing.
//
// Roots: store.json; each kept run's record and the blobs and derived files it references; every
// derived file while references are unknown; each kept grace namespace's files and references.
// Everything else in the tree is deleted. The tree has already refused anything it can't account
// for (tree.ts), so an unknown file or a broken reference never turns into a deletion.
import { type Store, validateDocument } from "@pixelwatch/schemas";
import { refuse } from "./errors.ts";
import { STORE_INDEX, runRecordPath } from "./paths.ts";
import type { StoreFile, StoreGraph } from "./tree.ts";

export interface GcKeep {
  readonly runs: ReadonlySet<string>;
  readonly grace: ReadonlySet<string>;
}

export interface GcPlan {
  /** store.json with only the kept runs. Unchanged (the same object) when nothing is deleted. */
  readonly store: Store;
  readonly changed: boolean;
  /** Exact paths and sizes to delete, by path. */
  readonly delete: readonly StoreFile[];
  readonly deleteBytes: number;
  /** Store-branch size before and after, which the site budget doesn't measure (03 §1). */
  readonly storeBytes: { readonly before: number; readonly after: number };
  /** Runs leaving the index, in history order. */
  readonly removedRuns: readonly string[];
}

export function planGc(graph: StoreGraph, keep: GcKeep): GcPlan {
  for (const key of keep.runs) if (!graph.entries.has(key)) refuse("invalid-input", `${key} isn't in the store`);
  for (const namespace of keep.grace) if (!graph.grace.has(namespace)) refuse("invalid-input", `${namespace} has no grace record`);

  const roots = new Set<string>([STORE_INDEX]);
  if (!graph.derivedKnown) for (const path of graph.derivedFiles) roots.add(path);
  for (const key of keep.runs) {
    roots.add(runRecordPath(key));
    const refs = graph.refs(key);
    for (const path of [...refs.blobs, ...refs.derived]) roots.add(path);
  }
  for (const namespace of keep.grace) {
    for (const file of graph.graceFiles.get(namespace) ?? []) roots.add(file.path);
    const refs = graph.graceRefs(namespace);
    for (const path of [...refs.blobs, ...refs.derived]) roots.add(path);
  }

  const files = graph.files();
  const deletions = files.filter((f) => !roots.has(f.path));
  const before = files.reduce((sum, f) => sum + f.bytes, 0);
  const deleteBytes = deletions.reduce((sum, f) => sum + f.bytes, 0);
  const removedRuns = graph.store.runs.filter((r) => !keep.runs.has(r.runKey)).map((r) => r.runKey);

  let store = graph.store;
  if (deletions.length > 0) {
    const next: Store = { ...store, txn: store.txn + 1, runs: store.runs.filter((r) => keep.runs.has(r.runKey)) };
    const valid = validateDocument("store", next);
    if (!valid.ok) throw new Error(`GC built an invalid store: ${valid.issue.message}`);
    store = valid.value;
  }
  return {
    store,
    changed: deletions.length > 0,
    delete: deletions,
    deleteBytes,
    storeBytes: { before, after: before - deleteBytes },
    removedRuns,
  };
}

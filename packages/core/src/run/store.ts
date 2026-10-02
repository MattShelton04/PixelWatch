// The store run index and the streams derived from it (M1.5; 01 §4.4; 02 §8; 03 §3; ADR 0010).
// Pure: store.json in, store.json out. The store adapter (M2.2) reads and writes it.
//
// - A run key already in the index is a no-op: the stored run is never overwritten, whatever the
//   retry built (02 §8). A completed attempt's artifacts can't change, so the key is the input.
// - The index is in history order: source-created time, numeric run ID, numeric attempt.
// - A run's stream comes from its envelope only. Streams aren't stored; the projector derives them.
import {
  type Run,
  type SourceEnvelope,
  type Store,
  type Stream,
  compareGitHubIds,
  compareRunOrder,
  validateDocument,
} from "@pixelwatch/schemas";

/** stream@1 holds at most this many run keys; a longer stream keeps its most recent ones. */
export const MAX_STREAM_RUNS = 1000;

/** An empty, marked store for a repository (first creation, 03 §6). */
export function newStore(repositoryId: string): Store {
  return { schemaVersion: 1, marker: "pixelwatch-store", repositoryId, dataVersion: 1, txn: 0, runs: [] };
}

/**
 * The stream a run joins, from the envelope only (01 §§4.3–4.4):
 * - `push` → `main` (the forge admits push only on the default branch);
 * - `pull_request` with a corroborated association → `pr-<number>`;
 * - anything else (no or ambiguous association, `workflow_dispatch`) → none. The run is stored and
 *   in history, but no stream, so no PR comment, ever shows it.
 */
export function streamFor(source: SourceEnvelope): string | undefined {
  if (source.event === "push") return "main";
  const { status, prNumber } = source.association;
  if (source.event === "pull_request" && status === "corroborated" && prNumber !== undefined) return `pr-${prNumber}`;
  return undefined;
}

function checked(store: Store): Store {
  const result = validateDocument("store", store);
  if (!result.ok) throw new Error(`invalid store: ${result.issue.message}`);
  return result.value;
}

/**
 * Adds a run to the index in history order and counts one transaction. A run key already present
 * returns the same store object with `added: false`, and the stored entry is never replaced.
 */
export function addRun(store: Store, run: Run): { store: Store; added: boolean } {
  checked(store);
  const valid = validateDocument("run", run);
  if (!valid.ok) throw new Error(`invalid run: ${valid.issue.message}`);
  if (compareGitHubIds(run.source.repositoryId, store.repositoryId) !== 0) throw new Error("the run belongs to another repository than the store");
  if (store.runs.some((r) => r.runKey === run.runKey)) return { store, added: false };

  const stream = streamFor(run.source);
  const entry: Store["runs"][number] = { runKey: run.runKey, sourceCreatedAt: run.source.createdAt, ...(stream === undefined ? {} : { stream }) };
  const at = store.runs.findIndex((r) => compareRunOrder(entry, r) < 0);
  const runs = [...store.runs];
  runs.splice(at < 0 ? runs.length : at, 0, entry);
  return { store: checked({ ...store, txn: store.txn + 1, runs }), added: true };
}

function compareStreamIds(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "main") return -1;
  if (b === "main") return 1;
  return compareGitHubIds(a.slice(3), b.slice(3));
}

/** stream@1 for every stream in the index: main first, then PRs by number; runs in history order. */
export function deriveStreams(store: Store): Stream[] {
  const byStream = new Map<string, string[]>();
  for (const entry of checked(store).runs) {
    if (entry.stream === undefined) continue;
    const runs = byStream.get(entry.stream) ?? [];
    runs.push(entry.runKey);
    byStream.set(entry.stream, runs);
  }
  return [...byStream.keys()].sort(compareStreamIds).map((streamId) => {
    const runs = (byStream.get(streamId) ?? []).slice(-MAX_STREAM_RUNS);
    return { schemaVersion: 1, streamId, runs, latest: runs.at(-1) ?? null };
  });
}

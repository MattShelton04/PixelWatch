// Identifiers from 02 §3 and the artifact name from 02 §6.
import type { Revision, Shard } from "./generated/types.ts";

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** GitHub numeric IDs are nonzero decimal strings without leading zeros. */
export const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
export const MAX_SHARDS = 64;

export function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isGitHubId(value: string): boolean {
  return GITHUB_ID_PATTERN.test(value);
}

/** Compares GitHub numeric ID strings numerically, never lexically or as floats. */
export function compareGitHubIds(a: string, b: string): number {
  if (!isGitHubId(a) || !isGitHubId(b)) throw new Error("not a GitHub numeric ID");
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export type ParsedRunKey =
  | { readonly kind: "source"; readonly runId: string; readonly attempt: string }
  | { readonly kind: "import"; readonly digest: string };

export function formatRunKey(runId: string, attempt: string): string {
  if (!isGitHubId(runId) || !isGitHubId(attempt)) throw new Error("run ID and attempt must be GitHub numeric IDs");
  return `${runId}-a${attempt}`;
}

export function parseRunKey(key: string): ParsedRunKey | undefined {
  const source = /^([1-9][0-9]{0,18})-a([1-9][0-9]{0,18})$/.exec(key);
  if (source) return { kind: "source", runId: source[1] ?? "", attempt: source[2] ?? "" };
  const imported = /^import-([0-9a-f]{64})$/.exec(key);
  if (imported) return { kind: "import", digest: imported[1] ?? "" };
  return undefined;
}

/** A store.json run entry's ordering fields. */
export interface RunOrderKey {
  readonly runKey: string;
  readonly sourceCreatedAt: string;
}

/**
 * History order (02 §8): source-created time, then numeric run ID, then numeric attempt. Publish
 * time never counts. Timestamps are fixed-width UTC, so they compare as strings. Imported runs
 * sort after source runs created at the same second, then by digest.
 */
export function compareRunOrder(a: RunOrderKey, b: RunOrderKey): number {
  if (a.sourceCreatedAt !== b.sourceCreatedAt) return a.sourceCreatedAt < b.sourceCreatedAt ? -1 : 1;
  const x = parseRunKey(a.runKey);
  const y = parseRunKey(b.runKey);
  if (x === undefined || y === undefined) throw new Error("not a run key");
  if (x.kind === "source" && y.kind === "source") return compareGitHubIds(x.runId, y.runId) || compareGitHubIds(x.attempt, y.attempt);
  if (x.kind === "import" && y.kind === "import") return x.digest < y.digest ? -1 : x.digest > y.digest ? 1 : 0;
  return x.kind === "source" ? -1 : 1;
}

/** Stream order: `main` first, then `pr-<number>` by number. */
export function compareStreamIds(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "main") return -1;
  if (b === "main") return 1;
  return compareGitHubIds(a.slice(3), b.slice(3));
}

/** Identity of one uploaded part: attempt × revision × provider × shard. */
export interface PartIdentity {
  readonly attempt: string;
  readonly revision: Revision;
  readonly providerId: string;
  readonly shard: Shard;
}

export function isValidShard(shard: Shard): boolean {
  return (
    Number.isSafeInteger(shard.index) &&
    Number.isSafeInteger(shard.count) &&
    shard.count >= 1 &&
    shard.count <= MAX_SHARDS &&
    shard.index >= 1 &&
    shard.index <= shard.count
  );
}

const ARTIFACT_NAME =
  /^pixelwatch-b1-a([1-9][0-9]{0,18})-(base|head)-([a-z0-9][a-z0-9_-]{0,63})-s([1-9][0-9]?)-of([1-9][0-9]?)$/;

export function formatArtifactName(part: PartIdentity): string {
  if (!isGitHubId(part.attempt) || !isId(part.providerId) || !isValidShard(part.shard)) {
    throw new Error("invalid part identity");
  }
  const { attempt, revision, providerId, shard } = part;
  return `pixelwatch-b1-a${attempt}-${revision}-${providerId}-s${String(shard.index)}-of${String(shard.count)}`;
}

/** Parses `pixelwatch-b1-a<attempt>-<base|head>-<provider>-s<index>-of<count>`; undefined if invalid. */
export function parseArtifactName(name: string): PartIdentity | undefined {
  const match = ARTIFACT_NAME.exec(name);
  if (!match) return undefined;
  const [, attempt = "", revision, providerId = "", index = "", count = ""] = match;
  const part: PartIdentity = {
    attempt,
    revision: revision === "base" ? "base" : "head",
    providerId,
    shard: { index: Number(index), count: Number(count) },
  };
  return isValidShard(part.shard) ? part : undefined;
}

/** A captured unit's image in its bundle: `<viewId>.<variantId>.png` (IDs never contain a dot). */
export const UNIT_FILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.[a-z0-9][a-z0-9_-]{0,63}\.png$/;

export function unitFileName(unit: { readonly viewId: string; readonly variantId: string }): string {
  return `${unit.viewId}.${unit.variantId}.png`;
}

/** Orders unit keys by their three ASCII IDs (02 §3). */
export function compareUnitKeys(
  a: { readonly providerId: string; readonly viewId: string; readonly variantId: string },
  b: { readonly providerId: string; readonly viewId: string; readonly variantId: string },
): number {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(a.providerId, b.providerId) || cmp(a.viewId, b.viewId) || cmp(a.variantId, b.variantId);
}

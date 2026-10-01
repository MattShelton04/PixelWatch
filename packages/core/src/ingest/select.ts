// Artifact selection (02 §6 step 1), from names alone. Only the expected names for the
// authenticated attempt are selected; every other artifact is ignored with a reason and never
// opened, so parts of different attempts can't mix. Two artifacts with one part's name are both
// held back: the part is rejected, never resolved by picking one.
import { type Config, boundLabel, compareGitHubIds, isGitHubId, parseArtifactName } from "@pixelwatch/schemas";
import { IngressError } from "./errors.ts";
import { INGEST_LIMITS } from "./limits.ts";
import type { ArtifactInput, Baseline, IgnoredArtifact, IgnoredReason, PartKey } from "./types.ts";

export const MAX_IGNORED = 256;

export interface SelectedPart {
  readonly key: PartKey;
  readonly artifact: ArtifactInput;
}

export interface DuplicatePart {
  readonly key: PartKey;
  /** Sorted by numeric artifact ID. */
  readonly artifacts: readonly ArtifactInput[];
}

export interface Selection {
  /** One artifact per part key, sorted by part key. */
  readonly selected: readonly SelectedPart[];
  readonly duplicates: readonly DuplicatePart[];
  readonly ignored: readonly IgnoredArtifact[];
  readonly ignoredOverflow: number;
}

export interface SelectionInput {
  readonly artifacts: readonly ArtifactInput[];
  readonly config: Config;
  readonly attempt: string;
  readonly baseline: Baseline;
}

/** Orders part keys: base before head, then provider ID, then shard index. */
export function comparePartKeys(a: PartKey, b: PartKey): number {
  if (a.revision !== b.revision) return a.revision === "base" ? -1 : 1;
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
  return a.shard.index - b.shard.index;
}

export function partKeyString(key: PartKey): string {
  return `${key.revision}/${key.providerId}/${String(key.shard.index)}`;
}

/** The parts the trusted config expects: every provider × shard, for head and (with a baseline) base. */
export function expectedParts(config: Config, baseline: Baseline): PartKey[] {
  const revisions = baseline === "none" ? (["head"] as const) : (["base", "head"] as const);
  const parts: PartKey[] = [];
  for (const revision of revisions) {
    for (const provider of config.providers) {
      for (let index = 1; index <= provider.shards; index++) {
        parts.push({ revision, providerId: provider.id, shard: { index, count: provider.shards } });
      }
    }
  }
  return parts.sort(comparePartKeys);
}

function classify(name: string, input: SelectionInput, shards: ReadonlyMap<string, number>): PartKey | IgnoredReason {
  if (!name.startsWith("pixelwatch-")) return "not-pixelwatch";
  const version = /^pixelwatch-b([0-9]+)-/.exec(name);
  if (version === null) return "malformed-name";
  if (version[1] !== "1") return "unsupported-bundle-version";
  const part = parseArtifactName(name);
  if (part === undefined) return "malformed-name";
  if (part.attempt !== input.attempt) return "other-attempt";
  if (shards.get(part.providerId) !== part.shard.count) return "unexpected-part";
  if (part.revision === "base" && input.baseline === "none") return "base-not-expected";
  return { revision: part.revision, providerId: part.providerId, shard: part.shard };
}

export function selectArtifacts(input: SelectionInput): Selection {
  if (!isGitHubId(input.attempt)) throw new TypeError("attempt must be a GitHub numeric ID");
  if (input.artifacts.length > INGEST_LIMITS.maxArtifacts) {
    throw new IngressError("ingest-too-many-artifacts", `more than ${String(INGEST_LIMITS.maxArtifacts)} artifacts for one source attempt`);
  }
  const ids = new Set<string>();
  for (const artifact of input.artifacts) {
    // The forge (M2.1) lists these; a bad or repeated ID is a caller bug, not hostile input.
    if (!isGitHubId(artifact.artifactId)) throw new TypeError("artifact IDs must be GitHub numeric IDs");
    if (ids.has(artifact.artifactId)) throw new TypeError("artifact IDs must be unique");
    ids.add(artifact.artifactId);
  }
  const shards = new Map(input.config.providers.map((p) => [p.id, p.shards]));
  const byKey = new Map<string, { key: PartKey; artifacts: ArtifactInput[] }>();
  const ignored: IgnoredArtifact[] = [];
  for (const artifact of input.artifacts) {
    const verdict = classify(artifact.artifactName, input, shards);
    if (typeof verdict === "string") {
      ignored.push({ artifactId: artifact.artifactId, name: boundLabel(artifact.artifactName.slice(0, 512)) ?? "(empty)", reason: verdict });
      continue;
    }
    const id = partKeyString(verdict);
    const group = byKey.get(id) ?? { key: verdict, artifacts: [] };
    group.artifacts.push(artifact);
    byKey.set(id, group);
  }
  const byId = (a: { artifactId: string }, b: { artifactId: string }) => compareGitHubIds(a.artifactId, b.artifactId);
  const groups = [...byKey.values()].sort((a, b) => comparePartKeys(a.key, b.key));
  ignored.sort(byId);
  return {
    selected: groups.flatMap((g) => (g.artifacts.length === 1 && g.artifacts[0] !== undefined ? [{ key: g.key, artifact: g.artifacts[0] }] : [])),
    duplicates: groups.filter((g) => g.artifacts.length > 1).map((g) => ({ key: g.key, artifacts: g.artifacts.sort(byId) })),
    ignored: ignored.slice(0, MAX_IGNORED),
    ignoredOverflow: Math.max(0, ignored.length - MAX_IGNORED),
  };
}

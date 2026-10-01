// Fixed-part merge (02 §6 steps 2–5; 02 §4; ADR 0008). Pure: parts that each validated on their
// own go in; per-unit side states, part reports and coverage come out. The result depends only on
// the sets of parts, never on their order, and nothing is resolved by picking one of two:
//
// - two parts with one key, or two parts of one revision listing the same unit key, are all
//   rejected;
// - the declared set is the union of the valid parts' catalogs;
// - a side no valid part lists is `missing`: `part-missing` when an expected part of that
//   revision and provider isn't valid (the unit may have been in it), else `unit-missing`;
// - a missing part's catalog is unknown, so it adds no units and reports no count.
//
// A unit absent on both sides, or absent with no baseline, isn't a unit (02 §4). It is left out
// of the declared set and counted in `excluded` (owner decision, ADR 0008).
import { type Config, type Coverage, type MissingPart, type Side, compareGitHubIds, compareUnitKeys } from "@pixelwatch/schemas";
import { IngressError } from "./errors.ts";
import { INGEST_LIMITS } from "./limits.ts";
import { comparePartKeys, expectedParts, partKeyString } from "./select.ts";
import type { ArtifactRef, Baseline, Excluded, Ingestion, MergedUnit, PartKey, PartReport, PartUnit, RejectedPart, UnitKey, ValidPart } from "./types.ts";

/** run@1 `parts` and `coverage.missingParts` hold at most 256 items; config@1 keeps Σ shards ≤ 128. */
export const MAX_PARTS = 256;
const MAX_EXCLUDED_SAMPLE = 16;

export interface MergeInput {
  readonly config: Config;
  readonly baseline: Baseline;
  readonly valid: readonly ValidPart[];
  readonly rejected: readonly RejectedPart[];
}

export type MergeResult = Pick<Ingestion, "units" | "coverage" | "parts" | "excluded">;

function compareArtifacts(a: ArtifactRef, b: ArtifactRef): number {
  return compareGitHubIds(a.artifactId, b.artifactId) || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
}

function keyOf(part: PartKey): PartKey {
  return { revision: part.revision, providerId: part.providerId, shard: { index: part.shard.index, count: part.shard.count } };
}

function unitId(providerId: string, viewId: string, variantId: string): string {
  return `${providerId}\u0000${viewId}\u0000${variantId}`;
}

export function mergeParts(input: MergeInput): MergeResult {
  const expected = expectedParts(input.config, input.baseline);
  if (expected.length > MAX_PARTS) throw new TypeError(`config expects ${String(expected.length)} parts; run@1 records at most ${String(MAX_PARTS)}`);
  const expectedById = new Map(expected.map((k) => [partKeyString(k), k]));
  const validById = new Map<string, ValidPart[]>();
  const rejectedById = new Map<string, RejectedPart[]>();
  for (const [list, into] of [
    [input.valid, validById],
    [input.rejected, rejectedById],
  ] as const) {
    for (const part of list) {
      const id = partKeyString(part);
      if (expectedById.get(id)?.shard.count !== part.shard.count) throw new TypeError(`part ${id} is not one the config expects`);
      const group = (into as Map<string, (ValidPart | RejectedPart)[]>).get(id) ?? [];
      group.push(part);
      (into as Map<string, (ValidPart | RejectedPart)[]>).set(id, group);
    }
  }

  // Step 2: one part per key. Anything more is rejected as a whole.
  const reports = new Map<string, PartReport>();
  const candidates: ValidPart[] = [];
  for (const key of expected) {
    const id = partKeyString(key);
    const valid = validById.get(id) ?? [];
    const rejected = rejectedById.get(id) ?? [];
    if (valid.length + rejected.length === 0) {
      reports.set(id, { ...keyOf(key), status: "not-received", artifacts: [] });
    } else if (valid.length + rejected.length > 1) {
      const artifacts = [...valid.map((p) => p.artifact), ...rejected.flatMap((p) => p.artifacts)].sort(compareArtifacts);
      reports.set(id, {
        ...keyOf(key),
        status: "rejected",
        artifacts,
        diagnostic: { code: "part-duplicate", message: `${String(artifacts.length)} artifacts carry this part's name; none is chosen` },
      });
    } else if (rejected[0] !== undefined) {
      const part = rejected[0];
      reports.set(id, { ...keyOf(key), status: "rejected", artifacts: [...part.artifacts].sort(compareArtifacts), diagnostic: part.diagnostic });
    } else if (valid[0] !== undefined) {
      candidates.push(valid[0]);
    }
  }

  // Step 3: parts own disjoint unit keys per revision. Every part sharing a key is rejected.
  const owners = new Map<string, string[]>();
  for (const part of candidates) {
    for (const unit of part.units) {
      const id = `${part.revision}\u0000${unitId(part.providerId, unit.viewId, unit.variantId)}`;
      const list = owners.get(id) ?? [];
      list.push(partKeyString(part));
      owners.set(id, list);
    }
  }
  const shared = new Map<string, number>();
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    for (const id of list) shared.set(id, (shared.get(id) ?? 0) + 1);
  }
  const accepted: ValidPart[] = [];
  for (const part of candidates) {
    const id = partKeyString(part);
    const count = shared.get(id);
    if (count === undefined) {
      accepted.push(part);
      reports.set(id, { ...keyOf(part), status: "valid", artifacts: [part.artifact], unitCount: part.units.length, claims: part.claims });
    } else {
      reports.set(id, {
        ...keyOf(part),
        status: "rejected",
        artifacts: [part.artifact],
        diagnostic: { code: "part-conflict", message: `${String(count)} unit entries are also listed by another part of the same revision` },
      });
    }
  }

  // Steps 4–5: the declared set and each side.
  const notValid = new Set<string>();
  for (const report of reports.values()) if (report.status !== "valid") notValid.add(`${report.revision}\u0000${report.providerId}`);
  const listed = new Map<string, { key: UnitKey; base?: PartUnit; head?: PartUnit }>();
  for (const part of accepted) {
    for (const unit of part.units) {
      const id = unitId(part.providerId, unit.viewId, unit.variantId);
      const entry = listed.get(id) ?? { key: { providerId: part.providerId, viewId: unit.viewId, variantId: unit.variantId } };
      entry[part.revision] = unit;
      listed.set(id, entry);
    }
  }
  const sideOf = (revision: "base" | "head", key: UnitKey, unit: PartUnit | undefined): Side => {
    if (revision === "base" && input.baseline === "none") return { state: "none" };
    if (unit !== undefined) return unit.side;
    return { state: "missing", cause: notValid.has(`${revision}\u0000${key.providerId}`) ? "part-missing" : "unit-missing" };
  };
  const units: MergedUnit[] = [];
  const excluded: UnitKey[] = [];
  for (const { key, base, head } of listed.values()) {
    const b = sideOf("base", key, base);
    const h = sideOf("head", key, head);
    if (h.state === "absent" && (b.state === "absent" || b.state === "none")) {
      excluded.push(key);
      continue;
    }
    const details = {
      ...(base === undefined ? {} : { base: base.details }),
      ...(head === undefined ? {} : { head: head.details }),
    };
    units.push({ ...key, base: b, head: h, details });
  }
  if (units.length > INGEST_LIMITS.maxUnits) {
    throw new IngressError("ingest-too-many-units", `${String(units.length)} declared units; at most ${String(INGEST_LIMITS.maxUnits)} per ingestion`);
  }
  units.sort(compareUnitKeys);
  excluded.sort(compareUnitKeys);

  const parts = [...reports.values()].sort(comparePartKeys);
  const missingParts: MissingPart[] = parts
    .filter((p) => p.status !== "valid")
    .map((p) => ({ ...keyOf(p), reason: p.status === "not-received" ? "not-received" : "rejected" }));
  const accounted = units.filter((u) => u.base.state !== "missing" && u.head.state !== "missing").length;
  const status: Coverage["status"] =
    missingParts.length === 0 && accounted === units.length ? "complete-declared" : units.length === 0 ? "unknown" : "incomplete";
  const coverage: Coverage = { status, declaredUnits: units.length, accountedUnits: accounted, missingParts };
  const excludedSummary: Excluded = { count: excluded.length, sample: excluded.slice(0, MAX_EXCLUDED_SAMPLE) };
  return { units, coverage, parts, excluded: excludedSummary };
}

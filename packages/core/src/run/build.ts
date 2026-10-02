// Building run@1 (M1.5; 01 §§4.3–4.4; 02 §§4, 6, 8; ADR 0010). Pure: the trusted envelope, an
// Ingestion and the pixel comparisons go in; one validated, self-contained run comes out.
//
// - Identity, commits, association and every write target come from the envelope only. Capture
//   claims are copied under `claims` as untrusted data and never read for anything else.
// - The baseline comes from the envelope only (01 §4.4): no baseline commit means the ingestion
//   ran with baseline "none", every base side is `none`, and results are incomparable. Nothing here
//   can see the store, so no other run's images can stand in for a missing baseline.
// - Side states and coverage pass through from the ingestion unchanged; results are sorted by unit
//   key, so the run doesn't depend on the order parts, entries or comparisons arrived in.
import {
  type Claims,
  type Run,
  type RunResult,
  type SourceEnvelope,
  boundMessage,
  canonicalJson,
  compareUnitKeys,
  formatRunKey,
  validateDocument,
} from "@pixelwatch/schemas";
import type { Comparison } from "../comparator/compare.ts";
import { unitResult } from "../comparator/result.ts";
import type { Baseline, Ingestion, PartReport, UnitKey } from "../ingest/types.ts";

/** The baseline an ingestion must use for this envelope: only a corroborated baseline commit counts. */
export function baselineFor(envelope: SourceEnvelope): Baseline {
  return envelope.commits.base === undefined ? "none" : "expected";
}

/** The key `buildRun` looks comparisons up by. IDs never contain a NUL. */
export function unitKeyString(unit: UnitKey): string {
  return `${unit.providerId}\u0000${unit.viewId}\u0000${unit.variantId}`;
}

const CLAIM_FIELDS = ["revisionSha", "harnessSha", "environment"] as const;

/**
 * One side's claims: the fields every valid part of that side states identically. Parts that
 * disagree, or a part that is silent, drop the field; nothing is picked. Untrusted either way.
 */
function sideClaims(parts: readonly PartReport[]): Claims | undefined {
  if (parts.length === 0) return undefined;
  const claims: Record<string, unknown> = {};
  for (const field of CLAIM_FIELDS) {
    const values = parts.map((p) => p.claims?.[field]);
    const first = values[0];
    if (first === undefined) continue;
    const text = canonicalJson(first);
    if (values.every((v) => v !== undefined && canonicalJson(v) === text)) claims[field] = structuredClone(first);
  }
  return Object.keys(claims).length === 0 ? undefined : claims;
}

/** run@1 `parts`: every received part. A part sent under two artifacts records the lowest ID; its diagnostic says none was chosen. */
function runParts(reports: readonly PartReport[]): Run["parts"] {
  const parts: Run["parts"] = [];
  for (const report of reports) {
    if (report.status === "not-received") continue;
    const artifactId = report.artifacts[0]?.artifactId;
    if (artifactId === undefined) throw new Error("a received part has no artifact");
    const { revision, providerId, shard } = report;
    const entry: Run["parts"][number] = { revision, providerId, shard: { index: shard.index, count: shard.count }, status: report.status, artifactId };
    if (report.diagnostic !== undefined) {
      const diagnostic = boundMessage(`${report.diagnostic.code}: ${report.diagnostic.message}`);
      if (diagnostic !== undefined) entry.diagnostic = diagnostic;
    }
    parts.push(entry);
  }
  return parts;
}

/**
 * Builds the run for one authenticated source attempt. `comparisons` holds compareImages output
 * for exactly the units with two captured sides, keyed by `unitKeyString`. Throws if the inputs
 * don't belong together or the run fails run@1 validation; nothing is repaired.
 */
export function buildRun(
  envelope: SourceEnvelope,
  ingestion: Ingestion,
  comparisons: ReadonlyMap<string, Comparison>,
  versions: Run["versions"],
): Run {
  if (ingestion.attempt !== envelope.attempt) throw new Error("the ingestion is of another attempt than the envelope");
  const hasBaseline = baselineFor(envelope) === "expected";
  // ingestion.parts lists every expected part: head parts always, base parts exactly with a baseline.
  const expects = (revision: "base" | "head") => ingestion.parts.some((p) => p.revision === revision);
  if (expects("base") ? !hasBaseline : expects("head") && hasBaseline) {
    throw new Error("the ingestion's baseline doesn't match the envelope's baseline commit");
  }
  if (ingestion.units.some((u) => (u.base.state === "none") === hasBaseline)) {
    throw new Error("a base side doesn't match the envelope's baseline commit");
  }

  const units = [...ingestion.units].sort(compareUnitKeys);
  const used = new Set<string>();
  const results: RunResult[] = units.map((unit) => {
    const key = unitKeyString(unit);
    const comparison = comparisons.get(key);
    if (comparison !== undefined) used.add(key);
    const result = unitResult(unit, unit.base, unit.head, comparison);
    const labels = unit.details.head?.labels ?? unit.details.base?.labels;
    return labels === undefined ? result : { ...result, labels: structuredClone(labels) };
  });
  if (used.size !== comparisons.size) throw new Error("a comparison belongs to no unit of this ingestion");

  const counts: Run["counts"] = { missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: 0, subtle: 0, changed: 0 };
  for (const r of results) counts[r.status] += 1;

  const valid = (revision: "base" | "head") => ingestion.parts.filter((p) => p.status === "valid" && p.revision === revision);
  const base = sideClaims(valid("base"));
  const head = sideClaims(valid("head"));
  const run: Run = {
    schemaVersion: 1,
    runKey: formatRunKey(envelope.runId, envelope.attempt),
    source: structuredClone(envelope),
    claims: { ...(base === undefined ? {} : { base }), ...(head === undefined ? {} : { head }) },
    versions: { ...versions },
    parts: runParts(ingestion.parts),
    coverage: structuredClone(ingestion.coverage),
    counts,
    results,
  };
  const checked = validateDocument("run", run);
  if (!checked.ok) throw new Error(`the built run is invalid: ${checked.issue.message}`);
  return run;
}

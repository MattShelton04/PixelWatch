// The mechanical mapping from a recorded prototype comparison (PropertyScope report._compare at
// 6378d8be…) to comparator-v1's run@1 `Diff` (docs/adr/comparator-v1.md §Mapping). It renames
// and recomputes; it never re-implements the comparison. Used by expected.ts and by the tests
// that prove every recorded output fits run@1.
import { changedPpm } from "../../packages/schemas/src/semantic.ts";
import type { Analysis, Diff, Region } from "../../packages/schemas/src/generated/types.ts";

export interface PrototypeRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

export interface PrototypeAnalysis {
  threshold: number;
  changed: number;
  total: number;
  percent: number;
  bounds: PrototypeRegion | null;
  regions: PrototypeRegion[];
  regionCount: number;
}

export interface PrototypeComparison {
  change: "unchanged" | "subtle" | "changed";
  analyses: Record<string, PrototypeAnalysis>;
  review?: Record<string, unknown>;
}

export type PrototypeRecord = PrototypeComparison | { error: { type: string; message: string } };

/** comparator-v1 policy, confirmed against pixels.py (THRESHOLDS, SUBTLE_*, TILE, MAX_REGIONS). */
export const COMPARATOR_V1 = {
  thresholds: [0, 8, 16, 32],
  subtleMaxPixels: 128,
  subtleMaxDelta: 8,
  tile: 8,
  maxRegions: 12,
} as const;

/** comparator-v1 region order: pixels descending, then y, x, width, height ascending. */
export function compareRegions(a: Region, b: Region): number {
  return b.pixels - a.pixels || a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height;
}

function region(r: PrototypeRegion): Region {
  return { x: r.x, y: r.y, width: r.width, height: r.height, pixels: r.pixels };
}

export function isComparison(record: PrototypeRecord): record is PrototypeComparison {
  return !("error" in record);
}

/**
 * Maps one recorded comparison. The analysis `threshold` comes from its key: the prototype reuses
 * the t0 dict (threshold 0) for every threshold when nothing changed. `changedPpm` is recomputed
 * from integers; the prototype's rounded float `percent` is not used.
 */
export function toDiff(record: PrototypeComparison): Diff {
  const first = record.analyses["0"];
  if (first === undefined) throw new Error("recording has no threshold-0 analysis");
  const totalPixels = first.total;
  const analyses: Analysis[] = COMPARATOR_V1.thresholds.map((threshold) => {
    const a = record.analyses[String(threshold)];
    if (a === undefined) throw new Error(`recording has no threshold-${String(threshold)} analysis`);
    if (a.total !== totalPixels) throw new Error("analyses disagree on the pixel total");
    return {
      threshold,
      changedPixels: a.changed,
      changedPpm: changedPpm(a.changed, totalPixels),
      ...(a.bounds ? { bounds: region(a.bounds) } : {}),
      regions: a.regions.map(region).sort(compareRegions),
      regionCount: a.regionCount,
    };
  });
  return { totalPixels, analyses };
}

/** True when the v1 region order differs from the recorded prototype order (not allowed in v1). */
export function regionsReordered(record: PrototypeComparison): boolean {
  return Object.values(record.analyses).some((a) => {
    const sorted = a.regions.map(region).sort(compareRegions);
    return sorted.some((r, i) => compareRegions(r, region(a.regions[i] as PrototypeRegion)) !== 0);
  });
}

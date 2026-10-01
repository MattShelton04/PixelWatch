// Comparator policy as data (02 §9). config@1 carries only `comparator.version`, so the version
// fixes the policy. comparator-v1 is PropertyScope's pixels.py at 6378d8be… (THRESHOLDS,
// SUBTLE_*, TILE, MAX_REGIONS; docs/adr/comparator-v1.md). A different policy is a new version.
import type { Region } from "@pixelwatch/schemas";

export interface ComparatorPolicy {
  /** A pixel changes at threshold t when its largest RGBA channel delta is > t. Ascending; first 0. */
  readonly thresholds: readonly number[];
  /** subtle: at most this many changed pixels at threshold 0 … */
  readonly subtleMaxPixels: number;
  /** … and none at this threshold (one of `thresholds`). */
  readonly subtleMaxDelta: number;
  /** Region tile size in pixels, anchored at (0, 0). */
  readonly tile: number;
  /** Regions kept per analysis; `regionCount` is the total. */
  readonly maxRegions: number;
}

export const COMPARATOR_V1: ComparatorPolicy = Object.freeze({
  thresholds: Object.freeze([0, 8, 16, 32]),
  subtleMaxPixels: 128,
  subtleMaxDelta: 8,
  tile: 8,
  maxRegions: 12,
});

/** The policy for a stored comparator version. Unknown versions are refused (R4.2-05). */
export function comparatorPolicy(version: number): ComparatorPolicy {
  if (version === 1) return COMPARATOR_V1;
  throw new RangeError(`unknown comparator version ${String(version)}`);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/**
 * Throws a RangeError unless `policy` fits run@1 and keeps `unchanged` exact: the first threshold
 * must be 0, so `unchanged` means no channel moved at all (equal pixel hash for equal sizes).
 */
export function checkPolicy(policy: ComparatorPolicy): void {
  const { thresholds } = policy;
  if (!Array.isArray(thresholds) || thresholds.length < 1 || thresholds.length > 8) {
    throw new RangeError("thresholds must list 1–8 values");
  }
  if (thresholds[0] !== 0) throw new RangeError("the first threshold must be 0");
  for (let i = 0; i < thresholds.length; i++) {
    if (!isInt(thresholds[i], 0, 254)) throw new RangeError("thresholds must be integers 0–254");
    if (i > 0 && (thresholds[i] as number) <= (thresholds[i - 1] as number)) throw new RangeError("thresholds must strictly increase");
  }
  if (!thresholds.includes(policy.subtleMaxDelta)) throw new RangeError("subtleMaxDelta must be one of the thresholds");
  if (!isInt(policy.subtleMaxPixels, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError("subtleMaxPixels must be a non-negative integer");
  if (!isInt(policy.tile, 1, 256)) throw new RangeError("tile must be an integer 1–256");
  if (!isInt(policy.maxRegions, 0, 12)) throw new RangeError("maxRegions must be an integer 0–12");
}

/** comparator-v1 region order: pixels descending, then y, x, width, height ascending. */
export function compareRegions(a: Region, b: Region): number {
  return b.pixels - a.pixels || a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height;
}

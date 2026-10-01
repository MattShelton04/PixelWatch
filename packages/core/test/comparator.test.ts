// comparator-v1 boundaries, properties and side-state precedence (M1.3; 02 §4, §9; 07 §2). Parity
// with the recorded prototype is in comparator-goldens.test.ts. Here, a literal port of pixels.py
// (full delta, full masks, set-based tile BFS, window boxes) is the oracle for the streaming
// implementation, which never materializes a delta or mask.
import type { Analysis, Diff, Region, RunResult, Side } from "@pixelwatch/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Comparison, compareImages } from "../src/comparator/compare.ts";
import { COMPARATOR_V1, type ComparatorPolicy, checkPolicy, comparatorPolicy, compareRegions } from "../src/comparator/policy.ts";
import { sideResult, unitResult } from "../src/comparator/result.ts";
import { type RawPixels, normalizeRgba, pixelHash } from "../src/pixel-hash.ts";
import { PngWorker } from "../src/png/isolated.ts";

type Rgba = [number, number, number, number];
const GREY: Rgba = [128, 128, 128, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
const STRONG: Rgba = [168, 128, 128, 255];

function image(width: number, height: number, fill: Rgba = GREY, pixels: [number, number, Rgba][] = []): RawPixels {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  for (const [x, y, rgba] of pixels) data.set(rgba, (y * width + x) * 4);
  return { width, height, channels: 4, data };
}

const identity = { providerId: "p", viewId: "v", variantId: "desktop" };

function capturedSide(img: RawPixels): Side {
  return { state: "captured", pixelHash: pixelHash(img), width: img.width, height: img.height };
}

function counts(c: Comparison): number[] | undefined {
  return c.diff?.analyses.map((a) => a.changedPixels);
}

function zeroAnalyses(policy: ComparatorPolicy = COMPARATOR_V1): Analysis[] {
  return policy.thresholds.map((threshold) => ({ threshold, changedPixels: 0, changedPpm: 0, regions: [], regionCount: 0 }));
}

// ---------------------------------------------------------------------------------------------
// Oracle: pixels.py at 6378d8be… transcribed literally (align, channel_delta, analyse, _regions,
// classify), on the alpha-normalized input (D1) and with D2 for widths.

function oracle(base: RawPixels, head: RawPixels, policy: ComparatorPolicy): Comparison {
  if (base.width !== head.width) return { status: "changed", reasons: ["dimensions"] };
  const width = base.width;
  const height = Math.max(base.height, head.height);
  const pad = (img: RawPixels) => {
    const out = new Uint8Array(width * height * 4);
    out.set(normalizeRgba(img));
    return out;
  };
  const b = pad(base);
  const h = pad(head);
  const delta = new Uint8Array(width * height);
  for (let i = 0; i < delta.length; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs((b[i * 4 + c] as number) - (h[i * 4 + c] as number)));
    delta[i] = d;
  }
  const analyses = policy.thresholds.map((threshold): Analysis => {
    const mask = Array.from(delta, (d) => d > threshold);
    const changed = mask.filter(Boolean).length;
    const total = width * height;
    const analysis: Analysis = { threshold, changedPixels: changed, changedPpm: Math.floor((changed * 2_000_000 + total) / (2 * total)), regions: [], regionCount: 0 };
    if (changed === 0) return analysis;
    analysis.bounds = { ...boxOf(mask, width, 0, 0, width - 1, height - 1), pixels: changed };
    const [regions, count] = oracleRegions(mask, width, height, policy);
    analysis.regions = regions;
    analysis.regionCount = count;
    return analysis;
  });
  const diff: Diff = { totalPixels: width * height, analyses };
  const at = (t: number) => analyses[policy.thresholds.indexOf(t)]?.changedPixels ?? 0;
  if (base.height !== head.height) return { status: "changed", reasons: ["dimensions"], diff };
  if (at(0) === 0) return { status: "unchanged", reasons: [], diff };
  if (at(0) <= policy.subtleMaxPixels && at(policy.subtleMaxDelta) === 0) return { status: "subtle", reasons: ["pixels"], diff };
  return { status: "changed", reasons: ["pixels"], diff };
}

/** Box of the true mask cells within [x0..x1] × [y0..y1] (inclusive), clipped to the canvas. */
function boxOf(mask: boolean[], width: number, x0: number, y0: number, x1: number, y1: number): Omit<Region, "pixels"> {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -1, -1];
  const height = mask.length / width;
  for (let y = y0; y <= Math.min(y1, height - 1); y++) {
    for (let x = x0; x <= Math.min(x1, width - 1); x++) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function oracleRegions(mask: boolean[], width: number, height: number, policy: ComparatorPolicy): [Region[], number] {
  const { tile } = policy;
  const rows = Math.ceil(height / tile);
  const columns = Math.ceil(width / tile);
  const tileCounts = new Map<string, number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const key = `${String(Math.floor(y / tile))},${String(Math.floor(x / tile))}`;
      tileCounts.set(key, (tileCounts.get(key) ?? 0) + 1);
    }
  }
  const remaining = new Set(tileCounts.keys());
  const regions: Region[] = [];
  for (const start of tileCounts.keys()) {
    if (!remaining.delete(start)) continue;
    const queue = [start];
    let [top, left, bottom, right, pixels] = [Infinity, Infinity, -1, -1, 0];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      const [row, column] = key.split(",").map(Number) as [number, number];
      pixels += tileCounts.get(key) ?? 0;
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
      left = Math.min(left, column);
      right = Math.max(right, column);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const next = `${String(row + dr)},${String(column + dc)}`;
          if (row + dr >= 0 && row + dr < rows && column + dc >= 0 && column + dc < columns && remaining.delete(next)) queue.push(next);
        }
      }
    }
    // The prototype's window: every changed pixel in the component's tile rectangle.
    regions.push({ ...boxOf(mask, width, left * tile, top * tile, (right + 1) * tile - 1, (bottom + 1) * tile - 1), pixels });
  }
  regions.sort(compareRegions);
  return [regions.slice(0, policy.maxRegions), regions.length];
}

// ---------------------------------------------------------------------------------------------

describe("compareImages: boundaries", () => {
  it("finds nothing on identical images: no bounds, empty regions at every threshold", () => {
    expect(compareImages(image(4, 4), image(4, 4), COMPARATOR_V1)).toEqual({
      status: "unchanged",
      reasons: [],
      diff: { totalPixels: 16, analyses: zeroAnalyses() },
    });
  });

  it("counts a pixel only when its largest channel delta is strictly above each threshold", () => {
    for (const t of COMPARATOR_V1.thresholds) {
      for (const d of [t, t + 1].filter((v) => v > 0)) {
        const expected = COMPARATOR_V1.thresholds.map((u) => (d > u ? 1 : 0));
        for (const channel of [0, 1, 2, 3]) {
          for (const sign of [1, -1]) {
            const changed: Rgba = [...GREY];
            changed[channel] = (changed[channel] as number) + (channel === 3 ? -d : sign * d);
            const result = compareImages(image(4, 4), image(4, 4, GREY, [[1, 2, changed]]), COMPARATOR_V1);
            expect(counts(result), `Δ${String(d)} on channel ${String(channel)}`).toEqual(expected);
          }
        }
      }
    }
  });

  it("takes the largest channel delta, not a sum", () => {
    const result = compareImages(image(4, 4), image(4, 4, GREY, [[0, 3, [131, 137, 126, 255]]]), COMPARATOR_V1);
    expect(counts(result)).toEqual([1, 1, 0, 0]);
  });

  it("calls ≤ 128 pixels with nothing above Δ8 subtle, and anything more changed", () => {
    const many = (n: number, d: number) => image(16, 16, GREY, Array.from({ length: n }, (_, i) => [i % 16, Math.floor(i / 16), [128 + d, 128, 128, 255]] as [number, number, Rgba]));
    expect(compareImages(image(16, 16), many(128, 8), COMPARATOR_V1)).toMatchObject({ status: "subtle", reasons: ["pixels"] });
    expect(compareImages(image(16, 16), many(129, 1), COMPARATOR_V1)).toMatchObject({ status: "changed", reasons: ["pixels"] });
    expect(compareImages(image(16, 16), many(1, 9), COMPARATOR_V1)).toMatchObject({ status: "changed", reasons: ["pixels"] });
    expect(compareImages(image(16, 16), many(1, 1), COMPARATOR_V1)).toMatchObject({ status: "subtle", reasons: ["pixels"] });
  });

  it("calls a height-only change changed/dimensions and counts visible padded rows", () => {
    const grow = compareImages(image(4, 4), image(4, 5), COMPARATOR_V1);
    const row = { x: 0, y: 4, width: 4, height: 1, pixels: 4 };
    expect(grow).toEqual({
      status: "changed",
      reasons: ["dimensions"],
      diff: { totalPixels: 20, analyses: COMPARATOR_V1.thresholds.map((threshold) => ({ threshold, changedPixels: 4, changedPpm: 200_000, bounds: row, regions: [row], regionCount: 1 })) },
    });
    expect(compareImages(image(4, 5), image(4, 4), COMPARATOR_V1)).toEqual(grow);
  });

  it("calls transparent growth changed/dimensions with no changed pixel, even with hidden RGB", () => {
    const head = image(4, 5, GREY, [0, 1, 2, 3].map((x) => [x, 4, [9, 9, 9, 0]] as [number, number, Rgba]));
    expect(compareImages(image(4, 4), head, COMPARATOR_V1)).toEqual({ status: "changed", reasons: ["dimensions"], diff: { totalPixels: 20, analyses: zeroAnalyses() } });
  });

  it("calls all-alpha-0 images unchanged whatever their hidden RGB", () => {
    const base = image(3, 2, [10, 20, 30, 0]);
    const head = image(3, 2, [200, 100, 50, 0]);
    const result = compareImages(base, head, COMPARATOR_V1);
    expect(result).toEqual({ status: "unchanged", reasons: [], diff: { totalPixels: 6, analyses: zeroAnalyses() } });
    expect(unitResult(identity, capturedSide(base), capturedSide(head), result).status).toBe("unchanged");
  });

  it("calls a width change changed/dimensions with no diff", () => {
    expect(compareImages(image(4, 4), image(5, 4), COMPARATOR_V1)).toStrictEqual({ status: "changed", reasons: ["dimensions"] });
  });

  it("handles 1×1 images and tiles clipped at the right and bottom edges", () => {
    expect(counts(compareImages(image(1, 1, [0, 0, 0, 255]), image(1, 1, [255, 0, 0, 255]), COMPARATOR_V1))).toEqual([1, 1, 1, 1]);
    const result = compareImages(image(10, 9), image(10, 9, GREY, [[9, 8, STRONG], [7, 7, STRONG]]), COMPARATOR_V1);
    expect(result.diff?.analyses[0]?.regions).toEqual([{ x: 7, y: 7, width: 3, height: 2, pixels: 2 }]);
  });

  it("orders regions by pixels, then y, x, width and height", () => {
    // Two 7-pixel regions whose boxes both start at (0, 0); the narrower one sorts first.
    const a: [number, number][] = [[0, 0], [8, 0], [0, 8], [1, 1], [2, 2], [9, 9], [10, 10]];
    const b: [number, number][] = [[24, 0], [24, 8], [24, 16], [24, 24], [16, 24], [8, 24], [0, 24]];
    const head = image(32, 32, GREY, [...a, ...b].map(([x, y]) => [x, y, STRONG] as [number, number, Rgba]));
    expect(compareImages(image(32, 32), head, COMPARATOR_V1).diff?.analyses[0]?.regions).toEqual([
      { x: 0, y: 0, width: 11, height: 11, pixels: 7 },
      { x: 0, y: 0, width: 25, height: 25, pixels: 7 },
    ]);
    const r = { x: 0, y: 0, width: 5, pixels: 3 };
    expect([{ ...r, height: 9 }, { ...r, height: 2 }].sort(compareRegions).map((x) => x.height)).toEqual([2, 9]);
  });

  it("keeps the 12 largest of more than 12 regions and counts them all", () => {
    const pixels: [number, number, Rgba][] = [];
    for (let n = 0; n < 16; n++) for (let k = 0; k <= n % 4; k++) pixels.push([(n % 4) * 16 + 1 + k, Math.floor(n / 4) * 16 + 1, STRONG]);
    const t0 = compareImages(image(64, 64), image(64, 64, GREY, pixels), COMPARATOR_V1).diff?.analyses[0];
    expect(t0?.regionCount).toBe(16);
    expect(t0?.regions).toHaveLength(12);
    expect(t0?.regions?.map((r) => r.pixels)).toEqual([4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2]);
    expect(t0?.regions?.slice(0, 4).map((r) => r.y)).toEqual([1, 17, 33, 49]);
  });

  it("boxes a region over every changed pixel in its tile rectangle (prototype window)", () => {
    // Recorded from the pinned prototype as tiny case `region-window`: A's box takes in B's pixel.
    const a: [number, number][] = [[0, 0], [1, 1], [2, 2], [2, 3], [2, 4], [1, 5], [0, 6]];
    const head = image(64, 32, GREY, [...a.map(([r, c]) => [c * 8 + 3, r * 8 + 7, STRONG] as [number, number, Rgba]), [27, 0, STRONG]]);
    expect(compareImages(image(64, 32), head, COMPARATOR_V1).diff?.analyses[0]).toMatchObject({
      regions: [{ x: 3, y: 0, width: 49, height: 24, pixels: 7 }, { x: 27, y: 0, width: 1, height: 1, pixels: 1 }],
      regionCount: 2,
    });
  });

  it("applies a policy given as data", () => {
    const policy: ComparatorPolicy = { thresholds: [0, 4], subtleMaxPixels: 2, subtleMaxDelta: 4, tile: 4, maxRegions: 1 };
    const head = image(12, 12, GREY, [[0, 0, [131, 128, 128, 255]], [11, 11, [131, 128, 128, 255]]]);
    const result = compareImages(image(12, 12), head, policy);
    expect(result.status).toBe("subtle");
    expect(result.diff?.analyses.map((a) => [a.threshold, a.changedPixels, a.regionCount, a.regions?.length])).toEqual([[0, 2, 2, 1], [4, 0, 0, 0]]);
    expect(result).toEqual(oracle(image(12, 12), head, policy));
  });
});

describe("comparator policy", () => {
  it("refuses an unknown comparator version", () => {
    expect(comparatorPolicy(1)).toBe(COMPARATOR_V1);
    for (const version of [0, 2, 1.5, Number.NaN]) expect(() => comparatorPolicy(version)).toThrow(RangeError);
  });

  it("refuses a policy that could hide a change or break run@1", () => {
    const bad: Partial<ComparatorPolicy>[] = [
      { thresholds: [8, 16] }, // first threshold must be 0: otherwise different pixels could be "unchanged"
      { thresholds: [] },
      { thresholds: [0, 16, 8] },
      { thresholds: [0, 8, 8] },
      { thresholds: [0, 255] },
      { thresholds: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
      { thresholds: [0, 2.5] },
      { subtleMaxDelta: 9 },
      { subtleMaxPixels: -1 },
      { tile: 0 },
      { tile: 257 },
      { maxRegions: 13 },
    ];
    for (const override of bad) {
      expect(() => {
        checkPolicy({ ...COMPARATOR_V1, ...override });
      }, JSON.stringify(override)).toThrow(RangeError);
      expect(() => compareImages(image(2, 2), image(2, 2), { ...COMPARATOR_V1, ...override })).toThrow(RangeError);
    }
    expect(() => {
      checkPolicy(COMPARATOR_V1);
    }).not.toThrow();
  });

  it("refuses malformed pixel buffers", () => {
    expect(() => compareImages({ width: 2, height: 2, channels: 4, data: new Uint8Array(15) }, image(2, 2), COMPARATOR_V1)).toThrow(RangeError);
    expect(() => compareImages(image(2, 2), { width: 0, height: 2, channels: 4, data: new Uint8Array(0) }, COMPARATOR_V1)).toThrow(RangeError);
  });
});

describe("compareImages: properties", () => {
  const palette: Rgba[] = [GREY, STRONG, CLEAR, [128, 128, 128, 0], [136, 128, 128, 255], [137, 128, 128, 255], [128, 128, 128, 247], [0, 0, 0, 1], [161, 128, 128, 255]];
  const colour = fc.constantFrom(...palette);
  /** Small images sharing a width, painted from a palette that hits every threshold edge. */
  const pair = fc
    .record({ width: fc.integer({ min: 1, max: 40 }), baseHeight: fc.integer({ min: 1, max: 40 }), headHeight: fc.integer({ min: 1, max: 40 }), sameHeight: fc.boolean() })
    .chain(({ width, baseHeight, headHeight, sameHeight }) => {
      const hh = sameHeight ? baseHeight : headHeight;
      const edits = (w: number, h: number) => fc.array(fc.tuple(fc.nat(w - 1), fc.nat(h - 1), colour), { maxLength: 60 });
      return fc.record({ fill: colour, headFill: fc.oneof(fc.constant(undefined), colour), base: edits(width, baseHeight), head: edits(width, hh) }).map((p) => ({
        base: image(width, baseHeight, p.fill, p.base),
        head: image(width, hh, p.headFill ?? p.fill, p.head),
      }));
    });

  it("equals a literal port of the prototype on random images, including height changes", () => {
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        expect(compareImages(base, head, COMPARATOR_V1)).toEqual(oracle(base, head, COMPARATOR_V1));
      }),
      { numRuns: 300 },
    );
  });

  it("equals the oracle with a small tile and few kept regions", () => {
    const policy: ComparatorPolicy = { thresholds: [0, 8, 32], subtleMaxPixels: 3, subtleMaxDelta: 8, tile: 3, maxRegions: 2 };
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        expect(compareImages(base, head, policy)).toEqual(oracle(base, head, policy));
      }),
      { numRuns: 200 },
    );
  });

  it("is unchanged exactly when same-size pixel hashes are equal", () => {
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        if (base.height !== head.height) return;
        expect(compareImages(base, head, COMPARATOR_V1).status === "unchanged").toBe(pixelHash(base) === pixelHash(head));
      }),
      { numRuns: 300 },
    );
  });

  it("gives the same diff with base and head swapped", () => {
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        expect(compareImages(head, base, COMPARATOR_V1)).toEqual(compareImages(base, head, COMPARATOR_V1));
      }),
    );
  });

  it("never counts more pixels at a higher threshold, and its regions add up", () => {
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        const { diff } = compareImages(base, head, COMPARATOR_V1);
        if (diff === undefined) return;
        for (let i = 1; i < diff.analyses.length; i++) expect(diff.analyses[i]?.changedPixels).toBeLessThanOrEqual(diff.analyses[i - 1]?.changedPixels ?? 0);
        for (const a of diff.analyses) {
          const regions = a.regions ?? [];
          if ((a.regionCount ?? 0) <= COMPARATOR_V1.maxRegions) expect(regions.reduce((s, r) => s + r.pixels, 0)).toBe(a.changedPixels);
          for (const r of regions) {
            expect(r.x).toBeGreaterThanOrEqual(a.bounds?.x ?? Infinity);
            expect(r.y).toBeGreaterThanOrEqual(a.bounds?.y ?? Infinity);
            expect(r.x + r.width).toBeLessThanOrEqual((a.bounds?.x ?? 0) + (a.bounds?.width ?? 0));
            expect(r.y + r.height).toBeLessThanOrEqual((a.bounds?.y ?? 0) + (a.bounds?.height ?? 0));
          }
        }
      }),
    );
  });

  it("treats RGB input as RGBA with alpha 255", () => {
    fc.assert(
      fc.property(pair, ({ base, head }) => {
        const rgb = (img: RawPixels): RawPixels => {
          const data = new Uint8Array(img.width * img.height * 3);
          for (let i = 0; i < img.width * img.height; i++) data.set(img.data.subarray(i * 4, i * 4 + 3), i * 3);
          return { width: img.width, height: img.height, channels: 3, data };
        };
        const opaque = (img: RawPixels): RawPixels => {
          const data = Uint8Array.from(img.data);
          for (let i = 3; i < data.length; i += 4) data[i] = 255;
          return { ...img, data };
        };
        expect(compareImages(rgb(base), rgb(head), COMPARATOR_V1)).toEqual(compareImages(opaque(base), opaque(head), COMPARATOR_V1));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Side states (02 §4, ADR 0003): decided before, and independently of, any pixel comparison.

const SIDES = {
  captured: { state: "captured", pixelHash: "a".repeat(64), width: 4, height: 4 },
  absent: { state: "absent", reason: "not-in-revision-catalog" },
  failed: { state: "failed", category: "capture-error" },
  "missing-unit": { state: "missing", cause: "unit-missing" },
  "missing-part": { state: "missing", cause: "part-missing" },
  none: { state: "none" },
} satisfies Record<string, Side>;
const OTHER_CAPTURED: Side = { state: "captured", pixelHash: "b".repeat(64), width: 4, height: 4 };
const UNCHANGED: Comparison = { status: "unchanged", reasons: [], diff: { totalPixels: 16, analyses: zeroAnalyses() } };

/** Every valid (base, head) pair except two captured sides. */
function sideStatePairs(): [string, Side, string, Side][] {
  const pairs: [string, Side, string, Side][] = [];
  for (const [bn, b] of Object.entries(SIDES)) {
    for (const [hn, h] of Object.entries(SIDES)) {
      if (hn === "none" || (bn === "captured" && hn === "captured")) continue;
      if (b.state === "absent" && h.state === "absent") continue;
      if (b.state === "none" && h.state === "absent") continue;
      pairs.push([bn, b, hn, h]);
    }
  }
  return pairs;
}

describe("side states", () => {
  it("decides every non-captured unit by 02 §4 precedence", () => {
    const table = Object.fromEntries(sideStatePairs().map(([bn, b, hn, h]) => [`${bn}/${hn}`, sideResult(b, h)]));
    expect(table).toEqual({
      "captured/absent": { status: "removed", reasons: [] },
      "captured/failed": { status: "failed", reasons: ["capture-failed"] },
      "captured/missing-unit": { status: "missing", reasons: ["unit-missing"] },
      "captured/missing-part": { status: "missing", reasons: ["part-missing"] },
      "absent/captured": { status: "added", reasons: [] },
      "absent/failed": { status: "failed", reasons: ["capture-failed"] },
      "absent/missing-unit": { status: "missing", reasons: ["unit-missing"] },
      "absent/missing-part": { status: "missing", reasons: ["part-missing"] },
      "failed/captured": { status: "failed", reasons: ["capture-failed"] },
      "failed/absent": { status: "failed", reasons: ["capture-failed"] },
      "failed/failed": { status: "failed", reasons: ["capture-failed"] },
      "failed/missing-unit": { status: "missing", reasons: ["unit-missing"] },
      "failed/missing-part": { status: "missing", reasons: ["part-missing"] },
      "missing-unit/captured": { status: "missing", reasons: ["unit-missing"] },
      "missing-unit/absent": { status: "missing", reasons: ["unit-missing"] },
      "missing-unit/failed": { status: "missing", reasons: ["unit-missing"] },
      "missing-unit/missing-unit": { status: "missing", reasons: ["unit-missing"] },
      "missing-unit/missing-part": { status: "missing", reasons: ["part-missing", "unit-missing"] },
      "missing-part/captured": { status: "missing", reasons: ["part-missing"] },
      "missing-part/absent": { status: "missing", reasons: ["part-missing"] },
      "missing-part/failed": { status: "missing", reasons: ["part-missing"] },
      "missing-part/missing-unit": { status: "missing", reasons: ["part-missing", "unit-missing"] },
      "missing-part/missing-part": { status: "missing", reasons: ["part-missing"] },
      "none/captured": { status: "incomparable", reasons: ["no-baseline"] },
      "none/failed": { status: "failed", reasons: ["capture-failed", "no-baseline"] },
      "none/missing-unit": { status: "missing", reasons: ["unit-missing", "no-baseline"] },
      "none/missing-part": { status: "missing", reasons: ["part-missing", "no-baseline"] },
    });
    expect(sideResult(SIDES.captured, OTHER_CAPTURED)).toBeUndefined();
  });

  it("never turns a missing or failed side into unchanged, under any policy", () => {
    const policies: ComparatorPolicy[] = [COMPARATOR_V1, { thresholds: [0, 254], subtleMaxPixels: Number.MAX_SAFE_INTEGER, subtleMaxDelta: 254, tile: 256, maxRegions: 0 }];
    for (const policy of policies) {
      checkPolicy(policy);
      for (const [bn, b, hn, h] of sideStatePairs()) {
        if (![b.state, h.state].some((s) => s === "missing" || s === "failed")) continue;
        const result = unitResult(identity, b, h);
        expect(["missing", "failed"], `${bn}/${hn}`).toContain(result.status);
        expect(result.diff).toBeUndefined();
        // Pixels can't vote: even an "unchanged" comparison is refused for such a unit.
        expect(() => unitResult(identity, b, h, UNCHANGED), `${bn}/${hn}`).toThrow();
      }
    }
  });

  it("refuses pixel results for a unit whose sides aren't both captured", () => {
    for (const [bn, b, hn, h] of sideStatePairs()) {
      expect(() => unitResult(identity, b, h, UNCHANGED), `${bn}/${hn}`).toThrow(/both sides captured/);
    }
    expect(() => unitResult(identity, SIDES.captured, OTHER_CAPTURED)).toThrow(/needs a pixel comparison/);
  });

  it("compares a none base never: incomparable with no-baseline whatever the head", () => {
    const none: Side = SIDES.none;
    for (const [hn, h] of Object.entries(SIDES)) {
      if (hn === "none" || hn === "absent") {
        expect(() => sideResult(none, h), hn).toThrow();
        continue;
      }
      const result = unitResult(identity, none, h);
      expect(result.reasons, hn).toContain("no-baseline");
      expect(result.diff).toBeUndefined();
      if (h.state === "captured") expect(result.status).toBe("incomparable");
      expect(() => unitResult(identity, none, h, UNCHANGED), hn).toThrow();
    }
  });

  it("rejects pairs that aren't units", () => {
    const { captured, absent, none } = SIDES;
    expect(() => sideResult(captured, none)).toThrow(/head/);
    expect(() => sideResult(absent, absent)).toThrow(/absent/);
    expect(() => sideResult(none, absent)).toThrow(/absent/);
  });

  it("refuses a comparison that disagrees with the pixel hashes", () => {
    const base = image(4, 4);
    const head = image(4, 4, GREY, [[0, 0, STRONG]]);
    const changed = compareImages(base, head, COMPARATOR_V1);
    expect(() => unitResult(identity, capturedSide(base), capturedSide(head), UNCHANGED)).toThrow(/unchanged/);
    expect(() => unitResult(identity, capturedSide(base), capturedSide(base), changed)).toThrow();
    const ok: RunResult = unitResult(identity, capturedSide(base), capturedSide(head), changed);
    expect(Object.keys(ok)).toEqual(["providerId", "viewId", "variantId", "status", "reasons", "diff", "base", "head"]);
  });
});

describe("PngWorker compare", () => {
  it("returns the in-process result", async () => {
    const worker = new PngWorker();
    try {
      const base = image(40, 30);
      const head = image(40, 33, GREY, [[3, 4, STRONG], [39, 29, [128, 128, 128, 250]]]);
      expect(await worker.compare(base, head, COMPARATOR_V1)).toEqual(compareImages(base, head, COMPARATOR_V1));
      await expect(worker.compare(base, head, { ...COMPARATOR_V1, tile: 0 })).rejects.toThrow();
    } finally {
      await worker.close();
    }
  });
});

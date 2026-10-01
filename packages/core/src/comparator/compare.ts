// comparator-v1 pixel comparison (docs/adr/comparator-v1.md §Algorithm), ported from PropertyScope's
// pixels.py at 6378d8be… (align, channel_delta, analyse, _regions, classify).
//
// One streaming pass, no image-sized intermediate: rows are alpha-normalized in chunks by the pixel
// hash's own normalizer (D1), the shorter image is padded with (0,0,0,0) rows, and each pixel's
// largest RGBA channel delta updates per-tile statistics for every threshold it exceeds. Regions,
// bounds and counts are exact functions of those statistics. Beyond the two decoded inputs, memory
// is 8 bytes per tile per threshold (≈ 8 MB for v1 at 16,000,000 pixels) plus two row chunks.
import { type Analysis, type Diff, type Reason, type Region, changedPpm } from "@pixelwatch/schemas";
import { type RawPixels, checkPixels, normalizeRgbaRows } from "../pixel-hash.ts";
import { type ComparatorPolicy, checkPolicy, compareRegions } from "./policy.ts";

/** The pixel verdict for two captured sides. Side states are decided separately (result.ts). */
export interface Comparison {
  readonly status: "unchanged" | "subtle" | "changed";
  readonly reasons: Reason[];
  /** Absent only when the widths differ (D2). */
  readonly diff?: Diff;
}

const ROWS_PER_CHUNK = 64;

/** Changed-pixel statistics per (threshold, tile). Coordinates are tile-local (tile ≤ 256). */
interface TileStats {
  readonly tiles: number;
  readonly count: Uint32Array;
  readonly minX: Uint8Array;
  readonly minY: Uint8Array;
  readonly maxX: Uint8Array;
  readonly maxY: Uint8Array;
}

/** Normalized rows [from, to) of `image`, with (0,0,0,0) for rows past its height. */
function paddedRows(image: RawPixels, from: number, to: number, width: number): Uint8Array {
  if (to <= image.height) return normalizeRgbaRows(image, from, to);
  const out = new Uint8Array((to - from) * width * 4);
  if (from < image.height) out.set(normalizeRgbaRows(image, from, image.height));
  return out;
}

function collect(base: RawPixels, head: RawPixels, policy: ComparatorPolicy, height: number, columns: number, rows: number): TileStats {
  const { width } = base;
  const { tile } = policy;
  const thresholds = Int32Array.from(policy.thresholds);
  const levels = thresholds.length;
  const tiles = columns * rows;
  const stats: TileStats = {
    tiles,
    count: new Uint32Array(levels * tiles),
    minX: new Uint8Array(levels * tiles).fill(255),
    minY: new Uint8Array(levels * tiles).fill(255),
    maxX: new Uint8Array(levels * tiles),
    maxY: new Uint8Array(levels * tiles),
  };
  const { count, minX, minY, maxX, maxY } = stats;
  const tileColumn = new Int32Array(width);
  const localX = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    tileColumn[x] = Math.floor(x / tile);
    localX[x] = x % tile;
  }
  for (let from = 0; from < height; from += ROWS_PER_CHUNK) {
    const to = Math.min(height, from + ROWS_PER_CHUNK);
    const b = paddedRows(base, from, to, width);
    const h = paddedRows(head, from, to, width);
    for (let y = from; y < to; y++) {
      const tileRow = Math.floor(y / tile);
      const ly = y % tile;
      const rowStart = tileRow * columns;
      let i = (y - from) * width * 4;
      for (let x = 0; x < width; x++, i += 4) {
        const d = Math.max(
          Math.abs((b[i] as number) - (h[i] as number)),
          Math.abs((b[i + 1] as number) - (h[i + 1] as number)),
          Math.abs((b[i + 2] as number) - (h[i + 2] as number)),
          Math.abs((b[i + 3] as number) - (h[i + 3] as number)),
        );
        // thresholds[0] is 0 (checkPolicy), so d = 0 changes nothing at any threshold.
        if (d === 0) continue;
        const lx = localX[x] as number;
        let at = rowStart + (tileColumn[x] as number);
        for (let k = 0; k < levels && d > (thresholds[k] as number); k++, at += tiles) {
          count[at] = (count[at] as number) + 1;
          if (lx < (minX[at] as number)) minX[at] = lx;
          if (lx > (maxX[at] as number)) maxX[at] = lx;
          if (ly < (minY[at] as number)) minY[at] = ly;
          if (ly > (maxY[at] as number)) maxY[at] = ly;
        }
      }
    }
  }
  return stats;
}

/** One threshold's measurements, from the tile statistics at offset `level × tiles`. */
function analyse(stats: TileStats, level: number, threshold: number, policy: ComparatorPolicy, columns: number, rows: number, totalPixels: number, scratch: { visited: Uint8Array; queue: Int32Array }): Analysis {
  const { tile } = policy;
  const off = level * stats.tiles;
  const count = stats.count.subarray(off, off + stats.tiles);
  const minX = stats.minX.subarray(off, off + stats.tiles);
  const minY = stats.minY.subarray(off, off + stats.tiles);
  const maxX = stats.maxX.subarray(off, off + stats.tiles);
  const maxY = stats.maxY.subarray(off, off + stats.tiles);

  let changed = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  for (let t = 0; t < stats.tiles; t++) {
    const n = count[t] as number;
    if (n === 0) continue;
    changed += n;
    const cx = (t % columns) * tile;
    const cy = Math.floor(t / columns) * tile;
    x0 = Math.min(x0, cx + (minX[t] as number));
    y0 = Math.min(y0, cy + (minY[t] as number));
    x1 = Math.max(x1, cx + (maxX[t] as number));
    y1 = Math.max(y1, cy + (maxY[t] as number));
  }
  if (changed === 0) return { threshold, changedPixels: 0, changedPpm: 0, regions: [], regionCount: 0 };

  // 8-connected components of active tiles. Each region is boxed over every changed pixel in its
  // tile rectangle, as the prototype's `window` does, which can take in another component's
  // pixels. The component owns a tile in the rectangle's first and last row and column, so the
  // box comes from those four edges alone: linear overall, since a rectangle's perimeter is at
  // most four times its component's tile count.
  const { visited, queue } = scratch;
  visited.fill(0);
  const regions: Region[] = [];
  for (let start = 0; start < stats.tiles; start++) {
    if (count[start] === 0 || visited[start] === 1) continue;
    visited[start] = 1;
    queue[0] = start;
    let [head, tail] = [0, 1];
    let [top, left, bottom, right, pixels] = [rows, columns, -1, -1, 0];
    while (head < tail) {
      const t = queue[head++] as number;
      const row = Math.floor(t / columns);
      const column = t % columns;
      pixels += count[t] as number;
      top = Math.min(top, row);
      bottom = Math.max(bottom, row);
      left = Math.min(left, column);
      right = Math.max(right, column);
      for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) {
        for (let c = Math.max(0, column - 1); c <= Math.min(columns - 1, column + 1); c++) {
          const next = r * columns + c;
          if (count[next] === 0 || visited[next] === 1) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    let [ly0, lx0, ly1, lx1] = [255, 255, 0, 0];
    for (let c = left; c <= right; c++) {
      const first = top * columns + c;
      const last = bottom * columns + c;
      if (count[first] !== 0) ly0 = Math.min(ly0, minY[first] as number);
      if (count[last] !== 0) ly1 = Math.max(ly1, maxY[last] as number);
    }
    for (let r = top; r <= bottom; r++) {
      const first = r * columns + left;
      const last = r * columns + right;
      if (count[first] !== 0) lx0 = Math.min(lx0, minX[first] as number);
      if (count[last] !== 0) lx1 = Math.max(lx1, maxX[last] as number);
    }
    const x = left * tile + lx0;
    const y = top * tile + ly0;
    regions.push({ x, y, width: right * tile + lx1 - x + 1, height: bottom * tile + ly1 - y + 1, pixels });
  }
  regions.sort(compareRegions);
  return {
    threshold,
    changedPixels: changed,
    changedPpm: changedPpm(changed, totalPixels),
    bounds: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: changed },
    regions: regions.slice(0, policy.maxRegions),
    regionCount: regions.length,
  };
}

/**
 * Compares two decoded images under `policy` (comparator-v1: COMPARATOR_V1). Throws a RangeError
 * for a malformed image or policy. Never called for a unit whose sides aren't both captured.
 */
export function compareImages(base: RawPixels, head: RawPixels, policy: ComparatorPolicy): Comparison {
  checkPolicy(policy);
  checkPixels(base);
  checkPixels(head);
  // D2: different widths are a dimension change with no diff.
  if (base.width !== head.width) return { status: "changed", reasons: ["dimensions"] };
  const { width } = base;
  const height = Math.max(base.height, head.height);
  const totalPixels = width * height;
  const columns = Math.ceil(width / policy.tile);
  const rows = Math.ceil(height / policy.tile);
  const stats = collect(base, head, policy, height, columns, rows);
  const scratch = { visited: new Uint8Array(stats.tiles), queue: new Int32Array(stats.tiles) };
  const analyses = policy.thresholds.map((threshold, level) => analyse(stats, level, threshold, policy, columns, rows, totalPixels, scratch));
  const diff: Diff = { totalPixels, analyses };
  const changedAt = (threshold: number) => analyses[policy.thresholds.indexOf(threshold)]?.changedPixels ?? 0;
  if (base.height !== head.height) return { status: "changed", reasons: ["dimensions"], diff };
  const t0 = changedAt(0);
  if (t0 === 0) return { status: "unchanged", reasons: [], diff };
  if (t0 <= policy.subtleMaxPixels && changedAt(policy.subtleMaxDelta) === 0) return { status: "subtle", reasons: ["pixels"], diff };
  return { status: "changed", reasons: ["pixels"], diff };
}

// Generates testdata/comparator/tiny/cases.json: small hand-built comparator inputs for every
// result state and threshold/region boundary (M0.6, docs/adr/comparator-v1.md). The expected
// comparator numbers are NOT written here: they're recorded by running the prototype
// (record.py) and mapped by expected.ts. Only the side-state results (02 §4, no pixels
// compared) are declared here, and checkResult is their oracle.
//
//   node tools/prototype-goldens/tiny-cases.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** RGBA as 8 lowercase hex digits. */
type Rgba = string;
/** [x, y, width, height, colour], painted in order over the fill. */
export type Rect = [number, number, number, number, Rgba];

export interface TinyImage {
  width: number;
  height: number;
  fill: Rgba;
  rects?: Rect[];
}

export type TinySide =
  | { state: "captured"; image: TinyImage }
  | { state: "absent"; reason: "not-in-revision-catalog" }
  | { state: "failed"; category: "capture-error" }
  | { state: "missing"; cause: "unit-missing" | "part-missing" }
  | { state: "none" };

export type SideStatus = "missing" | "failed" | "incomparable" | "added" | "removed";

export interface TinyCase {
  id: string;
  description: string;
  covers: string[];
  base: TinySide;
  head: TinySide;
  /** Only for cases decided by side states (02 §4 precedence); never for compared pixels. */
  expect?: { status: SideStatus; reasons: string[] };
  /** A listed comparator-v1 delta from the prototype (ADR comparator-v1 §Deltas). */
  delta?: "D1" | "D2";
}

export const CASES_PATH = fileURLToPath(new URL("../../testdata/comparator/tiny/cases.json", import.meta.url));

function hex(r: number, g: number, b: number, a = 255): Rgba {
  return [r, g, b, a].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const GREY = hex(128, 128, 128);
const CLEAR = hex(0, 0, 0, 0);
/** Grey with the red channel moved by `d`. */
const red = (d: number): Rgba => hex(128 + d, 128, 128);

function image(width: number, height: number, rects: Rect[] = [], fill = GREY): TinyImage {
  return rects.length > 0 ? { width, height, fill, rects } : { width, height, fill };
}
const px = (x: number, y: number, colour: Rgba): Rect => [x, y, 1, 1, colour];
const captured = (img: TinyImage): TinySide => ({ state: "captured", image: img });
const plain = captured(image(4, 4));

function pair(id: string, description: string, covers: string[], base: TinyImage, head: TinyImage, delta?: TinyCase["delta"]): TinyCase {
  return { id, description, covers, base: captured(base), head: captured(head), ...(delta ? { delta } : {}) };
}

function sides(id: string, description: string, covers: string[], base: TinySide, head: TinySide, status: SideStatus, reasons: string[]): TinyCase {
  return { id, description, covers, base, head, expect: { status, reasons } };
}

const missingUnit: TinySide = { state: "missing", cause: "unit-missing" };
const missingPart: TinySide = { state: "missing", cause: "part-missing" };
const failed: TinySide = { state: "failed", category: "capture-error" };
const absent: TinySide = { state: "absent", reason: "not-in-revision-catalog" };
const none: TinySide = { state: "none" };

/** One 1-pixel change of red channel delta `d` at (1, 1) in a 4×4 grey image. */
function single(d: number, covers: string[]): TinyCase {
  const name = d < 0 ? `delta-minus-${String(-d)}` : `delta-${String(d)}`;
  return pair(name, `one pixel whose red channel moves by ${String(d)}`, covers, image(4, 4), image(4, 4, [px(1, 1, red(d))]));
}

/** `count` pixels of red delta `d`, row-major from (0, 0), in a 16×16 grey image. */
function many(count: number, d: number): Rect[] {
  const rects: Rect[] = [];
  const full = Math.floor(count / 16);
  if (full > 0) rects.push([0, 0, 16, full, red(d)]);
  if (count % 16 > 0) rects.push([0, full, count % 16, 1, red(d)]);
  return rects;
}

const STRONG = red(40);

export function buildTinyCases(): { comment: string; cases: TinyCase[] } {
  const cases: TinyCase[] = [
    // Side states only (02 §4 precedence; ADR 0003 `none`). No pixels are compared.
    sides("missing-head-unit", "head catalog lacks the unit", ["status-missing"], plain, missingUnit, "missing", ["unit-missing"]),
    sides("missing-base-part", "the base part never arrived", ["status-missing"], missingPart, plain, "missing", ["part-missing"]),
    sides("missing-both", "base part and head unit both missing", ["status-missing"], missingPart, missingUnit, "missing", ["part-missing", "unit-missing"]),
    sides("missing-over-failed", "missing wins over failed", ["precedence-missing-over-failed"], failed, missingUnit, "missing", ["unit-missing"]),
    sides("missing-over-none", "missing wins over no baseline", ["precedence-missing-over-incomparable"], none, missingUnit, "missing", ["unit-missing", "no-baseline"]),
    sides("failed-head", "head capture failed", ["status-failed"], plain, failed, "failed", ["capture-failed"]),
    sides("failed-base", "base capture failed", ["status-failed"], failed, plain, "failed", ["capture-failed"]),
    sides("failed-over-none", "failed wins over no baseline", ["precedence-failed-over-incomparable"], none, failed, "failed", ["capture-failed", "no-baseline"]),
    sides("failed-over-absent-base", "failed head is never added", ["precedence-failed-over-added"], absent, failed, "failed", ["capture-failed"]),
    sides("failed-over-absent-head", "failed base is never removed", ["precedence-failed-over-removed"], failed, absent, "failed", ["capture-failed"]),
    sides("no-baseline", "no base revision exists (initial commit)", ["status-incomparable"], none, plain, "incomparable", ["no-baseline"]),
    sides("added", "base catalog explicitly lacks the unit", ["status-added"], absent, plain, "added", []),
    sides("removed", "head catalog explicitly lacks the unit", ["status-removed"], plain, absent, "removed", []),

    // Channel deltas and thresholds (strict `delta > t`, t in 0/8/16/32).
    pair("identical", "identical opaque images", ["status-unchanged", "threshold-0-at"], image(4, 4), image(4, 4)),
    pair("identical-transparent", "identical fully transparent images", ["status-unchanged"], image(4, 4, [], CLEAR), image(4, 4, [], CLEAR)),
    single(1, ["threshold-0-above", "status-subtle"]),
    single(8, ["threshold-8-at", "subtle-delta-at"]),
    single(9, ["threshold-8-above", "subtle-delta-above", "status-changed"]),
    single(16, ["threshold-16-at"]),
    single(17, ["threshold-16-above"]),
    single(32, ["threshold-32-at"]),
    single(33, ["threshold-32-above"]),
    single(-9, ["delta-absolute"]),
    pair("delta-255", "black to red: the largest channel delta", ["delta-extreme"], image(4, 4, [px(2, 2, hex(0, 0, 0))]), image(4, 4, [px(2, 2, hex(255, 0, 0))])),
    pair("channel-max", "red +3, green +9, blue −2: the largest channel counts", ["channel-max"], image(4, 4), image(4, 4, [px(0, 3, hex(131, 137, 126))])),
    pair("alpha-only-8", "alpha 255 → 247", ["alpha-only"], image(4, 4), image(4, 4, [px(3, 0, hex(128, 128, 128, 247))])),
    pair("alpha-only-9", "alpha 255 → 246", ["alpha-only"], image(4, 4), image(4, 4, [px(3, 0, hex(128, 128, 128, 246))])),
    pair("alpha-visible-from-zero", "transparent black → alpha 1", ["alpha-visible-from-zero"], image(4, 4, [], CLEAR), image(4, 4, [px(1, 2, hex(0, 0, 0, 1))], CLEAR)),
    pair("hidden-rgb", "only RGB under alpha 0 differs", ["alpha-hidden-rgb"], image(4, 4, [px(1, 1, hex(10, 20, 30, 0))], CLEAR), image(4, 4, [px(1, 1, hex(200, 100, 50, 0))], CLEAR), "D1"),
    pair("hidden-rgb-then-visible", "hidden RGB (50,60,70) under alpha 0 → black at alpha 1", ["alpha-hidden-rgb"], image(4, 4, [px(2, 1, hex(50, 60, 70, 0))], CLEAR), image(4, 4, [px(2, 1, hex(0, 0, 0, 1))], CLEAR), "D1"),

    // The subtle rule: t0 ≤ 128 changed pixels and none above delta 8.
    pair("subtle-128", "128 pixels at delta 8", ["subtle-pixels-at"], image(16, 16), image(16, 16, many(128, 8))),
    pair("subtle-129", "129 pixels at delta 1", ["subtle-pixels-above"], image(16, 16), image(16, 16, many(129, 1))),
    pair("subtle-mixed", "10 pixels at delta 1 plus one at delta 9", ["subtle-mixed"], image(16, 16), image(16, 16, [...many(10, 1), px(15, 15, red(9))])),

    // Dimensions.
    pair("height-grow", "4×4 → 4×5, the new row opaque grey", ["dimensions-height-grow"], image(4, 4), image(4, 5)),
    pair("height-grow-transparent", "4×4 → 4×5, the new row transparent black (zero padded delta)", ["dimensions-zero-delta"], image(4, 4), image(4, 5, [[0, 4, 4, 1, CLEAR]])),
    pair("height-shrink", "4×5 → 4×4", ["dimensions-height-shrink"], image(4, 5, [px(0, 4, STRONG)]), image(4, 4)),
    pair("width-change", "4×4 → 5×4", ["dimensions-width"], image(4, 4), image(5, 4), "D2"),
    pair("one-pixel", "1×1 black → red", ["minimum-size"], image(1, 1, [], hex(0, 0, 0)), image(1, 1, [], hex(255, 0, 0))),
    pair("one-pixel-same", "1×1 identical", ["minimum-size"], image(1, 1), image(1, 1)),

    // Regions: 8 px tiles, 8-connected, clipped to the changed pixels in the component's tile
    // rectangle, top 12 by (−pixels, y, x).
    pair("region-tile-boundary", "x = 7 and x = 8 sit in adjacent tiles", ["region-tile-boundary"], image(32, 32), image(32, 32, [px(7, 3, STRONG), px(8, 3, STRONG)])),
    pair("region-diagonal", "diagonal tiles are connected", ["region-diagonal"], image(32, 32), image(32, 32, [px(7, 7, STRONG), px(8, 8, STRONG)])),
    pair("region-gap", "9 px apart but one tile between them", ["region-gap"], image(32, 32), image(32, 32, [px(7, 3, STRONG), px(16, 3, STRONG)])),
    pair("region-clip", "a region's box is clipped to its changed pixels", ["region-clip"], image(32, 32), image(32, 32, [px(3, 2, STRONG), px(12, 9, STRONG)])),
    pair("region-threshold", "a delta-5 region disappears above t0", ["region-threshold"], image(32, 32), image(32, 32, [px(2, 2, red(5)), px(26, 26, STRONG)])),
    pair(
      "region-sort",
      "regions sort by pixels (desc), then y, then x",
      ["region-sort"],
      image(32, 32),
      image(32, 32, [px(1, 1, STRONG), [25, 1, 2, 1, STRONG], [1, 25, 2, 1, STRONG], [25, 25, 3, 1, STRONG]]),
    ),
    pair("region-truncate", "16 separate regions: 12 kept, regionCount 16", ["region-truncate"], image(64, 64), image(64, 64, truncationRects())),
    pair("region-sort-tie", "two regions with equal pixels, y and x", ["region-sort-tie"], image(32, 32), image(32, 32, tieRects())),
    pair(
      "region-window",
      "a region's box covers every changed pixel in its tile rectangle, including another region's",
      ["region-window"],
      image(64, 32),
      image(64, 32, windowRects()),
    ),
  ];
  return {
    comment: "Generated by tools/prototype-goldens/tiny-cases.ts. Do not edit; see testdata/comparator/README.md.",
    cases,
  };
}

/** Region n (tile row 2i, column 2j) has n % 4 + 1 pixels, so sizes tie in groups of four. */
function truncationRects(): Rect[] {
  const rects: Rect[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const n = i * 4 + j;
      rects.push([j * 16 + 1, i * 16 + 1, (n % 4) + 1, 1, STRONG]);
    }
  }
  return rects;
}

/** A: 7 px in tiles (0..1, 0..1). B: 7 px along tile row 3 and column 3. Both boxes start at (0, 0). */
function tieRects(): Rect[] {
  const a: [number, number][] = [[0, 0], [8, 0], [0, 8], [1, 1], [2, 2], [9, 9], [10, 10]];
  const b: [number, number][] = [[24, 0], [24, 8], [24, 16], [24, 24], [16, 24], [8, 24], [0, 24]];
  return [...a, ...b].map(([x, y]) => px(x, y, STRONG));
}

/**
 * A: a U of 7 tiles (rows 0–2, columns 0–6), one pixel at local (3, 7) in each. B: one pixel at
 * (27, 0) in tile (0, 3), which no A tile touches but A's tile rectangle contains. The prototype
 * boxes A over that whole rectangle, so A's box starts at y = 0 (B's pixel), not y = 7.
 */
function windowRects(): Rect[] {
  const a: [number, number][] = [[0, 0], [1, 1], [2, 2], [2, 3], [2, 4], [1, 5], [0, 6]];
  return [...a.map(([row, column]): Rect => px(column * 8 + 3, row * 8 + 7, STRONG)), px(27, 0, STRONG)];
}

/** The image as tightly packed RGBA8: the fill, then each rect painted in order. */
export function paintTinyImage(image: TinyImage): Uint8Array {
  const data = new Uint8Array(image.width * image.height * 4);
  const paint = (x0: number, y0: number, w: number, h: number, colour: string) => {
    const rgba = Buffer.from(colour, "hex");
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set(rgba, (y * image.width + x) * 4);
  };
  paint(0, 0, image.width, image.height, image.fill);
  for (const [x, y, w, h, colour] of image.rects ?? []) paint(x, y, w, h, colour);
  return data;
}

export function serializeTinyCases(): string {
  return `${JSON.stringify(buildTinyCases(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(CASES_PATH, serializeTinyCases());
  console.log(`wrote ${join("testdata", "comparator", "tiny", "cases.json")}`);
}

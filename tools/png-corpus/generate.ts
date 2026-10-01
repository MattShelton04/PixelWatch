// Generates testdata/png/hostile/: the M1.1 hostile PNG corpus (02 §5, threat-model R4.3-08).
// Each file breaks exactly one rule of the restricted profile; manifest.json names the PngError
// code the trusted decoder must reject it with, and why. The files are committed so the corpus
// is fixed even if this script or Node's zlib output changes.
//
//   node tools/png-corpus/generate.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { IEND, PNG_SIGNATURE, buildPng, chunk, concat, type Header, idats, ihdr, png } from "./png-builder.ts";

export const HOSTILE_DIR = fileURLToPath(new URL("../../testdata/png/hostile/", import.meta.url));

export interface HostileCase {
  name: string;
  code: string;
  why: string;
  bytes: Uint8Array;
}

/** A valid 2×2 RGB image: four distinct pixels. */
const PIXELS = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255);
const GOOD = deflateSync(Uint8Array.of(0, ...PIXELS.subarray(0, 6), 0, ...PIXELS.subarray(6)));
const GOOD_IDAT = chunk("IDAT", GOOD);
const HDR: Header = { width: 2, height: 2 };

function withHeader(header: Partial<Header>, ...rest: Uint8Array[]): Uint8Array {
  return png(ihdr({ ...HDR, ...header }), ...(rest.length > 0 ? rest : [GOOD_IDAT, IEND]));
}

/** 2×2 RGB whose zlib stream is `stream`, in one IDAT. */
function withStream(stream: Uint8Array, header: Partial<Header> = {}): Uint8Array {
  return png(ihdr({ ...HDR, ...header }), ...idats(stream), IEND);
}

function corruptLast(bytes: Uint8Array, count: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let i = out.length - count; i < out.length; i++) out[i] = (out[i] ?? 0) ^ 0xff;
  return out;
}

export function hostileCorpus(): HostileCase[] {
  const cases: HostileCase[] = [];
  const add = (name: string, code: string, why: string, bytes: Uint8Array) => {
    cases.push({ name, code, why, bytes });
  };

  // Signature and framing.
  add("signature-empty", "signature", "empty file", new Uint8Array(0));
  add("signature-short", "signature", "7 of the 8 signature bytes", PNG_SIGNATURE.subarray(0, 7));
  add("signature-wrong", "signature", "GIF header instead of the PNG signature", concat([Uint8Array.from("GIF89a\0\0", (c) => c.charCodeAt(0)), ihdr(HDR), GOOD_IDAT, IEND]));
  add("signature-only", "truncated", "signature with no chunks", PNG_SIGNATURE);
  add("chunk-length-beyond-file", "truncated", "IDAT claims 1000 bytes; the file ends first", png(ihdr(HDR), chunk("IDAT", GOOD, { length: 1000 })));
  add("chunk-length-over-2-31", "chunk-length", "IDAT length field 0x80000000 (PNG caps lengths at 2^31-1)", png(ihdr(HDR), chunk("IDAT", GOOD, { length: 0x80000000 }), IEND));
  add("chunk-length-max-u32", "chunk-length", "IDAT length field 0xFFFFFFFF", png(ihdr(HDR), chunk("IDAT", GOOD, { length: 0xffffffff }), IEND));
  add("chunk-type-digit", "chunk-type", "chunk type ID1T has a digit", png(ihdr(HDR), chunk("ID1T", GOOD), IEND));
  add("chunk-type-nul", "chunk-type", "chunk type contains NUL", png(ihdr(HDR), chunk("IDA\0", GOOD), IEND));

  // CRCs.
  add("crc-ihdr", "chunk-crc", "wrong CRC on IHDR", png(chunk("IHDR", ihdr(HDR).subarray(8, 21), { crc: 0 }), GOOD_IDAT, IEND));
  add("crc-idat", "chunk-crc", "wrong CRC on IDAT", png(ihdr(HDR), chunk("IDAT", GOOD, { crc: 0x12345678 }), IEND));
  add("crc-iend", "chunk-crc", "wrong CRC on IEND", png(ihdr(HDR), GOOD_IDAT, chunk("IEND", new Uint8Array(0), { crc: 0 })));

  // IHDR / IEND structure.
  add("ihdr-missing", "ihdr-first", "IDAT before any IHDR", png(GOOD_IDAT, IEND));
  add("ihdr-late", "ihdr-first", "IHDR after IDAT", png(GOOD_IDAT, ihdr(HDR), IEND));
  add("ihdr-short", "ihdr-length", "IHDR with 12 data bytes", png(chunk("IHDR", ihdr(HDR).subarray(8, 20)), GOOD_IDAT, IEND));
  add("ihdr-long", "ihdr-length", "IHDR with 14 data bytes", png(chunk("IHDR", concat([ihdr(HDR).subarray(8, 21), Uint8Array.of(0)])), GOOD_IDAT, IEND));
  add("ihdr-duplicate", "ihdr-duplicate", "a second identical IHDR", png(ihdr(HDR), ihdr(HDR), GOOD_IDAT, IEND));
  add("ihdr-duplicate-after-idat", "ihdr-duplicate", "a second IHDR between IDAT and IEND", png(ihdr(HDR), GOOD_IDAT, ihdr(HDR), IEND));
  add("iend-missing", "truncated", "no IEND", png(ihdr(HDR), GOOD_IDAT));
  add("iend-duplicate", "trailing-bytes", "two IENDs", png(ihdr(HDR), GOOD_IDAT, IEND, IEND));
  add("iend-nonempty", "iend-length", "IEND carries a byte", png(ihdr(HDR), GOOD_IDAT, chunk("IEND", Uint8Array.of(0))));
  add("trailing-byte", "trailing-bytes", "one byte after IEND", concat([png(ihdr(HDR), GOOD_IDAT, IEND), Uint8Array.of(0)]));
  add("trailing-chunk", "trailing-bytes", "a tEXt chunk after IEND (polyglot tail)", png(ihdr(HDR), GOOD_IDAT, IEND, chunk("tEXt", Uint8Array.from("k\0v", (c) => c.charCodeAt(0)))));
  add("idat-missing", "idat-missing", "IHDR then IEND, no IDAT", png(ihdr(HDR), IEND));

  // Dimensions and overflow. The image data never matters: the header is rejected first.
  add("width-zero", "dimensions", "width 0", withHeader({ width: 0 }));
  add("height-zero", "dimensions", "height 0", withHeader({ height: 0 }));
  add("width-16384", "dimensions", "width one over 16383", withHeader({ width: 16384, height: 1 }));
  add("height-16384", "dimensions", "height one over 16383", withHeader({ width: 1, height: 16384 }));
  add("width-2-31", "dimensions", "width 2^31", withHeader({ width: 0x80000000, height: 1 }));
  add("dims-max-u32", "dimensions", "0xFFFFFFFF × 0xFFFFFFFF (overflows any 32/64-bit product)", withHeader({ width: 0xffffffff, height: 0xffffffff }));
  add("dims-65536", "dimensions", "65536 × 65536 (product wraps to 0 in 32 bits)", withHeader({ width: 65536, height: 65536 }));
  add("pixels-4001x4000", "too-many-pixels", "16,004,000 pixels, each dimension in range", withHeader({ width: 4001, height: 4000 }));
  add("pixels-16383-square", "too-many-pixels", "16383 × 16383", withHeader({ width: 16383, height: 16383 }));

  // Colour type, bit depth, methods, interlace.
  for (const [colorType, label] of [[0, "grey"], [1, "invalid-1"], [3, "palette"], [4, "grey-alpha"], [7, "invalid-7"]] as const) {
    add(`color-type-${String(colorType)}`, "color-type", `colour type ${String(colorType)} (${label})`, withHeader({ colorType }));
  }
  for (const [colorType, bitDepth] of [[2, 16], [6, 16], [2, 1], [2, 2], [2, 4], [6, 4], [2, 0], [2, 9]] as const) {
    add(`bit-depth-${String(bitDepth)}-ct${String(colorType)}`, "bit-depth", `bit depth ${String(bitDepth)} with colour type ${String(colorType)}`, withHeader({ colorType, bitDepth }));
  }
  add("compression-method-1", "compression-method", "compression method 1", withHeader({ compression: 1 }));
  add("filter-method-1", "filter-method", "filter method 1", withHeader({ filter: 1 }));
  add("interlace-adam7", "interlace", "Adam7 interlace", withHeader({ interlace: 1 }));
  add("interlace-2", "interlace", "interlace method 2", withHeader({ interlace: 2 }));

  // Chunks outside the profile: only IHDR, IDAT and IEND are allowed.
  const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const extras: [string, Uint8Array][] = [
    ["tEXt", text("Comment\0hello")],
    ["iTXt", text("XML:com.adobe.xmp\0\0\0\0\0<x/>")],
    ["iCCP", concat([text("icc\0\0"), deflateSync(new Uint8Array(16))])],
    ["sRGB", Uint8Array.of(0)],
    ["gAMA", Uint8Array.of(0, 0, 0xb1, 0x8f)],
    ["pHYs", Uint8Array.of(0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1)],
    ["eXIf", text("MM\0*\0\0\0\b\0\0")],
    ["tRNS", Uint8Array.of(0, 0, 0, 0, 0, 0)],
    ["PLTE", Uint8Array.of(0, 0, 0, 255, 255, 255)],
    ["acTL", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0)],
    ["ABCD", text("unknown critical")],
    ["zzZz", text("unknown ancillary")],
  ];
  for (const [type, data] of extras) {
    add(`chunk-${type}-before-idat`, "chunk-disallowed", `${type} between IHDR and IDAT`, png(ihdr(HDR), chunk(type, data), GOOD_IDAT, IEND));
  }
  add("chunk-tEXt-after-idat", "chunk-disallowed", "tEXt between IDAT and IEND", png(ihdr(HDR), GOOD_IDAT, chunk("tEXt", text("a\0b")), IEND));
  add("idat-not-contiguous", "chunk-disallowed", "IDAT, tEXt, IDAT", png(ihdr(HDR), ...idats(GOOD, [4]).flatMap((c, i) => (i === 0 ? [c, chunk("tEXt", text("a\0b"))] : [c])), IEND));

  // Filter bytes (2 rows; the stream is otherwise exact).
  const scan = (f0: number, f1: number) => deflateSync(Uint8Array.of(f0, ...PIXELS.subarray(0, 6), f1, ...PIXELS.subarray(6)));
  add("filter-5-first-row", "filter-type", "filter type 5 on row 0", withStream(scan(5, 0)));
  add("filter-255-last-row", "filter-type", "filter type 255 on the last row", withStream(scan(0, 255)));

  // zlib stream shape.
  const raw = Uint8Array.of(0, ...PIXELS.subarray(0, 6), 0, ...PIXELS.subarray(6));
  add("zlib-header", "zlib", "invalid zlib header (0x00 0x00)", withStream(concat([Uint8Array.of(0, 0), GOOD.subarray(2)])));
  add("zlib-adler", "zlib", "wrong Adler-32 trailer", withStream(corruptLast(GOOD, 4)));
  add("zlib-dictionary", "zlib", "FDICT stream needing a preset dictionary", withStream(deflateSync(raw, { dictionary: Uint8Array.of(1, 2, 3, 4) })));
  add("zlib-truncated", "inflate-truncated", "zlib stream cut before its end", withStream(GOOD.subarray(0, GOOD.length - 6)));
  add("zlib-empty", "inflate-truncated", "only a zero-length IDAT", png(ihdr(HDR), chunk("IDAT"), IEND));
  add("zlib-trailing-data", "zlib-trailing", "bytes after the zlib stream end, inside IDAT", withStream(concat([GOOD, Uint8Array.of(0xde, 0xad)])));
  add("inflate-short", "inflate-short", "complete stream with one scanline byte missing", withStream(deflateSync(raw.subarray(0, raw.length - 1))));
  add("inflate-short-huge-claim", "inflate-short", "4000×4000 RGBA header, 2×2 worth of data", withStream(GOOD, { width: 4000, height: 4000, colorType: 6 }));
  add("inflate-one-extra-byte", "inflate-overflow", "one scanline byte too many", withStream(deflateSync(concat([raw, Uint8Array.of(0)]))));
  add("bomb-1x1-1mib", "inflate-overflow", "1×1 RGB (4 bytes expected) inflating to 1 MiB", png(ihdr({ width: 1, height: 1 }), chunk("IDAT", deflateSync(new Uint8Array(1 << 20), { level: 9 })), IEND));
  const maxExpected = 4000 * (1 + 4000 * 4);
  add(
    "bomb-4000x4000-rgba",
    "inflate-overflow",
    "16 MP RGBA at the pixel limit; the stream is 1 MiB longer than the 64,004,000 expected bytes",
    png(ihdr({ width: 4000, height: 4000, colorType: 6 }), ...idats(deflateSync(new Uint8Array(maxExpected + (1 << 20)), { level: 9 }), [1 << 16]), IEND),
  );

  // A valid image with a polyglot payload after IEND is still rejected as a whole.
  add("valid-then-zip", "trailing-bytes", "valid PNG followed by a ZIP local header", concat([buildPng(2, 2, 3, PIXELS), Uint8Array.of(0x50, 0x4b, 0x03, 0x04)]));
  return cases;
}

export interface Manifest {
  comment: string;
  cases: { file: string; code: string; why: string }[];
}

export function manifest(cases: HostileCase[]): Manifest {
  return {
    comment: "Generated by tools/png-corpus/generate.ts. Each file must be rejected by the trusted decoder with `code`.",
    cases: cases.map((c) => ({ file: `${c.name}.png`, code: c.code, why: c.why })),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cases = hostileCorpus();
  mkdirSync(HOSTILE_DIR, { recursive: true });
  for (const file of readdirSync(HOSTILE_DIR)) if (file.endsWith(".png")) rmSync(join(HOSTILE_DIR, file));
  for (const c of cases) writeFileSync(join(HOSTILE_DIR, `${c.name}.png`), c.bytes);
  writeFileSync(join(HOSTILE_DIR, "manifest.json"), `${JSON.stringify(manifest(cases), null, 2)}\n`);
  const bytes = cases.reduce((sum, c) => sum + c.bytes.byteLength, 0);
  console.log(`wrote ${String(cases.length)} files (${String(bytes)} bytes) to testdata/png/hostile/`);
}

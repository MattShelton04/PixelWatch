// Canonical PNG encoder (03 §4; threat-model R4.3-09). The publisher never stores uploaded bytes:
// it re-encodes decoded pixels into a metadata-free PNG that fits the 02 §5 profile.
//
// Canonical form: pixels normalized as for the pixel hash (RGB is 0 wherever alpha is 0); colour
// type 2 (RGB) when every pixel is opaque, otherwise 6 (RGBA); per-row filter chosen by the
// minimum sum of absolute differences (ties go to the lower filter type); zlib level 9; IDAT chunks
// of 256 KiB; only IHDR, IDAT and IEND. The output is deterministic for a given zlib build. Blob
// identity is the pixel hash, never these bytes, so a later encoder change doesn't break reuse.
import { crc32, deflateSync } from "node:zlib";
import { type RawPixels, checkPixels } from "../pixel-hash.ts";
import { PngError } from "./errors.ts";
import { MAX_PNG_BYTES } from "./limits.ts";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const IDAT_BYTES = 256 * 1024;
const ZLIB_LEVEL = 9;

function isOpaque(image: RawPixels): boolean {
  if (image.channels === 3) return true;
  const { data } = image;
  for (let i = 3; i < data.byteLength; i += 4) if (data[i] !== 255) return false;
  return true;
}

/** Writes row `y` of `image`, normalized, as `channels`-byte pixels into `out`. */
function normalizedRow(image: RawPixels, y: number, channels: 3 | 4, out: Uint8Array): void {
  const { width, data } = image;
  const inChannels = image.channels;
  let src = y * width * inChannels;
  for (let dst = 0; dst < out.byteLength; dst += channels, src += inChannels) {
    const alpha = inChannels === 4 ? (data[src + 3] as number) : 255;
    const visible = alpha !== 0;
    out[dst] = visible ? (data[src] as number) : 0;
    out[dst + 1] = visible ? (data[src + 1] as number) : 0;
    out[dst + 2] = visible ? (data[src + 2] as number) : 0;
    if (channels === 4) out[dst + 3] = alpha;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The predictor for filter `type` at byte `i` (PNG spec §9). */
function predict(type: number, cur: Uint8Array, prev: Uint8Array, i: number, bpp: number): number {
  const a = i >= bpp ? (cur[i - bpp] as number) : 0;
  const b = prev[i] as number;
  switch (type) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >>> 1;
    default:
      return paeth(a, b, i >= bpp ? (prev[i - bpp] as number) : 0);
  }
}

/** Writes the cheapest filter type for `cur` and its residuals into `out`. */
function filterRow(cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): void {
  let best = 0;
  let bestCost = Infinity;
  for (let type = 0; type <= 4; type++) {
    let cost = 0;
    for (let i = 0; i < cur.byteLength && cost < bestCost; i++) {
      const residual = ((cur[i] as number) - predict(type, cur, prev, i, bpp)) & 0xff;
      cost += residual < 128 ? residual : 256 - residual;
    }
    if (cost < bestCost) {
      best = type;
      bestCost = cost;
    }
  }
  out[0] = best;
  for (let i = 0; i < cur.byteLength; i++) out[i + 1] = ((cur[i] as number) - predict(best, cur, prev, i, bpp)) & 0xff;
}

function writeChunk(out: Uint8Array, at: number, type: string, data: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(at, data.byteLength);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
  out.set(data, at + 8);
  view.setUint32(at + 8 + data.byteLength, crc32(data, crc32(out.subarray(at + 4, at + 8))));
  return at + 12 + data.byteLength;
}

export function encodePng(image: RawPixels): Uint8Array {
  try {
    checkPixels(image);
  } catch (error) {
    throw new PngError("pixels", error instanceof Error ? error.message : "invalid pixels");
  }
  const { width, height } = image;
  const channels = isOpaque(image) ? 3 : 4;
  const rowBytes = width * channels;
  const filtered = new Uint8Array(height * (rowBytes + 1));
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    normalizedRow(image, y, channels, cur);
    filterRow(cur, prev, channels, filtered.subarray(y * (rowBytes + 1), (y + 1) * (rowBytes + 1)));
    [prev, cur] = [cur, prev];
  }
  const stream = deflateSync(filtered, { level: ZLIB_LEVEL });

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const idatCount = Math.max(1, Math.ceil(stream.byteLength / IDAT_BYTES));
  const size = SIGNATURE.byteLength + (12 + 13) + idatCount * 12 + stream.byteLength + 12;
  if (size > MAX_PNG_BYTES) throw new PngError("encoded-too-large", `canonical PNG would be ${String(size)} bytes`);

  const out = new Uint8Array(size);
  out.set(SIGNATURE, 0);
  let at = writeChunk(out, SIGNATURE.byteLength, "IHDR", header);
  for (let i = 0; i < idatCount; i++) at = writeChunk(out, at, "IDAT", stream.subarray(i * IDAT_BYTES, (i + 1) * IDAT_BYTES));
  writeChunk(out, at, "IEND", new Uint8Array(0));
  return out;
}

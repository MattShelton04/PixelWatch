// Capture-side PNG normalization to the 02 §5 chunk profile, without decoding pixels: signature,
// one IHDR (8-bit RGB/RGBA, methods 0, non-interlaced), contiguous IDATs, one final IEND, valid
// CRCs, no trailing bytes. Ancillary chunks (metadata, APNG control) are dropped. The publisher
// still decodes and re-encodes everything; this only keeps bundles inside the ingress profile.
import { crc32 } from "node:zlib";

export const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_DIMENSION = 16383;
const MAX_PIXELS = 16_000_000;
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export type PngProfileResult =
  | { readonly ok: true; readonly png: Uint8Array; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: string };

interface Chunk {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly data: Uint8Array;
}

function reject(reason: string): PngProfileResult {
  return { ok: false, reason };
}

export function normalizePng(input: Uint8Array): PngProfileResult {
  if (input.byteLength > MAX_PNG_BYTES) return reject("PNG exceeds 32 MiB");
  if (input.byteLength < SIGNATURE.length || SIGNATURE.some((b, i) => input[i] !== b)) {
    return reject("not a PNG signature");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const chunks: Chunk[] = [];
  let pos = SIGNATURE.length;
  for (;;) {
    if (pos + 12 > input.byteLength) return reject("truncated chunk");
    const length = view.getUint32(pos);
    if (length > input.byteLength - pos - 12) return reject("chunk length exceeds the file");
    const typeBytes = input.subarray(pos + 4, pos + 8);
    if (!typeBytes.every((b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) {
      return reject("invalid chunk type");
    }
    const type = String.fromCharCode(...typeBytes);
    const data = input.subarray(pos + 8, pos + 8 + length);
    const crc = view.getUint32(pos + 8 + length);
    if (crc32(data, crc32(typeBytes)) !== crc) return reject(`bad CRC in ${type}`);
    chunks.push({ type, start: pos, end: pos + 12 + length, data });
    pos += 12 + length;
    if (type === "IEND") break;
  }
  if (pos !== input.byteLength) return reject("trailing bytes after IEND");

  const [ihdr] = chunks;
  if (ihdr?.type !== "IHDR" || ihdr.data.byteLength !== 13) return reject("IHDR must be the first chunk");
  const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const [bitDepth, colorType, compression, filter, interlace] = ihdr.data.subarray(8);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return reject("dimension out of range");
  if (width * height > MAX_PIXELS) return reject("too many pixels");
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return reject("only 8-bit RGB or RGBA is allowed");
  if (compression !== 0 || filter !== 0) return reject("unsupported compression or filter method");
  if (interlace !== 0) return reject("interlaced PNGs are not allowed");

  const kept: Chunk[] = [ihdr];
  let idatState: "before" | "in" | "after" = "before";
  for (const chunk of chunks.slice(1)) {
    const critical = chunk.type.charCodeAt(0) < 0x61;
    if (chunk.type === "IDAT") {
      if (idatState === "after") return reject("IDAT chunks must be contiguous");
      idatState = "in";
      kept.push(chunk);
    } else if (chunk.type === "IEND") {
      if (chunk.data.byteLength !== 0) return reject("IEND must be empty");
      kept.push(chunk);
    } else {
      if (idatState === "in") idatState = "after";
      if (chunk.type === "IHDR") return reject("more than one IHDR");
      // PLTE is only a suggested palette for truecolour images; everything ancillary is metadata.
      if (critical && chunk.type !== "PLTE") return reject(`unknown critical chunk ${chunk.type}`);
    }
  }
  if (idatState === "before") return reject("no IDAT chunk");

  const size = SIGNATURE.length + kept.reduce((sum, c) => sum + (c.end - c.start), 0);
  const png = new Uint8Array(size);
  png.set(SIGNATURE, 0);
  let offset = SIGNATURE.length;
  for (const chunk of kept) {
    png.set(input.subarray(chunk.start, chunk.end), offset);
    offset += chunk.end - chunk.start;
  }
  return { ok: true, png, width, height };
}

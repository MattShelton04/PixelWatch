// Structural check of the restricted PNG profile (02 §5), without inflating anything: size,
// signature, chunk framing and CRCs, one IHDR first with 8-bit RGB/RGBA, methods 0 and no
// interlace, then only IDAT chunks (contiguous by construction) and one empty final IEND, with
// no trailing bytes. Checks run in file order, so the first broken thing is what's reported.
// The zlib stream is the single IDAT's payload as a subarray, or, when it's split across IDATs,
// one copy bounded by the input size. Per-chunk objects are never kept: 32 MiB of 1-byte IDATs
// would otherwise mean millions of them.
import { crc32 } from "node:zlib";
import { PngError } from "./errors.ts";
import { MAX_DIMENSION, MAX_PIXELS, MAX_PNG_BYTES } from "./limits.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG chunk lengths are at most 2^31 − 1. */
const MAX_CHUNK_LENGTH = 0x7fffffff;

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}

export interface PngStructure {
  readonly header: PngHeader;
  /** The zlib stream: all IDAT payloads in order. */
  readonly stream: Uint8Array;
  /** Exact inflated size: one filter byte plus width × channels bytes per row. */
  readonly scanlineBytes: number;
}

function isLetter(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

function parseHeader(data: Uint8Array): PngHeader {
  if (data.byteLength !== 13) throw new PngError("ihdr-length", `IHDR has ${String(data.byteLength)} bytes, not 13`);
  const view = new DataView(data.buffer, data.byteOffset, 13);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new PngError("dimensions", `${String(width)}×${String(height)} is outside 1–${String(MAX_DIMENSION)}`);
  }
  // Both factors are ≤ 16383 here, so the product is exact.
  if (width * height > MAX_PIXELS) throw new PngError("too-many-pixels", `${String(width * height)} pixels exceeds ${String(MAX_PIXELS)}`);
  if (colorType !== 2 && colorType !== 6) throw new PngError("color-type", `colour type ${String(colorType)}; only 2 (RGB) and 6 (RGBA)`);
  if (bitDepth !== 8) throw new PngError("bit-depth", `bit depth ${String(bitDepth)}; only 8`);
  if (compression !== 0) throw new PngError("compression-method", `compression method ${String(compression)}`);
  if (filter !== 0) throw new PngError("filter-method", `filter method ${String(filter)}`);
  if (interlace !== 0) throw new PngError("interlace", `interlace method ${String(interlace)}; only non-interlaced`);
  return { width, height, channels: colorType === 6 ? 4 : 3 };
}

export function parsePngStructure(bytes: Uint8Array): PngStructure {
  if (bytes.byteLength > MAX_PNG_BYTES) throw new PngError("too-large", `${String(bytes.byteLength)} bytes exceeds ${String(MAX_PNG_BYTES)}`);
  if (bytes.byteLength < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new PngError("signature", "not a PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: PngHeader | undefined;
  let idatCount = 0;
  let idatBytes = 0;
  let idatFrom = 0;
  let idatTo = 0;
  let pos = SIGNATURE.length;
  for (;;) {
    if (bytes.byteLength - pos < 12) throw new PngError("truncated", `file ends inside a chunk header at byte ${String(pos)}`);
    const length = view.getUint32(pos);
    if (length > MAX_CHUNK_LENGTH) throw new PngError("chunk-length", `chunk length ${String(length)} exceeds 2^31 − 1`);
    if (length > bytes.byteLength - pos - 12) throw new PngError("truncated", `chunk at byte ${String(pos)} runs past the end of the file`);
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    if (!typeBytes.every(isLetter)) throw new PngError("chunk-type", `invalid chunk type at byte ${String(pos)}`);
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (crc32(data, crc32(typeBytes)) !== view.getUint32(pos + 8 + length)) throw new PngError("chunk-crc", `bad CRC in ${type}`);
    pos += 12 + length;

    if (header === undefined) {
      if (type !== "IHDR") throw new PngError("ihdr-first", `first chunk is ${type}, not IHDR`);
      header = parseHeader(data);
    } else if (type === "IDAT") {
      if (idatCount === 0) idatFrom = pos - 12 - length;
      idatTo = pos;
      idatCount++;
      idatBytes += length;
    } else if (type === "IEND") {
      if (length !== 0) throw new PngError("iend-length", "IEND must be empty");
      break;
    } else if (type === "IHDR") {
      throw new PngError("ihdr-duplicate", "more than one IHDR");
    } else {
      // Only IHDR, IDAT and IEND: no PLTE, metadata, APNG or unknown chunks. Since nothing else
      // may appear, the IDAT chunks are necessarily contiguous.
      throw new PngError("chunk-disallowed", `chunk ${type} is outside the profile`);
    }
  }
  if (pos !== bytes.byteLength) throw new PngError("trailing-bytes", `${String(bytes.byteLength - pos)} bytes after IEND`);
  if (idatCount === 0) throw new PngError("idat-missing", "no IDAT chunk");
  const scanlineBytes = header.height * (1 + header.width * header.channels);
  return { header, stream: idatStream(bytes, view, idatFrom, idatTo, idatCount, idatBytes), scanlineBytes };
}

/** The IDAT payloads in [from, to), which holds only IDAT chunks already checked above. */
function idatStream(bytes: Uint8Array, view: DataView, from: number, to: number, count: number, total: number): Uint8Array {
  if (count === 1) return bytes.subarray(from + 8, to - 4);
  const stream = new Uint8Array(total);
  let at = 0;
  for (let pos = from; pos < to; ) {
    const length = view.getUint32(pos);
    stream.set(bytes.subarray(pos + 8, pos + 8 + length), at);
    at += length;
    pos += 12 + length;
  }
  return stream;
}

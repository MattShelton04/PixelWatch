// Test-side PNG building blocks for the hostile corpus and the decoder tests (M1.1). Deliberately
// naive and written separately from packages/core/src/png/: a test that shares its encoder with
// the code under test can hide shared bugs (07 §2). Never import this from packages/*/src.
import { crc32, deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** One chunk: length, type, data, CRC. `crc` overrides the correct CRC; `length` the length field. */
export function chunk(type: string, data: Uint8Array = new Uint8Array(0), options: { crc?: number; length?: number } = {}): Uint8Array {
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const crc = options.crc ?? crc32(data, crc32(typeBytes));
  return concat([u32(options.length ?? data.byteLength), typeBytes, data, u32(crc)]);
}

export interface Header {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
  compression?: number;
  filter?: number;
  interlace?: number;
}

export function ihdrData(h: Header): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, h.width);
  view.setUint32(4, h.height);
  data.set([h.bitDepth ?? 8, h.colorType ?? 2, h.compression ?? 0, h.filter ?? 0, h.interlace ?? 0], 8);
  return data;
}

export function ihdr(h: Header): Uint8Array {
  return chunk("IHDR", ihdrData(h));
}

export const IEND = chunk("IEND");

export function png(...chunks: Uint8Array[]): Uint8Array {
  return concat([PNG_SIGNATURE, ...chunks]);
}

/** Splits a zlib stream into IDAT chunks at the given sizes (the last chunk takes the rest). */
export function idats(stream: Uint8Array, sizes: readonly number[] = []): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= stream.byteLength) break;
    out.push(chunk("IDAT", stream.subarray(at, at + size)));
    at += size;
  }
  if (at < stream.byteLength || out.length === 0) out.push(chunk("IDAT", stream.subarray(at)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Filtered scanlines (PNG spec §9, written from the spec, not from the decoder): each row gets
 * the filter type `filters(y)` and is encoded against the previous unfiltered row.
 */
export function filterScanlines(width: number, height: number, channels: number, pixels: Uint8Array, filters: (y: number) => number): Uint8Array {
  const rowBytes = width * channels;
  const out = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const type = filters(y);
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? pixels.subarray((y - 1) * rowBytes, y * rowBytes) : new Uint8Array(rowBytes);
    const at = y * (rowBytes + 1);
    out[at] = type;
    for (let i = 0; i < rowBytes; i++) {
      const x = row[i] ?? 0;
      const a = i >= channels ? (row[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][type] ?? 0;
      out[at + 1 + i] = (x - predictor) & 0xff;
    }
  }
  return out;
}

export interface BuildOptions {
  /** Filter type per row (default: None). */
  filters?: (y: number) => number;
  /** IDAT chunk sizes for the zlib stream (default: one IDAT). */
  split?: readonly number[];
  /** Extra chunks after IHDR / after the IDATs. */
  before?: Uint8Array[];
  after?: Uint8Array[];
  level?: number;
}

/** A valid 8-bit RGB (3) or RGBA (4) PNG of tightly packed `pixels`. */
export function buildPng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array, options: BuildOptions = {}): Uint8Array {
  const raw = filterScanlines(width, height, channels, pixels, options.filters ?? (() => 0));
  const stream = deflateSync(raw, { level: options.level ?? 6 });
  return png(
    ihdr({ width, height, colorType: channels === 4 ? 6 : 2 }),
    ...(options.before ?? []),
    ...idats(stream, options.split),
    ...(options.after ?? []),
    IEND,
  );
}

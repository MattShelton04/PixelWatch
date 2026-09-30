import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const TESTDATA = join(import.meta.dirname, "..", "..", "..", "testdata");

export function testdata(...parts: string[]): Buffer {
  return readFileSync(join(TESTDATA, ...parts));
}

export function testdataDir(...parts: string[]): string[] {
  return readdirSync(join(TESTDATA, ...parts)).sort();
}

export function chunk(type: string, data: Uint8Array = new Uint8Array(0), crc?: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "latin1");
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc ?? crc32(data, crc32(header.subarray(4, 8))), 0);
  return Buffer.concat([header, data, trailer]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function ihdr(width: number, height: number, bitDepth = 8, colorType = 2, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return chunk("IHDR", data);
}

/** A tiny valid 8-bit RGB PNG, optionally with extra chunks after IHDR. */
export function tinyPng(options: { width?: number; height?: number; before?: Buffer[]; after?: Buffer[] } = {}): Buffer {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const idat = chunk("IDAT", deflateSync(raw));
  return Buffer.concat([PNG_SIGNATURE, ihdr(width, height), ...(options.before ?? []), idat, ...(options.after ?? []), chunk("IEND")]);
}

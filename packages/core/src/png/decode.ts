// Restricted PNG decoder (02 §5; threat-model R4.3-08). chunks.ts checks the structure first,
// so the header is valid before anything image-sized exists. Then one inflate pass streams the
// IDAT data in fixed-size pieces and reconstructs each scanline straight into the output buffer.
//
// The only image-sized allocation is that output (width × height × channels ≤ 64 MiB, sized from
// the checked header). Inflation is held to the exact scanline byte count the header implies, so
// extra data, truncation, bad filter bytes and overflow are refused without ever writing past it.
// Besides the output, memory is the input, at most one copy of the compressed stream (≤ 32 MiB),
// one row and zlib's window.
import { createInflate } from "node:zlib";
import type { RawPixels } from "../pixel-hash.ts";
import { type PngStructure, parsePngStructure } from "./chunks.ts";
import { PngError } from "./errors.ts";

export type { PngHeader } from "./chunks.ts";

/** Inflate output piece size. A bomb is stopped at most one piece past the expected size. */
const INFLATE_CHUNK = 64 * 1024;

export interface DecodeOptions {
  /** Allocates the output buffer. Defaults to `new Uint8Array(n)`; tests use it to observe allocation. */
  readonly allocate?: (bytes: number) => Uint8Array;
}

type RowSink = (filter: number, line: Uint8Array, y: number) => void;

function zlibError(error: unknown): PngError {
  const code = (error as { code?: unknown }).code;
  if (code === "Z_BUF_ERROR") return new PngError("inflate-truncated", "zlib stream ends before its end marker");
  return new PngError("zlib", `invalid zlib data (${typeof code === "string" && /^Z_[A-Z_]{1,20}$/.test(code) ? code : "unknown"})`);
}

/** Streams the IDAT data through zlib, hands each complete scanline to `sink`, and enforces sizes. */
function inflateRows(structure: PngStructure, sink: RowSink): Promise<void> {
  const { header, stream, scanlineBytes } = structure;
  const stride = 1 + header.width * header.channels;
  const row = new Uint8Array(stride);
  let filled = 0;
  let y = 0;
  let produced = 0;
  return new Promise((resolve, reject) => {
    const inflate = createInflate({ chunkSize: INFLATE_CHUNK });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      reject(error instanceof PngError ? error : zlibError(error));
    };
    inflate.on("data", (piece: Buffer) => {
      if (settled) return;
      if (piece.byteLength > scanlineBytes - produced) {
        fail(new PngError("inflate-overflow", `image data inflates past the ${String(scanlineBytes)} bytes the header allows`));
        return;
      }
      produced += piece.byteLength;
      for (let at = 0; at < piece.byteLength; ) {
        const take = Math.min(stride - filled, piece.byteLength - at);
        row.set(piece.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled < stride) break;
        const filter = row[0] as number;
        if (filter > 4) {
          fail(new PngError("filter-type", `filter type ${String(filter)} on row ${String(y)}`));
          return;
        }
        try {
          sink(filter, row.subarray(1), y);
        } catch (error) {
          fail(error);
          return;
        }
        y++;
        filled = 0;
      }
    });
    inflate.on("error", fail);
    inflate.on("end", () => {
      if (settled) return;
      if (produced < scanlineBytes) {
        fail(new PngError("inflate-short", `image data inflates to ${String(produced)} of ${String(scanlineBytes)} bytes`));
      } else if (inflate.bytesWritten !== stream.byteLength) {
        // node:zlib silently ignores input after the stream end; the profile doesn't.
        fail(new PngError("zlib-trailing", `${String(stream.byteLength - inflate.bytesWritten)} bytes after the zlib stream end`));
      } else {
        settled = true;
        resolve();
      }
    });
    inflate.end(stream);
  });
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reconstructs one filtered scanline (PNG spec §9) into `out` at row `y`. */
function unfilter(out: Uint8Array, filter: number, line: Uint8Array, y: number, bpp: number): void {
  const n = line.byteLength;
  const at = y * n;
  const up = at - n;
  switch (filter) {
    case 0:
      out.set(line, at);
      return;
    case 1:
      for (let i = 0; i < n; i++) out[at + i] = ((line[i] as number) + (i >= bpp ? (out[at + i - bpp] as number) : 0)) & 0xff;
      return;
    case 2:
      if (y === 0) out.set(line, at);
      else for (let i = 0; i < n; i++) out[at + i] = ((line[i] as number) + (out[up + i] as number)) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? (out[at + i - bpp] as number) : 0;
        const above = y > 0 ? (out[up + i] as number) : 0;
        out[at + i] = ((line[i] as number) + ((left + above) >>> 1)) & 0xff;
      }
      return;
    default:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? (out[at + i - bpp] as number) : 0;
        const above = y > 0 ? (out[up + i] as number) : 0;
        const corner = y > 0 && i >= bpp ? (out[up + i - bpp] as number) : 0;
        out[at + i] = ((line[i] as number) + paeth(left, above, corner)) & 0xff;
      }
  }
}

/** Decodes a PNG in the restricted profile to tightly packed 8-bit RGB or RGBA. */
export async function decodePng(bytes: Uint8Array, options: DecodeOptions = {}): Promise<RawPixels> {
  const structure = parsePngStructure(bytes);
  const { width, height, channels } = structure.header;
  const data = (options.allocate ?? ((n: number) => new Uint8Array(n)))(width * height * channels);
  await inflateRows(structure, (filter, line, y) => {
    unfilter(data, filter, line, y, channels);
  });
  return { width, height, channels, data };
}

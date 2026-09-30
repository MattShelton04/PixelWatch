// Pixel hash (02 §3): SHA-256 over a domain string, the big-endian dimensions and the image as
// unpremultiplied RGBA8, row-major, with RGB zeroed wherever alpha is 0. RGB input gets alpha
// 255. No premultiplication or colour transforms. Changing this rule needs a new domain (v2).
import { createHash } from "node:crypto";

export const PIXEL_HASH_DOMAIN = "pixelwatch:rgba8:v1\0";

const MAX_DIMENSION = 16383;
const MAX_PIXELS = 16_000_000;
/** Rows hashed per update, so normalization never copies a whole large image. */
const ROWS_PER_CHUNK = 64;

/** Decoded pixels: 8-bit RGB or RGBA, row-major, tightly packed. */
export interface RawPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: Uint8Array;
}

function checkPixels(image: RawPixels): void {
  const { width, height, data } = image;
  // Widened: the type says 3 | 4, but callers can hand in anything at runtime.
  const channels: number = image.channels;
  for (const [name, value] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
      throw new RangeError(`${name} must be an integer 1–${String(MAX_DIMENSION)}`);
    }
  }
  if (width * height > MAX_PIXELS) throw new RangeError(`at most ${String(MAX_PIXELS)} pixels`);
  if (channels !== 3 && channels !== 4) throw new RangeError("channels must be 3 (RGB) or 4 (RGBA)");
  if (data.byteLength !== width * height * channels) {
    throw new RangeError(`expected ${String(width * height * channels)} bytes of pixel data`);
  }
}

/** Normalized RGBA for rows [from, to): alpha 255 for RGB, RGB zeroed under alpha 0. */
function normalizeRows(image: RawPixels, from: number, to: number): Uint8Array {
  const { width, channels, data } = image;
  const out = new Uint8Array((to - from) * width * 4);
  let src = from * width * channels;
  for (let dst = 0; dst < out.length; dst += 4, src += channels) {
    const alpha = channels === 4 ? (data[src + 3] as number) : 255;
    if (alpha !== 0) {
      out[dst] = data[src] as number;
      out[dst + 1] = data[src + 1] as number;
      out[dst + 2] = data[src + 2] as number;
    }
    out[dst + 3] = alpha;
  }
  return out;
}

/** The normalized RGBA the hash covers. comparator-v1 compares these pixels too (delta D1). */
export function normalizeRgba(image: RawPixels): Uint8Array {
  checkPixels(image);
  return normalizeRows(image, 0, image.height);
}

export function pixelHash(image: RawPixels): string {
  checkPixels(image);
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  const hash = createHash("sha256").update(PIXEL_HASH_DOMAIN, "utf8").update(header);
  for (let row = 0; row < image.height; row += ROWS_PER_CHUNK) {
    hash.update(normalizeRows(image, row, Math.min(image.height, row + ROWS_PER_CHUNK)));
  }
  return hash.digest("hex");
}

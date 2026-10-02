// Canonical blob pool (03 §§3–4; threat-model R4.3-09). A blob is the canonical PNG of an image,
// stored at `blobs/<ab>/<pixelHash>.png`. A blob that already exists is reused and never
// overwritten. It isn't read back or decoded: the store is publisher-owned and Git checks its own
// objects, so re-verifying every reused image would only double the decode work of each run.
//
// The core does no I/O: the store adapter (M2.2) supplies the pool, and the codec is the
// in-process one or a PngWorker (which satisfies BlobCodec).
import { type RawPixels, checkPixels, pixelHash } from "./pixel-hash.ts";
import { decodePng } from "./png/decode.ts";
import { encodePng } from "./png/encode.ts";

export interface BlobPool {
  has(path: string): Promise<boolean>;
  /** Adds a blob at a path `has` reported absent. Adapters never overwrite an existing path. */
  add(path: string, bytes: Uint8Array): Promise<void>;
}

export interface BlobCodec {
  decode(bytes: Uint8Array): Promise<RawPixels>;
  encode(image: RawPixels): Uint8Array | Promise<Uint8Array>;
}

export interface StoredBlob {
  readonly pixelHash: string;
  readonly path: string;
  /** True when the blob already existed and was left untouched. */
  readonly reused: boolean;
}

export const IN_PROCESS_CODEC: BlobCodec = { decode: (bytes) => decodePng(bytes), encode: encodePng };
const PIXEL_HASH = /^[0-9a-f]{64}$/;

export function blobPath(hash: string): string {
  if (!PIXEL_HASH.test(hash)) throw new RangeError("a blob name must be a 64-hex pixel hash");
  return `blobs/${hash.slice(0, 2)}/${hash}.png`;
}

/** Stores `image` as a canonical blob unless one with its pixel hash already exists. */
export async function storeBlob(pool: BlobPool, image: RawPixels, codec: BlobCodec = IN_PROCESS_CODEC): Promise<StoredBlob> {
  checkPixels(image);
  const hash = pixelHash(image);
  const path = blobPath(hash);
  if (await pool.has(path)) return { pixelHash: hash, path, reused: true };
  await pool.add(path, await codec.encode(image));
  return { pixelHash: hash, path, reused: false };
}

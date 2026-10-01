// Canonical blob pool (03 §§3–4; threat-model R4.3-09). A blob is the canonical PNG of an image,
// stored at `blobs/<ab>/<pixelHash>.png`. Existing blobs are never overwritten: one with the right
// name is revalidated (bounded decode, pixel hash must equal the name) and reused, and a corrupt
// one is an error. Validity is the decoded pixel hash, not byte equality with today's encoder.
//
// The core does no I/O: the store adapter (M2.2) supplies the pool, and the codec is the
// in-process one or a PngWorker (which satisfies BlobCodec).
import { type RawPixels, checkPixels, pixelHash } from "./pixel-hash.ts";
import { decodePng } from "./png/decode.ts";
import { encodePng } from "./png/encode.ts";
import { PngError } from "./png/errors.ts";

export interface BlobPool {
  read(path: string): Promise<Uint8Array | undefined>;
  /** Creates `path` only if it doesn't exist; reports "exists" instead of overwriting. */
  create(path: string, bytes: Uint8Array): Promise<"created" | "exists">;
}

export interface BlobCodec {
  decode(bytes: Uint8Array): Promise<RawPixels>;
  encode(image: RawPixels): Uint8Array | Promise<Uint8Array>;
}

export interface StoredBlob {
  readonly pixelHash: string;
  readonly path: string;
  /** True when a valid blob already existed and was left untouched. */
  readonly reused: boolean;
}

export type BlobErrorCode = "blob-name" | "blob-corrupt";

export class BlobError extends Error {
  readonly code: BlobErrorCode;

  constructor(code: BlobErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobError";
    this.code = code;
  }
}

const IN_PROCESS: BlobCodec = { decode: (bytes) => decodePng(bytes), encode: encodePng };
const PIXEL_HASH = /^[0-9a-f]{64}$/;

export function blobPath(hash: string): string {
  if (!PIXEL_HASH.test(hash)) throw new BlobError("blob-name", "a blob name must be a 64-hex pixel hash");
  return `blobs/${hash.slice(0, 2)}/${hash}.png`;
}

/** Throws `blob-corrupt` unless `bytes` is an in-profile PNG whose pixel hash is `hash`. */
export async function verifyBlob(hash: string, bytes: Uint8Array, codec: Pick<BlobCodec, "decode"> = IN_PROCESS): Promise<void> {
  const path = blobPath(hash);
  let actual: string;
  try {
    actual = pixelHash(await codec.decode(bytes));
  } catch (error) {
    if (!(error instanceof PngError)) throw error;
    throw new BlobError("blob-corrupt", `${path} is not a valid PNG (${error.code})`, { cause: error });
  }
  if (actual !== hash) throw new BlobError("blob-corrupt", `${path} holds pixels with hash ${actual}`);
}

/** Stores `image` as a canonical blob unless a valid one already exists. Never overwrites. */
export async function storeBlob(pool: BlobPool, image: RawPixels, codec: BlobCodec = IN_PROCESS): Promise<StoredBlob> {
  checkPixels(image);
  const hash = pixelHash(image);
  const path = blobPath(hash);
  const existing = await pool.read(path);
  if (existing === undefined) {
    if ((await pool.create(path, await codec.encode(image))) === "created") return { pixelHash: hash, path, reused: false };
  }
  // It existed, or another writer created it first: whatever is there must match its name.
  const current = existing ?? (await pool.read(path));
  if (current === undefined) throw new BlobError("blob-corrupt", `${path} was reported to exist but can't be read`);
  await verifyBlob(hash, current, codec);
  return { pixelHash: hash, path, reused: true };
}

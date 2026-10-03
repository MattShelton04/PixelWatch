// Every refusal by the PNG codec is a PngError with a stable code. Messages are fixed text plus
// numbers and chunk types the parser already validated as ASCII letters, never input bytes.
import { MAX_ERROR_BYTES } from "./limits.ts";

export type PngErrorCode =
  // Framing (chunks.ts)
  | "too-large"
  | "signature"
  | "truncated"
  | "chunk-length"
  | "chunk-type"
  | "chunk-crc"
  | "ihdr-first"
  | "ihdr-length"
  | "ihdr-duplicate"
  | "iend-length"
  | "trailing-bytes"
  | "idat-missing"
  | "chunk-disallowed"
  // Header fields
  | "dimensions"
  | "too-many-pixels"
  | "color-type"
  | "bit-depth"
  | "compression-method"
  | "filter-method"
  | "interlace"
  // Image data (decode.ts)
  | "zlib"
  | "inflate-truncated"
  | "inflate-short"
  | "inflate-overflow"
  | "zlib-trailing"
  | "filter-type"
  // Encoder input/output (encode.ts)
  | "pixels"
  | "encoded-too-large"
  // Isolation (isolated.ts)
  | "timeout"
  | "aborted"
  | "worker-crash";

const CODES: ReadonlySet<string> = new Set<PngErrorCode>([
  "too-large", "signature", "truncated", "chunk-length", "chunk-type", "chunk-crc",
  "ihdr-first", "ihdr-length", "ihdr-duplicate", "iend-length", "trailing-bytes",
  "idat-missing", "chunk-disallowed", "dimensions", "too-many-pixels", "color-type",
  "bit-depth", "compression-method", "filter-method", "interlace", "zlib",
  "inflate-truncated", "inflate-short", "inflate-overflow", "zlib-trailing", "filter-type",
  "pixels", "encoded-too-large", "timeout", "aborted", "worker-crash",
]);
const identities = new WeakMap<object, PngErrorCode>();
/** Only constructor identity authenticates a code; never inspect injected error fields/prototypes. */
export function pngErrorCode(error: unknown): PngErrorCode | undefined {
  return typeof error === "object" && error !== null ? identities.get(error) : undefined;
}

export class PngError extends Error {
  readonly code: PngErrorCode;
  readonly detail: string;

  constructor(code: PngErrorCode, detail: string) {
    const bounded = Buffer.byteLength(detail) > MAX_ERROR_BYTES - 64 ? `${detail.slice(0, (MAX_ERROR_BYTES - 64) / 4)}…` : detail;
    super(`PNG ${code}: ${bounded}`);
    this.name = "PngError";
    this.code = code;
    this.detail = bounded;
    identities.set(this, CODES.has(code) ? code : "worker-crash");
  }
}

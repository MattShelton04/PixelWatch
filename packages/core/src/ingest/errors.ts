// Every refusal on the ingress path is an IngressError with a stable code (02 §5; ADR 0008).
// Messages are fixed text plus numbers and entry indices, never input bytes or entry names, and
// are bounded like every other ingress diagnostic.
//
// The scope says what a refusal costs. A `part` error rejects one artifact; its valid siblings
// still form an explicitly incomplete run (02 §5). An `ingestion` error refuses the whole
// ingestion: excess work is refused, never published as a partial pass.
import { MAX_ERROR_BYTES } from "../png/limits.ts";

export type ZipErrorCode =
  // Archive framing
  | "zip-archive-too-large"
  | "zip-eocd"
  | "zip-comment"
  | "zip-trailing-bytes"
  | "zip64"
  | "zip-multi-disk"
  | "zip-central-directory"
  // Central records
  | "zip-version"
  | "zip-encrypted"
  | "zip-flags"
  | "zip-method"
  | "zip-extra-field"
  | "zip-host"
  | "zip-link"
  | "zip-special-file"
  | "zip-entry-too-large"
  | "zip-size-mismatch"
  // Names
  | "zip-name-empty"
  | "zip-name-encoding"
  | "zip-name-nul"
  | "zip-name-absolute"
  | "zip-name-drive"
  | "zip-name-traversal"
  | "zip-name-separator"
  | "zip-name-dot"
  | "zip-duplicate-name"
  | "zip-name-collision"
  | "zip-name-not-allowed"
  | "zip-bundle-missing"
  // Layout
  | "zip-leading-bytes"
  | "zip-header-mismatch"
  | "zip-out-of-range"
  | "zip-data-descriptor"
  | "zip-overlap"
  | "zip-gap"
  // Entry data
  | "zip-inflate-overflow"
  | "zip-inflate-short"
  | "zip-deflate"
  | "zip-deflate-truncated"
  | "zip-deflate-trailing"
  | "zip-crc"
  | "zip-entry-missing";

export type PartErrorCode =
  | "part-duplicate"
  | "part-bundle-invalid"
  | "part-identity"
  | "part-file-missing"
  | "part-extra-file"
  | "part-image-invalid"
  | "part-conflict";

export type IngestionErrorCode =
  | "zip-too-many-entries"
  | "zip-expanded-total"
  | "ingest-compressed-total"
  | "ingest-too-many-artifacts"
  | "ingest-too-many-units"
  | "ingest-aborted"
  | "ingest-codec";

export type IngressErrorCode = ZipErrorCode | PartErrorCode | IngestionErrorCode;

const INGESTION_CODES: ReadonlySet<IngressErrorCode> = new Set<IngestionErrorCode>([
  "zip-too-many-entries",
  "zip-expanded-total",
  "ingest-compressed-total",
  "ingest-too-many-artifacts",
  "ingest-too-many-units",
  "ingest-aborted",
  "ingest-codec",
]);

export class IngressError extends Error {
  readonly code: IngressErrorCode;
  readonly scope: "part" | "ingestion";
  readonly detail: string;

  constructor(code: IngressErrorCode, detail: string, options?: ErrorOptions) {
    const bounded = Buffer.byteLength(detail) > MAX_ERROR_BYTES - 64 ? `${detail.slice(0, (MAX_ERROR_BYTES - 64) / 4)}…` : detail;
    super(`${code}: ${bounded}`, options);
    this.name = "IngressError";
    this.code = code;
    this.scope = INGESTION_CODES.has(code) ? "ingestion" : "part";
    this.detail = bounded;
  }
}

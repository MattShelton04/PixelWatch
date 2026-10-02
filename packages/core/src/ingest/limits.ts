// 02 §5 ingress limits and the per-ingestion budget. Raising a limit needs a measured memory
// bound (docs/evidence/m1.4-ingest-bench.md), never a disabled check.
import { MAX_PNG_BYTES } from "../png/limits.ts";
import { IngressError } from "./errors.ts";

const MiB = 1024 * 1024;

export const INGEST_LIMITS = Object.freeze({
  /** One artifact, compressed (02 §5 "Artifact download"). */
  maxArchiveBytes: 128 * MiB,
  /** All selected artifacts of one source attempt, compressed. */
  maxCompressedBytes: 256 * MiB,
  /** ZIP entries per ingestion, across every archive. */
  maxEntries: 4096,
  /** Expanded bytes per ingestion: declared entry sizes, which extraction holds inflation to. */
  maxExpandedBytes: 512 * MiB,
  /** `bundle.json` (02 §5 JSON limit). */
  maxJsonBytes: 1 * MiB,
  /** One PNG entry (02 §5 PNG size). */
  maxPngBytes: MAX_PNG_BYTES,
  /** Declared units per ingestion (02 §5, run@1 `results`). */
  maxUnits: 2000,
  /** Artifacts handed to one ingestion (selected or not). */
  maxArtifacts: 1024,
  /** 02 §5 "Work": hard timeout per ingestion. */
  timeoutMs: 10 * 60 * 1000,
});

/**
 * The shared entry/byte budget of one ingestion. Archives draw from it as they are opened, so
 * the limits hold across all of an attempt's parts, not per archive.
 */
export class IngestBudget {
  entries = 0;
  expandedBytes = 0;
  compressedBytes = 0;

  addEntries(count: number): void {
    if (count > INGEST_LIMITS.maxEntries - this.entries) {
      throw new IngressError("zip-too-many-entries", `more than ${String(INGEST_LIMITS.maxEntries)} ZIP entries in one ingestion`);
    }
    this.entries += count;
  }

  addExpanded(bytes: number): void {
    if (bytes > INGEST_LIMITS.maxExpandedBytes - this.expandedBytes) {
      throw new IngressError("zip-expanded-total", `entries expand past ${String(INGEST_LIMITS.maxExpandedBytes)} bytes in one ingestion`);
    }
    this.expandedBytes += bytes;
  }

  addCompressed(bytes: number): void {
    if (bytes > INGEST_LIMITS.maxCompressedBytes - this.compressedBytes) {
      throw new IngressError("ingest-compressed-total", `selected artifacts exceed ${String(INGEST_LIMITS.maxCompressedBytes)} bytes in one ingestion`);
    }
    this.compressedBytes += bytes;
  }
}

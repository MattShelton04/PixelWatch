// Inputs and outputs of ingestion (M1.4; 02 §§5–6; ADR 0008). M1.5 builds runs from an
// Ingestion; `unitResult(identity, unit.base, unit.head, comparison?)` gives each result.
import type { Claims, Config, Coverage, Geometry, Labels, Revision, Shard, Side } from "@pixelwatch/schemas";
import type { BlobCodec, BlobPool } from "../blob-pool.ts";
import type { IngressErrorCode } from "./errors.ts";

export interface ArtifactInput {
  /** The artifact name the GitHub API listed. Untrusted text. */
  readonly artifactName: string;
  /** API-returned artifact ID (GitHub numeric ID string). */
  readonly artifactId: string;
  /** The downloaded archive. Not modified; keep it unchanged until ingestion finishes. */
  readonly zip: Uint8Array;
}

/** "none": the envelope has no baseline revision (01 §4.4, e.g. an initial commit). */
export type Baseline = "expected" | "none";

export interface IngestInput {
  /** config@1 from the recorded default-branch commit, already validated by parseDocument("config", bytes). */
  readonly config: Config;
  /** The authenticated source attempt. */
  readonly attempt: string;
  readonly baseline: Baseline;
  readonly artifacts: readonly ArtifactInput[];
  /** Canonical blobs are written here (03 §§3–4); existing ones are reused, never overwritten. */
  readonly pool: BlobPool;
  /** Defaults to the in-process codec; the publisher passes a PngWorker. */
  readonly codec?: BlobCodec;
  readonly signal?: AbortSignal;
}

export interface PartKey {
  readonly revision: Revision;
  readonly providerId: string;
  readonly shard: Shard;
}

export interface ArtifactRef {
  /** API-returned artifact ID. A completed attempt's artifacts don't change, so the ID identifies the bytes. */
  readonly artifactId: string;
}

export interface Diagnostic {
  readonly code: IngressErrorCode;
  /** Bounded (≤ 2048 bytes); fixed text and numbers, never input bytes. */
  readonly message: string;
}

/** Untrusted unit details, already bounded by bundle@1. */
export interface UnitDetails {
  readonly labels?: Labels;
  readonly notes?: readonly string[];
  readonly geometry?: Geometry;
  readonly message?: string;
}

/** The state a valid part lists for one unit, with images already decoded and stored. */
export type ListedSide = Extract<Side, { state: "captured" | "absent" | "failed" }>;

export interface PartUnit {
  readonly viewId: string;
  readonly variantId: string;
  readonly side: ListedSide;
  readonly details: UnitDetails;
}

export interface ValidPart extends PartKey {
  readonly artifact: ArtifactRef;
  readonly claims: Claims;
  readonly units: readonly PartUnit[];
}

export interface RejectedPart extends PartKey {
  /** Every artifact received under this part's name; two or more for duplicate names. */
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostic: Diagnostic;
}

export interface MergedUnit {
  readonly providerId: string;
  readonly viewId: string;
  readonly variantId: string;
  /** Exactly what unitResult consumes. */
  readonly base: Side;
  readonly head: Side;
  readonly details: { readonly base?: UnitDetails; readonly head?: UnitDetails };
}

export type PartStatus = "valid" | "rejected" | "not-received";

export interface PartReport extends PartKey {
  readonly status: PartStatus;
  /** None when not received; two or more when several artifacts had this part's name. */
  readonly artifacts: readonly ArtifactRef[];
  /** Valid parts only. Absent means unknown, never zero. */
  readonly unitCount?: number;
  /** Valid parts only; M1.5 aggregates them per revision and provider. */
  readonly claims?: Claims;
  readonly diagnostic?: Diagnostic;
}

export type IgnoredReason =
  | "not-pixelwatch"
  | "unsupported-bundle-version"
  | "malformed-name"
  | "other-attempt"
  | "unexpected-part"
  | "base-not-expected";

export interface IgnoredArtifact {
  readonly artifactId: string;
  /** Bounded, control characters replaced. Untrusted text. */
  readonly name: string;
  readonly reason: IgnoredReason;
}

export interface UnitKey {
  readonly providerId: string;
  readonly viewId: string;
  readonly variantId: string;
}

export interface Excluded {
  /** Units listed absent on both sides (or absent with no baseline): not units (02 §4). */
  readonly count: number;
  /** The first keys in unit order, at most 16. */
  readonly sample: readonly UnitKey[];
}

export interface Ingestion {
  readonly attempt: string;
  /** Sorted by (providerId, viewId, variantId); at most 2000. */
  readonly units: readonly MergedUnit[];
  /** missingParts carry no unit count: a missing catalog's size is unknown. */
  readonly coverage: Coverage;
  /** Every expected part, sorted by revision (base first), providerId, shard index. */
  readonly parts: readonly PartReport[];
  /** Sorted by numeric artifact ID; at most 256, the rest counted in ignoredOverflow. */
  readonly ignored: readonly IgnoredArtifact[];
  readonly ignoredOverflow: number;
  readonly excluded: Excluded;
}

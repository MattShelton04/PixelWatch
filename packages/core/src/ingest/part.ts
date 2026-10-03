// One selected part, validated on its own (02 §§5–6): the archive, bundle.json, identity against
// the name, the authenticated attempt and the trusted config, the file set, and every captured
// image through the bounded decoder. Any failure throws an IngressError. Part-scope errors
// reject only this part; ingestion-scope errors (budgets, cancellation, codec isolation) refuse
// the whole ingestion.
//
// Image admission is the only place uploaded PNG bytes are used (ADR 0008). Each captured image
// is decoded, hashed and stored as a canonical blob here; later stages see only the pixel hash
// and the dimensions from decoding, never the uploaded file or the manifest's claims.
import { type Bundle, type BundleUnit, type Config, parseDocument, unitFileName } from "@pixelwatch/schemas";
import { type BlobCodec, type BlobPool, storeBlob } from "../blob-pool.ts";
import type { RawPixels } from "../pixel-hash.ts";
import { pngErrorCode } from "../png/errors.ts";
import { IngressError } from "./errors.ts";
import type { IngestBudget } from "./limits.ts";
import type { SelectedPart } from "./select.ts";
import type { ArtifactRef, ListedSide, PartUnit, UnitDetails, ValidPart } from "./types.ts";
import { type ZipArchive, openZip, readEntry } from "./zip.ts";

export interface PartContext {
  readonly config: Config;
  readonly attempt: string;
  readonly budget: IngestBudget;
  readonly pool: BlobPool;
  readonly codec: BlobCodec;
  readonly signal?: AbortSignal | undefined;
}

/** PngWorker failures that say nothing about the image: they refuse the ingestion. */
const ISOLATION_CODES = new Set(["timeout", "aborted", "worker-crash"]);

function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9/_-]/g, "?").slice(0, 200) || "/";
}

async function readBundle(archive: ZipArchive, signal: AbortSignal | undefined): Promise<Bundle> {
  const parsed = parseDocument("bundle", await readEntry(archive, "bundle.json", { signal }));
  if (parsed.ok) return parsed.value;
  const { code, path } = parsed.issue;
  if (code === "unsupported-version") throw new IngressError("ingest-unsupported-version", "selected bundle schema version is unsupported; use a compatible publisher");
  // Issue messages can quote input (unknown property names); only the code and a sanitized path are kept.
  throw new IngressError("part-bundle-invalid", `bundle.json is invalid (${code.replace(/[^a-z0-9-]/g, "?")} at ${safePath(path)})`);
}

function checkIdentity(bundle: Bundle, part: SelectedPart, attempt: string): void {
  const { key } = part;
  const mismatches = [
    bundle.attempt !== attempt && "attempt",
    bundle.revision !== key.revision && "revision",
    bundle.providerId !== key.providerId && "providerId",
    (bundle.shard.index !== key.shard.index || bundle.shard.count !== key.shard.count) && "shard",
  ].filter((m): m is string => m !== false);
  if (mismatches.length > 0) {
    throw new IngressError("part-identity", `bundle.json ${mismatches.join(", ")} disagrees with the artifact name or the authenticated attempt`);
  }
}

function checkFiles(bundle: Bundle, archive: ZipArchive): void {
  const listed = new Set(bundle.units.flatMap((u) => (u.state === "captured" ? [unitFileName(u)] : [])));
  const present = new Set(archive.entries.map((e) => e.name).filter((n) => n !== "bundle.json"));
  const missing = [...listed].filter((f) => !present.has(f)).length;
  if (missing > 0) throw new IngressError("part-file-missing", `${String(missing)} captured units have no image in the archive`);
  const extra = [...present].filter((f) => !listed.has(f)).length;
  if (extra > 0) throw new IngressError("part-extra-file", `${String(extra)} images in the archive belong to no captured unit`);
}

function detailsOf(unit: BundleUnit): UnitDetails {
  return {
    ...(unit.labels === undefined ? {} : { labels: unit.labels }),
    ...(unit.notes === undefined ? {} : { notes: unit.notes }),
    ...(unit.state === "captured" && unit.geometry !== undefined ? { geometry: unit.geometry } : {}),
    ...(unit.state === "failed" && unit.message !== undefined ? { message: unit.message } : {}),
  };
}

async function admitImage(archive: ZipArchive, file: string, index: number, ctx: PartContext): Promise<ListedSide> {
  const bytes = await readEntry(archive, file, { signal: ctx.signal });
  let image: RawPixels;
  try {
    image = await ctx.codec.decode(bytes);
  } catch (error) {
    const code = pngErrorCode(error);
    if (code === undefined) throw new IngressError("ingest-codec", "the PNG decoder failed");
    if (ISOLATION_CODES.has(code)) throw new IngressError("ingest-codec", `the PNG worker failed (${code})`);
    throw new IngressError("part-image-invalid", `unit ${String(index)}'s image is outside the PNG profile (${code})`);
  }
  if (ctx.signal?.aborted === true) throw new IngressError("ingest-aborted", "ingestion cancelled");
  try {
    const stored = await storeBlob(ctx.pool, image, ctx.codec);
    return { state: "captured", pixelHash: stored.pixelHash, width: image.width, height: image.height };
  } catch (error) {
    const code = pngErrorCode(error);
    throw new IngressError("ingest-codec", code === undefined ? "the canonical blob operation failed" : `the PNG worker failed while encoding (${code})`);
  }
}

export interface PreparedPart {
  readonly part: SelectedPart;
  readonly artifact: ArtifactRef;
  readonly archive: ZipArchive;
  readonly bundle: Bundle;
}

/** Validate each selected manifest before any sibling's pixels reach the blob pool. */
export async function preparePart(part: SelectedPart, artifact: ArtifactRef, ctx: PartContext): Promise<PreparedPart> {
  const archive = openZip(part.artifact.zip, ctx.budget, { signal: ctx.signal });
  const bundle = await readBundle(archive, ctx.signal);
  checkIdentity(bundle, part, ctx.attempt);
  checkFiles(bundle, archive);
  return { part, artifact, archive, bundle };
}

export async function admitPart(prepared: PreparedPart, ctx: PartContext): Promise<ValidPart> {
  const { part, artifact, archive, bundle } = prepared;
  const ordered = [...bundle.units].sort((a, b) => (a.viewId === b.viewId ? (a.variantId < b.variantId ? -1 : 1) : a.viewId < b.viewId ? -1 : 1));
  const units: PartUnit[] = [];
  for (const [index, unit] of ordered.entries()) {
    if (ctx.signal?.aborted === true) throw new IngressError("ingest-aborted", "ingestion cancelled");
    let side: ListedSide;
    if (unit.state === "captured") side = await admitImage(archive, unitFileName(unit), index, ctx);
    else if (unit.state === "absent") side = { state: "absent", reason: unit.reason };
    else side = { state: "failed", category: unit.category };
    units.push({ viewId: unit.viewId, variantId: unit.variantId, side, details: detailsOf(unit) });
  }
  return { ...part.key, artifact, claims: bundle.claims, units };
}

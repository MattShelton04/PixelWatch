// PropertyScope capture output → bundle@1. Input format from MattShelton04/41026ASDProject
// scripts/visual/capture.py at 6378d8be5b1f418f72279e04b3de23d761b426d3 (ADR 0001):
// `capture-<provider>.json` plus `<case id>.png`, one part per revision and provider.
import type { Revision } from "../generated/types.ts";
import {
  type CaseRecord,
  ConversionError,
  type ConvertedBundle,
  asObject,
  asString,
  asStrings,
  buildBundle,
  ifString,
  parseManifest,
  prototypeClaims,
  revisionOf,
} from "./bundle.ts";

export interface PropertyScopeInput {
  /** Bytes of `capture-<provider>.json`. */
  readonly manifest: Uint8Array | string;
  /** Capture files by name (`<case id>.png`). Other files are ignored. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  /** `github.run_attempt` of the capture run. */
  readonly attempt: string;
  /** If given, the manifest must be for this revision. */
  readonly revision?: Revision;
  /** If given, the manifest must be for this provider. */
  readonly providerId?: string;
  /** View IDs the captured revision's own case inventory declares (ADR 0003). */
  readonly revisionCatalog?: Iterable<string>;
}

export function convertPropertyScope(input: PropertyScopeInput): ConvertedBundle {
  const manifest = parseManifest(input.manifest, "PropertyScope capture manifest");
  if (manifest["schema"] !== 1) throw new ConversionError("unsupported PropertyScope capture manifest schema");
  const revision = revisionOf(manifest["revision"]);
  if (input.revision !== undefined && input.revision !== revision) {
    throw new ConversionError(`manifest is for ${revision}, expected ${input.revision}`);
  }
  const providerId = asString(manifest["provider"]);
  if (providerId === undefined) throw new ConversionError("manifest has no provider");
  if (input.providerId !== undefined && input.providerId !== providerId) {
    throw new ConversionError(`manifest is for provider ${providerId}, expected ${input.providerId}`);
  }
  if (!Array.isArray(manifest["cases"])) throw new ConversionError("manifest has no case list");

  const cases: CaseRecord[] = manifest["cases"].map((value, i) => {
    const row = asObject(value);
    const id = asString(row?.["id"]);
    if (row === undefined || id === undefined) throw new ConversionError(`case ${String(i)} has no ID`);
    if (row["provider"] !== undefined && row["provider"] !== providerId) {
      throw new ConversionError(`case ${id} belongs to a different provider`);
    }
    return {
      id,
      status: asString(row["status"]) ?? "unknown",
      errors: asStrings(row["errors"]),
      notes: asStrings(row["notes"]),
      labels: {
        ...ifString("group", row["section"]),
        ...ifString("state", row["state"]),
        ...ifString("route", row["path"]),
      },
    };
  });

  return buildBundle({
    producer: { name: "propertyscope", version: "capture-schema-1" },
    revision,
    providerId,
    attempt: input.attempt,
    shard: { index: 1, count: 1 },
    claims: prototypeClaims(manifest),
    cases,
    images: input.images,
    revisionCatalog: input.revisionCatalog,
  });
}

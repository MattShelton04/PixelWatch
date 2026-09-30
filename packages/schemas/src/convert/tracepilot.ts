// TracePilot capture output → bundle@1. Input format from MattShelton04/TracePilot
// scripts/visual/capture.mjs at 067cfcde85581920d358699c7f6d37b6a6caea2d (ADR 0001):
// `capture-<index>-<count>.json` plus `<case id>.png`, one part per revision and shard.
// TracePilot has one capture source, so it has one provider.
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

export const TRACEPILOT_PROVIDER_ID = "fixture";

export interface TracePilotInput {
  /** Bytes of `capture-<index>-<count>.json`. */
  readonly manifest: Uint8Array | string;
  /** Capture files by name (`<case id>.png`). Failed cases' diagnostic PNGs are ignored. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  /** `github.run_attempt` of the capture run. */
  readonly attempt: string;
  /** If given, the manifest must be for this revision. */
  readonly revision?: Revision;
  /** View IDs the captured revision's own case inventory declares (ADR 0003). */
  readonly revisionCatalog?: Iterable<string>;
}

export function convertTracePilot(input: TracePilotInput): ConvertedBundle {
  const manifest = parseManifest(input.manifest, "TracePilot capture manifest");
  if (manifest["schema"] !== 1) throw new ConversionError("unsupported TracePilot capture manifest schema");
  const revision = revisionOf(manifest["revision"]);
  if (input.revision !== undefined && input.revision !== revision) {
    throw new ConversionError(`manifest is for ${revision}, expected ${input.revision}`);
  }
  const shardMatch = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(asString(manifest["shard"]) ?? "");
  const shard = { index: Number(shardMatch?.[1]), count: Number(shardMatch?.[2]) };
  if (shardMatch === null || shard.index > shard.count) throw new ConversionError("manifest shard must be <index>/<count>");
  if (!Array.isArray(manifest["cases"])) throw new ConversionError("manifest has no case list");

  const cases: CaseRecord[] = manifest["cases"].map((value, i) => {
    const row = asObject(value);
    const id = asString(row?.["id"]);
    if (row === undefined || id === undefined) throw new ConversionError(`case ${String(i)} has no ID`);
    const missing = Array.isArray(row["missingFixtures"])
      ? row["missingFixtures"].map((f) => `missing fixture: ${asString(asObject(f)?.["command"]) ?? "unknown command"}`)
      : [];
    const status = asString(row["status"]) ?? "unknown";
    return {
      id,
      // The prototype marks a capture with missing fixtures incomplete; keep that even if a
      // manifest says otherwise.
      status: status === "captured" && missing.length > 0 ? "incomplete" : status,
      errors: [...asStrings(row["errors"]), ...missing],
      notes: [],
      labels: {
        ...ifString("group", row["group"]),
        ...ifString("state", row["state"]),
        ...ifString("route", row["route"]),
      },
    };
  });

  return buildBundle({
    producer: { name: "tracepilot", version: "capture-schema-1" },
    revision,
    providerId: TRACEPILOT_PROVIDER_ID,
    attempt: input.attempt,
    shard,
    claims: prototypeClaims(manifest),
    cases,
    images: input.images,
    revisionCatalog: input.revisionCatalog,
  });
}

// Shared bundle@1 builder for the prototype converters (02 §2). Runs on the untrusted capture
// side. Pure: inputs are bytes and maps, output is the artifact's files.
import { canonicalBytes } from "../canonical.ts";
import type { Bundle, BundleUnit, Claims, FailedCategory, Labels, Revision, Shard } from "../generated/types.ts";
import { formatArtifactName, isGitHubId, isId, unitFileName } from "../ids.ts";
import { type JsonValue, parseJson } from "../json.ts";
import { boundLabel, boundMessage } from "../text.ts";
import { validateDocument } from "../validate.ts";
import { normalizePng } from "./png-profile.ts";

/** The variant when a caller doesn't name one: both prototypes capture one desktop setting (ADR 0003). */
export const DEFAULT_VARIANT_ID = "desktop";
export const MAX_UNITS = 2000;

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

/** One prototype capture record, reduced to what the bundle needs. */
export interface CaseRecord {
  readonly id: string;
  /** The prototype's own status: "captured", "failed", "incomplete", or anything else. */
  readonly status: string;
  readonly errors: readonly string[];
  readonly labels: Labels;
  readonly notes: readonly string[];
}

export interface BuildInput {
  readonly producer: Bundle["producer"];
  readonly revision: Revision;
  readonly providerId: string;
  readonly attempt: string;
  readonly shard: Shard;
  readonly claims: Claims;
  readonly cases: readonly CaseRecord[];
  /** Capture files by name, e.g. `shared-home.png`. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  /** View IDs the captured revision's own case inventory declares (ADR 0003). */
  readonly revisionCatalog?: Iterable<string> | undefined;
  /**
   * The capture setting these screenshots were taken with (e.g. `desktop`, `mobile-390`). Convert
   * each viewport or theme separately under its own variant. Defaults to DEFAULT_VARIANT_ID.
   */
  readonly variantId?: string | undefined;
}

export interface ConvertedBundle {
  /** The 02 §6 artifact name to upload under. */
  readonly artifactName: string;
  readonly bundle: Bundle;
  /** Every file of the artifact: `bundle.json` plus one `<viewId>.<variantId>.png` per captured unit. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

function failedCategory(status: string): FailedCategory {
  if (status === "failed") return "capture-error";
  if (status === "incomplete") return "capture-incomplete";
  return "unknown";
}

function withBoundedLabels(labels: Labels): Labels | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const bounded = typeof value === "string" ? boundLabel(value) : undefined;
    if (bounded !== undefined) out[key] = bounded;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildBundle(input: BuildInput): ConvertedBundle {
  if (!isId(input.providerId)) throw new ConversionError(`invalid provider ID ${JSON.stringify(input.providerId)}`);
  if (!isGitHubId(input.attempt)) throw new ConversionError("attempt must be a GitHub run attempt (decimal, no leading zeros)");
  if (input.cases.length > MAX_UNITS) throw new ConversionError(`more than ${String(MAX_UNITS)} cases`);
  const variantId = input.variantId ?? DEFAULT_VARIANT_ID;
  if (!isId(variantId)) throw new ConversionError(`invalid variant ID ${JSON.stringify(variantId.slice(0, 80))}`);
  const catalog = input.revisionCatalog === undefined ? undefined : new Set(input.revisionCatalog);
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  const units: BundleUnit[] = [];

  for (const record of input.cases) {
    if (!isId(record.id)) throw new ConversionError(`case ID ${JSON.stringify(record.id.slice(0, 80))} is not a valid view ID`);
    if (seen.has(record.id)) throw new ConversionError(`case ${record.id} appears twice`);
    seen.add(record.id);
    const common = {
      viewId: record.id,
      variantId,
      ...optional("labels", withBoundedLabels(record.labels)),
      ...optional("notes", boundedList(record.notes)),
    };
    const firstError = record.errors.map((e) => boundMessage(e)).find((e) => e !== undefined);

    if (record.status === "captured") {
      const png = input.images.get(`${record.id}.png`);
      if (png === undefined) {
        units.push({ ...common, state: "failed", category: "image-missing", message: "screenshot missing from the capture output" });
        continue;
      }
      const normalized = normalizePng(png);
      if (!normalized.ok) {
        units.push({ ...common, state: "failed", category: "image-invalid", message: `screenshot rejected: ${normalized.reason}` });
        continue;
      }
      files.set(unitFileName(common), normalized.png);
      units.push({ ...common, state: "captured" });
    } else if (catalog !== undefined && !catalog.has(record.id)) {
      // Explicit catalog absence: the revision itself doesn't declare this view.
      units.push({ ...common, state: "absent", reason: "not-in-revision-catalog" });
    } else {
      units.push({ ...common, state: "failed", category: failedCategory(record.status), ...optional("message", firstError) });
    }
  }

  units.sort((a, b) => (a.viewId < b.viewId ? -1 : a.viewId > b.viewId ? 1 : 0));
  const bundle: Bundle = {
    schemaVersion: 1,
    revision: input.revision,
    providerId: input.providerId,
    attempt: input.attempt,
    shard: { index: input.shard.index, count: input.shard.count },
    producer: input.producer,
    claims: input.claims,
    units,
  };
  const validation = validateDocument("bundle", bundle);
  if (!validation.ok) throw new ConversionError(`converted bundle is invalid: ${validation.issue.message}`);
  files.set("bundle.json", canonicalBytes(bundle));
  const artifactName = formatArtifactName({
    attempt: input.attempt,
    revision: input.revision,
    providerId: input.providerId,
    shard: input.shard,
  });
  return { artifactName, bundle, files };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function boundedList(values: readonly string[]): [string, ...string[]] | undefined {
  const out = values.map((v) => boundMessage(v)).filter((v): v is string => v !== undefined).slice(0, 8);
  return out.length > 0 ? (out as [string, ...string[]]) : undefined;
}

// Helpers for reading prototype manifests: bounded, typed access to untrusted JSON.

export function parseManifest(input: Uint8Array | string, what: string): Record<string, JsonValue> {
  let value: JsonValue;
  try {
    value = parseJson(input);
  } catch (error) {
    throw new ConversionError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConversionError(`${what} must be a JSON object`);
  }
  return value;
}

export function asObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function ifString<K extends string>(key: K, value: JsonValue | undefined): { [P in K]?: string } {
  return (typeof value === "string" ? { [key]: value } : {}) as { [P in K]?: string };
}

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A claimed commit SHA: absent/null is allowed, anything else must be a Git OID. */
function claimedSha(value: JsonValue | undefined, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !GIT_OID.test(value)) throw new ConversionError(`${what} is not a Git commit SHA`);
  return value;
}

function claimedViewport(value: JsonValue | undefined): Claims["environment"] {
  const viewport = asObject(value);
  const width = viewport?.["width"];
  const height = viewport?.["height"];
  const valid = (n: JsonValue | undefined): n is number => typeof n === "number" && n >= 1 && n <= 16383;
  return valid(width) && valid(height) ? { viewport: { width, height } } : {};
}

/** The claims both prototypes' manifests make: commits, viewport and frozen clock. */
export function prototypeClaims(manifest: Record<string, JsonValue>): Claims {
  const revisionSha = claimedSha(manifest["revisionSha"], "revisionSha");
  const harnessSha = claimedSha(manifest["harnessSha"], "harnessSha");
  const fixedTime = boundLabel(asString(manifest["fixedTime"]) ?? "");
  return {
    ...(revisionSha === undefined ? {} : { revisionSha }),
    ...(harnessSha === undefined ? {} : { harnessSha }),
    environment: { ...claimedViewport(manifest["viewport"]), ...(fixedTime === undefined ? {} : { fixedTime }) },
  };
}

export function revisionOf(value: JsonValue | undefined): Revision {
  if (value === "base" || value === "head") return value;
  throw new ConversionError('manifest revision must be "base" or "head"');
}

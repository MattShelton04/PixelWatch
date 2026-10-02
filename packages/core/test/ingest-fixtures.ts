// Test-side builders for ingestion tests (M1.4): configs, bundle.json documents, part archives in
// upload-artifact's layout, tiny PNGs and an in-memory blob pool. Archives and PNGs come from the
// independent writers under tools/, never from the code under test.
import {
  type Bundle,
  type BundleUnit,
  type Config,
  type Revision,
  canonicalBytes,
  formatArtifactName,
  unitFileName,
  validateDocument,
} from "@pixelwatch/schemas";
import { buildPng } from "../../../tools/png-corpus/png-builder.ts";
import { type EntrySpec, buildZip } from "../../../tools/zip-corpus/zip-builder.ts";
import type { BlobPool } from "../src/blob-pool.ts";
import type { ArtifactInput, ListedSide, PartUnit, ValidPart } from "../src/ingest/types.ts";

export const VARIANT = "desktop";

export function config(providers: readonly (readonly [string, number])[]): Config {
  const value = {
    schemaVersion: 1,
    source: { workflowIds: ["101"], events: ["pull_request", "push"] },
    providers: providers.map(([id, shards]) => ({ id, shards })),
  };
  const checked = validateDocument("config", value);
  if (!checked.ok) throw new Error(`fixture config is invalid: ${checked.issue.message}`);
  return checked.value;
}

/** A 2×2 (or w×h) RGB PNG whose pixels depend on `seed`. */
export function tinyPng(seed: number, width = 2, height = 2): Uint8Array {
  const pixels = Uint8Array.from({ length: width * height * 3 }, (_, i) => (seed * 37 + i * 11) & 0xff);
  return buildPng(width, height, 3, pixels);
}

export type UnitSpec =
  | { readonly viewId: string; readonly state: "captured"; readonly png?: Uint8Array; readonly variantId?: string }
  | { readonly viewId: string; readonly state: "absent"; readonly variantId?: string }
  | { readonly viewId: string; readonly state: "failed"; readonly variantId?: string };

export interface PartSpec {
  readonly attempt?: string;
  readonly revision: Revision;
  readonly providerId: string;
  readonly shard: readonly [number, number];
  readonly units: readonly UnitSpec[];
}

export function bundleFor(spec: PartSpec): Bundle {
  const units: BundleUnit[] = spec.units.map((u) => {
    const variantId = u.variantId ?? VARIANT;
    if (u.state === "captured") return { viewId: u.viewId, variantId, state: "captured" };
    if (u.state === "absent") return { viewId: u.viewId, variantId, state: "absent", reason: "not-in-revision-catalog" };
    return { viewId: u.viewId, variantId, state: "failed", category: "capture-error", message: "boom" };
  });
  return {
    schemaVersion: 1,
    revision: spec.revision,
    providerId: spec.providerId,
    attempt: spec.attempt ?? "1",
    shard: { index: spec.shard[0], count: spec.shard[1] },
    producer: { name: "test", version: "1" },
    claims: {},
    units,
  };
}

export function nameFor(spec: PartSpec): string {
  return formatArtifactName({
    attempt: spec.attempt ?? "1",
    revision: spec.revision,
    providerId: spec.providerId,
    shard: { index: spec.shard[0], count: spec.shard[1] },
  });
}

export interface ZipOptions {
  /** Replaces bundle.json's bytes. */
  readonly bundleBytes?: Uint8Array;
  /** Changes the bundle before it is serialized. */
  readonly edit?: (bundle: Bundle) => unknown;
  readonly extra?: readonly EntrySpec[];
  readonly drop?: readonly string[];
  /** Reorders the entries (bundle.json first otherwise). */
  readonly order?: (entries: EntrySpec[]) => EntrySpec[];
}

export function partZip(spec: PartSpec, options: ZipOptions = {}): Uint8Array {
  const bundle = bundleFor(spec);
  const document = options.edit === undefined ? bundle : options.edit(structuredClone(bundle));
  let entries: EntrySpec[] = [{ name: "bundle.json", data: options.bundleBytes ?? canonicalBytes(document) }];
  spec.units.forEach((u, i) => {
    if (u.state !== "captured") return;
    const name = unitFileName({ viewId: u.viewId, variantId: u.variantId ?? VARIANT });
    entries.push({ name, data: u.png ?? tinyPng(i + 1) });
  });
  entries.push(...(options.extra ?? []));
  entries = entries.filter((e) => !(options.drop ?? []).includes(e.name as string));
  return buildZip({ entries: options.order === undefined ? entries : options.order(entries) });
}

let nextId = 1000;
export function artifact(spec: PartSpec, options: ZipOptions & { id?: string; name?: string } = {}): ArtifactInput {
  return { artifactName: options.name ?? nameFor(spec), artifactId: options.id ?? String(nextId++), zip: partZip(spec, options) };
}

export function memoryPool(): BlobPool & { readonly blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    has: (path) => Promise.resolve(blobs.has(path)),
    add: (path, bytes) => {
      blobs.set(path, bytes);
      return Promise.resolve();
    },
  };
}

// Pure merge inputs.

export function captured(hash: string, width = 2, height = 2): ListedSide {
  return { state: "captured", pixelHash: hash, width, height };
}

export const ABSENT: ListedSide = { state: "absent", reason: "not-in-revision-catalog" };
export const FAILED: ListedSide = { state: "failed", category: "capture-error" };

export function validPart(
  revision: Revision,
  providerId: string,
  shard: readonly [number, number],
  units: readonly (readonly [string, ListedSide])[],
  artifactId = String(nextId++),
): ValidPart {
  const partUnits: PartUnit[] = units.map(([viewId, side]) => ({ viewId, variantId: VARIANT, side, details: {} }));
  return { revision, providerId, shard: { index: shard[0], count: shard[1] }, artifact: { artifactId }, claims: {}, units: partUnits };
}

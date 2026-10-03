// Store-tree and served-tree paths (03 §3). Generated from run keys, PR numbers, stream IDs and
// hashes only, never from labels. Served paths are relative to the site prefix.
import { isGitHubId, parseRunKey } from "@pixelwatch/schemas";

/** The data namespace store@1 writes (`dataVersion` 1). */
export const DATA_NAMESPACE = "data/v1";
export const STORE_INDEX = "store.json";

const SHA256 = /^[0-9a-f]{64}$/;
const STREAM_ID = /^(?:main|pr-[1-9][0-9]{0,18})$/;

function runKey(key: string): string {
  if (parseRunKey(key) === undefined) throw new RangeError("not a run key");
  return key;
}

export function runRecordPath(key: string): string {
  return `${DATA_NAMESPACE}/runs/${runKey(key)}/run.json`;
}

export function derivedPath(hash: string): string {
  if (!SHA256.test(hash)) throw new RangeError("a derived file name must be a 64-hex byte hash");
  return `derived/${hash.slice(0, 2)}/${hash}.png`;
}

export function streamPath(streamId: string): string {
  if (!STREAM_ID.test(streamId)) throw new RangeError("not a stream ID");
  return `${DATA_NAMESPACE}/streams/${streamId}.json`;
}

export function changesPath(key: string): string {
  return `api/v1/runs/${runKey(key)}/changes.json`;
}

export function permalinkPath(key: string): string {
  return `runs/${runKey(key)}/index.html`;
}

export function prPointerPath(prNumber: string): string {
  if (!isGitHubId(prNumber)) throw new RangeError("not a PR number");
  return `api/v1/pr/${prNumber}/latest.json`;
}

// Files emitted once per site (03 §3, ADR 0013).
export const ENTRY_PAGE = "index.html";
export const SITE_JSON = "site.json";
export const LLMS_TXT = "llms.txt";
export const API_INDEX = "api/v1/index.json";

/** The JSON Schemas served for the agent API, so llms.txt can link them (ADR 0013). */
export const API_SCHEMA_KINDS = ["api-index", "changes", "pr-pointer", "stream"] as const;
export type ApiSchemaKind = (typeof API_SCHEMA_KINDS)[number];

export function apiSchemaPath(kind: ApiSchemaKind): string {
  if (!(API_SCHEMA_KINDS as readonly string[]).includes(kind)) throw new RangeError("not a served schema");
  return `api/v1/schemas/${kind}-1.json`;
}

const RELEASE = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})(?:-[0-9A-Za-z.]{1,32})?$/;

/** A common.json ReleaseVersion, e.g. `0.1.0` or `0.1.0-rc.1`. */
export function isReleaseVersion(value: string): boolean {
  return RELEASE.test(value);
}

/** The pinned release's app script (04 §1). Its bytes come from the release, never the store. */
export function appScriptPath(release: string): string {
  if (!isReleaseVersion(release)) throw new RangeError("not a release version");
  return `app/${release}/app.js`;
}

export type StorePath =
  | { readonly kind: "index" }
  | { readonly kind: "run"; readonly runKey: string }
  | { readonly kind: "blob" }
  | { readonly kind: "derived" }
  | { readonly kind: "grace"; readonly namespace: string };

const RUN_RECORD = /^data\/v1\/runs\/([^/]+)\/run\.json$/;
const POOLED = /^(blobs|derived)\/([0-9a-f]{2})\/([0-9a-f]{64})\.png$/;
const OTHER_NAMESPACE = /^(data\/v[1-9][0-9]{0,8})\/(.+)$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH = 1024;

/** A data namespace other than the current one: `data/v<N>`, N ≥ 1, N ≠ 1. */
export function isOtherNamespace(namespace: string): boolean {
  return /^data\/v[1-9][0-9]{0,8}$/.test(namespace) && namespace !== DATA_NAMESPACE;
}

/** Classifies a store-tree path by the 03 §3 layout; undefined for anything else. */
export function classifyStorePath(path: string): StorePath | undefined {
  if (path.length > MAX_PATH) return undefined;
  if (path === STORE_INDEX) return { kind: "index" };
  const record = RUN_RECORD.exec(path);
  if (record) {
    const key = record[1] ?? "";
    return parseRunKey(key) === undefined ? undefined : { kind: "run", runKey: key };
  }
  const pooled = POOLED.exec(path);
  if (pooled) {
    const [, pool, fan, hash = ""] = pooled;
    if (fan !== hash.slice(0, 2)) return undefined;
    return pool === "blobs" ? { kind: "blob" } : { kind: "derived" };
  }
  const other = OTHER_NAMESPACE.exec(path);
  if (other) {
    const [, namespace = "", rest = ""] = other;
    // An older data namespace holds JSON records only; anything else is never served or deleted.
    if (namespace === DATA_NAMESPACE || !rest.endsWith(".json") || !rest.split("/").every((s) => SEGMENT.test(s))) return undefined;
    return { kind: "grace", namespace };
  }
  return undefined;
}


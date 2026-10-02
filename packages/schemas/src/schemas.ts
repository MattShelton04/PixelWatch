// Loads the JSON Schema files and inlines common.json into each one, so every schema is
// self-contained: no remote `$ref`, nothing fetched, one `$defs` namespace per document kind.
import bundle from "../schemas/bundle-1.json" with { type: "json" };
import changes from "../schemas/changes-1.json" with { type: "json" };
import common from "../schemas/common.json" with { type: "json" };
import config from "../schemas/config-1.json" with { type: "json" };
import run from "../schemas/run-1.json" with { type: "json" };
import site from "../schemas/site-1.json" with { type: "json" };
import store from "../schemas/store-1.json" with { type: "json" };
import stream from "../schemas/stream-1.json" with { type: "json" };

export const DOCUMENT_KINDS = ["bundle", "config", "store", "run", "stream", "site", "changes"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Schema versions this release reads, per kind. Anything else is refused before use. */
export const SUPPORTED_VERSIONS: Readonly<Record<DocumentKind, readonly number[]>> = {
  bundle: [1],
  config: [1],
  store: [1],
  run: [1],
  stream: [1],
  site: [1],
  changes: [1],
};

type SchemaObject = Record<string, unknown>;

const SOURCES: Readonly<Record<DocumentKind, unknown>> = {
  bundle,
  config,
  store,
  run,
  stream,
  site,
  changes,
};

const COMMON_PREFIX = "common.json#/$defs/";

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (typeof node !== "object" || node === null) return node;
  const out: SchemaObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(COMMON_PREFIX)) {
      out[key] = `#/$defs/${value.slice(COMMON_PREFIX.length)}`;
    } else {
      out[key] = rewriteRefs(value);
    }
  }
  return out;
}

function inline(kind: DocumentKind): SchemaObject {
  const source = rewriteRefs(SOURCES[kind]) as SchemaObject;
  const commonDefs = (common as { $defs: SchemaObject }).$defs;
  const ownDefs = (source["$defs"] ?? {}) as SchemaObject;
  for (const name of Object.keys(ownDefs)) {
    if (Object.hasOwn(commonDefs, name)) throw new Error(`${kind} schema redefines common $defs/${name}`);
  }
  return { ...source, $defs: { ...structuredClone(commonDefs), ...ownDefs } };
}

const INLINED = new Map<DocumentKind, SchemaObject>(DOCUMENT_KINDS.map((kind) => [kind, inline(kind)]));

/** A fresh copy of the self-contained schema for one document kind. */
export function schemaFor(kind: DocumentKind): SchemaObject {
  const schema = INLINED.get(kind);
  if (schema === undefined) throw new Error(`unknown document kind ${kind}`);
  return structuredClone(schema);
}

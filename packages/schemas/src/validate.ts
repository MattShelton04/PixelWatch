// Validation entry points. Order: bounded strict parse → version dispatch → JSON Schema →
// semantic invariants. The first problem is reported; nothing is repaired or defaulted.
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { Bundle, Changes, Config, Run, Site, Snapshot, Store, Stream } from "./generated/types.ts";
import { DEFAULT_JSON_LIMITS, JsonError, type JsonErrorCode, type JsonLimits, parseJson } from "./json.ts";
import { DOCUMENT_KINDS, type DocumentKind, SUPPORTED_VERSIONS, schemaFor } from "./schemas.ts";
import { SEMANTIC_CHECKS, checkGeneric } from "./semantic.ts";
import { boundMessage } from "./text.ts";

export interface DocumentTypes {
  bundle: Bundle;
  config: Config;
  store: Store;
  run: Run;
  snapshot: Snapshot;
  stream: Stream;
  site: Site;
  changes: Changes;
}

export type IssueCode = JsonErrorCode | "unsupported-version" | "schema" | (string & {});

export interface Issue {
  readonly code: IssueCode;
  /** JSON Pointer into the document; "" is the root. */
  readonly path: string;
  /** Bounded, human-readable. Never echoes large input. */
  readonly message: string;
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: Issue };

const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  discriminator: true,
  validateFormats: false,
  unicodeRegExp: true,
});

const validators = new Map<DocumentKind, ValidateFunction>(
  DOCUMENT_KINDS.map((kind) => [kind, ajv.compile(schemaFor(kind))]),
);

function fail(code: IssueCode, path: string, message: string): { ok: false; issue: Issue } {
  return { ok: false, issue: { code, path, message: boundMessage(message) ?? code } };
}

function short(value: unknown): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function describeSchemaError(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return `unknown property ${short(params["additionalProperty"])}`;
    case "required":
      return `missing property ${short(params["missingProperty"])}`;
    case "const":
      return `must be ${short(params["allowedValue"])}`;
    case "enum":
      return `must be one of ${short(params["allowedValues"])}`;
    default:
      return error.message ?? error.keyword;
  }
}

/** Validates an already-parsed value. Prefer parseDocument for untrusted bytes (duplicate keys). */
export function validateDocument<K extends DocumentKind>(kind: K, value: unknown): Validation<DocumentTypes[K]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("schema", "", `${kind} must be a JSON object`);
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (!Number.isSafeInteger(version)) {
    return fail("schema", "/schemaVersion", `${kind} needs an integer schemaVersion`);
  }
  const supported = SUPPORTED_VERSIONS[kind];
  if (!supported.includes(version as number)) {
    return fail(
      "unsupported-version",
      "/schemaVersion",
      `${kind} schemaVersion ${String(version)} is not supported by this PixelWatch release ` +
        `(supported: ${supported.join(", ")}). Use a release that supports it, or produce ${kind}@${String(supported.at(-1))}.`,
    );
  }
  const validate = validators.get(kind);
  if (validate === undefined) throw new Error(`no validator for ${kind}`);
  if (!validate(value)) {
    const error = validate.errors?.[0];
    if (error === undefined) return fail("schema", "", `${kind} is invalid`);
    return fail("schema", error.instancePath, `${error.instancePath || "/"}: ${describeSchemaError(error)}`);
  }
  const check = SEMANTIC_CHECKS[kind] as (doc: unknown) => ReturnType<typeof checkGeneric>;
  const problem = checkGeneric(value) ?? check(value);
  if (problem) return fail(problem.code, problem.path, `${problem.path || "/"}: ${problem.message}`);
  return { ok: true, value: value as DocumentTypes[K] };
}

/** Strictly parses untrusted bytes, then validates them as one document kind. */
export function parseDocument<K extends DocumentKind>(
  kind: K,
  input: Uint8Array | string,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): Validation<DocumentTypes[K]> {
  let value: unknown;
  try {
    value = parseJson(input, limits);
  } catch (error) {
    if (error instanceof JsonError) return fail(error.code, "", error.message);
    throw error;
  }
  return validateDocument(kind, value);
}

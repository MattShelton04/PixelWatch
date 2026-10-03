// Browser-safe strict validation. No runtime schema compilation or Node dependencies.
import { validateChanges, validateSite } from "./generated/viewer-validators.js";
import { JsonError, parseJson } from "./json.ts";
import { checkGeneric, SEMANTIC_CHECKS } from "./semantic.ts";
import type { DocumentTypes, Validation } from "./validate.ts";

export type ViewerDocumentKind = "site" | "changes";
export type { Changes, Site } from "./generated/types.ts";
export { GITHUB_ID_PATTERN, SHA256_PATTERN, parseRunKey } from "./ids.ts";
export { parseJson } from "./json.ts";
export { boundLabel, boundMessage, utf8Length } from "./text.ts";

export function parseViewerDocument<K extends ViewerDocumentKind>(kind: K, input: Uint8Array | string): Validation<DocumentTypes[K]> {
  let value: unknown;
  try { value = parseJson(input); }
  catch (error) {
    if (error instanceof JsonError) return { ok: false, issue: { code: error.code, path: "", message: "Invalid report JSON." } };
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, issue: { code: "schema", path: "", message: "Invalid report document." } };
  }
  const version: unknown = (value as { schemaVersion?: unknown }).schemaVersion;
  if (!Number.isSafeInteger(version)) return { ok: false, issue: { code: "schema", path: "/schemaVersion", message: "Missing report version." } };
  if (version !== 1) return { ok: false, issue: { code: "unsupported-version", path: "/schemaVersion", message: "This report needs a supported PixelWatch release. Reload or upgrade." } };
  const validate: (input: unknown) => boolean = kind === "site" ? validateSite : validateChanges;
  if (!validate(value)) return { ok: false, issue: { code: "schema", path: "", message: "Invalid report document." } };
  const typed = value as DocumentTypes[K];
  const check = SEMANTIC_CHECKS[kind] as (input: typeof typed) => ReturnType<typeof checkGeneric>;
  const problem = checkGeneric(typed) ?? check(typed);
  if (problem !== undefined) return { ok: false, issue: { code: problem.code, path: problem.path, message: "Inconsistent report document." } };
  return { ok: true, value: typed };
}

// Trusted config parsing (02 §10; ADR 0009): restricted YAML → config@1. The YAML subset runs
// first (a version can't be read from a document that doesn't parse), then validateDocument,
// which reports an unknown schemaVersion before any schema or semantic problem. Every failure
// stops before any store write, deployment or comment. The one exception is a malformed `theme`,
// an optional presentation setting: it is dropped with a warning and the default preset applies.
import { type Config, type Issue, type JsonObject, validateDocument } from "@pixelwatch/schemas";
import { YAML_LIMITS, YamlError, type YamlLimits, parseYamlSubset } from "./yaml.ts";

export interface ConfigWarning {
  readonly code: "theme-fallback";
  readonly path: string;
  readonly message: string;
}

export type ConfigParse =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly ConfigWarning[] }
  | { readonly ok: false; readonly issue: Issue };

/** Presentation settings that may fall back to their default. Nothing else ever does. */
const FALLBACK_KEYS = ["theme"] as const;

export function parseConfig(input: Uint8Array, limits: YamlLimits = YAML_LIMITS): ConfigParse {
  let value: unknown;
  try {
    value = parseYamlSubset(input, limits);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, issue: { code: error.code, path: "", message: error.message } };
    throw error;
  }
  const checked = validateDocument("config", value);
  if (checked.ok) return { ok: true, config: checked.value, warnings: [] };
  const key = FALLBACK_KEYS.find((k) => checked.issue.path === `/${k}` || checked.issue.path.startsWith(`/${k}/`));
  if (key === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, issue: checked.issue };
  const rest = Object.fromEntries(Object.entries(value as JsonObject).filter(([k]) => k !== key));
  const retried = validateDocument("config", rest);
  if (!retried.ok) return { ok: false, issue: retried.issue };
  const warning: ConfigWarning = { code: "theme-fallback", path: checked.issue.path, message: `${checked.issue.message}; using the default theme` };
  return { ok: true, config: retried.value, warnings: [warning] };
}

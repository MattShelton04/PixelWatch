/** Safe public diagnostics: never retain a raw URL, body, transport exception or cause. */
export type ForgeErrorCode =
  | "invalid-identity" | "invalid-response" | "request-failed" | "request-cancelled"
  | "response-too-large" | "retry-exhausted" | "api-refused" | "pagination-limit"
  | "artifact-not-listed" | "artifact-budget" | "invalid-redirect" | "redirect-limit"
  | "comment-ambiguous" | "comment-body" | "comment-body-rejected" | "comment-outcome" | "comment-guard-failed" | "pages-metadata"
  | "invalid-config" | "unsupported-config-version" | "source-policy" | "source-mismatch";

const DIAGNOSTIC_CODES = new Set<ForgeErrorCode>([
  "invalid-identity", "invalid-response", "request-failed", "request-cancelled", "response-too-large",
  "retry-exhausted", "api-refused", "pagination-limit", "artifact-not-listed", "artifact-budget",
  "invalid-redirect", "redirect-limit", "comment-ambiguous", "comment-body", "comment-body-rejected", "comment-outcome",
  "comment-guard-failed", "pages-metadata", "invalid-config", "unsupported-config-version", "source-policy", "source-mismatch",
]);
const diagnosticIdentity = new WeakMap<object, ForgeErrorCode | undefined>();

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  constructor(code: ForgeErrorCode) {
    const known = typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : undefined;
    const safe = known ?? "request-failed";
    super(`GitHub adapter: ${safe}`);
    this.name = "ForgeError";
    this.code = safe;
    diagnosticIdentity.set(this, known);
  }
}

/** Recapture private provenance before reading any callback-owned diagnostic fields. */
export function sanitizeForgeError(error: unknown, fallback: ForgeErrorCode): ForgeError {
  const known = typeof error === "object" && error !== null ? diagnosticIdentity.get(error) : undefined;
  return new ForgeError(known ?? (DIAGNOSTIC_CODES.has(fallback) ? fallback : "request-failed"));
}

export const LIMITS = Object.freeze({
  maxJsonBytes: 1024 * 1024,
  maxArtifacts: 1024,
  maxArtifactBytes: 128 * 1024 * 1024,
  maxAttemptBytes: 256 * 1024 * 1024,
  maxComments: 1024,
  maxCommentBytes: 60_000,
  requestMs: 60_000,
  maxAttempts: 3,
  maxRedirects: 3,
  maxRetryDelayMs: 60_000,
});

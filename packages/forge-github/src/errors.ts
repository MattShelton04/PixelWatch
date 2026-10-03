/** Safe public diagnostics: never retain a raw URL, body, transport exception or cause. */
export type ForgeErrorCode =
  | "invalid-identity" | "invalid-response" | "request-failed" | "request-cancelled"
  | "response-too-large" | "retry-exhausted" | "api-refused" | "pagination-limit"
  | "artifact-not-listed" | "artifact-budget" | "invalid-redirect" | "redirect-limit"
  | "comment-ambiguous" | "comment-body" | "comment-outcome" | "comment-guard-failed" | "pages-metadata"
  | "invalid-config" | "unsupported-config-version" | "source-policy" | "source-mismatch";

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  constructor(code: ForgeErrorCode) {
    super(`GitHub adapter: ${code}`);
    this.name = "ForgeError";
    this.code = code;
  }
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

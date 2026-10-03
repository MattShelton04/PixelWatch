// Every refusal in projection is a ProjectionError with a stable code (ADR 0013). Nothing is
// repaired or defaulted: a refused projection returns no files.
export type ProjectionErrorCode =
  /** The site location, a served path or a final URL fails validation (01 §4.6, 05 §4). */
  | "invalid-site"
  /** A run, store, config, generation or release that is malformed or doesn't fit the others. */
  | "invalid-input";

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectionError";
    this.code = code;
  }
}

export function refuse(code: ProjectionErrorCode, message: string): never {
  throw new ProjectionError(code, message);
}

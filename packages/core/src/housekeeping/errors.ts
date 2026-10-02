// Every refusal in retention, budget and GC planning is a HousekeepingError with a stable code
// (03 §5; ADR 0012). A refusal never narrows into deletion: the plan isn't returned at all.
export type HousekeepingErrorCode =
  /** A malformed argument: policy, limits, time, PR states, pins, listing entries, sizes, keep sets. */
  | "invalid-input"
  /** A store-tree path outside the 03 §3 layout. Unknown files are never deleted. */
  | "unrecognized-path"
  /** A run record without an index entry, or a data namespace without a grace record. */
  | "orphan-file"
  /** An index entry without its run record, or a referenced blob or derived file that isn't there. */
  | "missing-file"
  /** A retained run whose record wasn't supplied. */
  | "missing-run-data"
  /** A supplied run record that disagrees with its index entry. */
  | "run-mismatch"
  /** Derived-file references were supplied, but not for a run that needs them. */
  | "unknown-references";

export class HousekeepingError extends Error {
  readonly code: HousekeepingErrorCode;

  constructor(code: HousekeepingErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HousekeepingError";
    this.code = code;
  }
}

export function refuse(code: HousekeepingErrorCode, message: string): never {
  throw new HousekeepingError(code, message);
}

const TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

/** A common.json Timestamp (whole-second UTC). Fixed width, so timestamps compare as strings. */
export function checkTimestamp(value: string, what: string): string {
  if (!TIMESTAMP.test(value)) refuse("invalid-input", `${what} must be a whole-second UTC timestamp`);
  return value;
}

/** A byte count: a non-negative safe integer. */
export function checkBytes(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) refuse("invalid-input", `${what} must be a non-negative integer byte count`);
  return value;
}

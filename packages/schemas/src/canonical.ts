// Canonical JSON for hashing (02 §3): UTF-8, object keys sorted recursively by Unicode code
// point, no whitespace, safe integers only, arrays in order, no Unicode normalization. Tests pin
// exact bytes and hashes.
import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** Orders strings by code point (UTF-8 byte order), not by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done === true) return q.done === true ? 0 : -1;
    if (q.done === true) return 1;
    const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new CanonicalJsonError(`${path}: only safe integers are allowed, got ${String(value)}`);
      }
      return String(value);
    case "string":
      if (!value.isWellFormed()) throw new CanonicalJsonError(`${path}: string contains a lone surrogate`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not JSON`);
  }
  if (ancestors.has(value)) throw new CanonicalJsonError(`${path}: cyclic value`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new CanonicalJsonError(`${path}/${String(i)}: sparse array`);
        items.push(serialize(value[i], `${path}/${String(i)}`, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`${path}: only plain objects are allowed`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodePoints);
    const members = keys.map((key) => {
      if (!key.isWellFormed()) throw new CanonicalJsonError(`${path}: key contains a lone surrogate`);
      return `${JSON.stringify(key)}:${serialize(record[key], `${path}/${key}`, ancestors)}`;
    });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "", new Set());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

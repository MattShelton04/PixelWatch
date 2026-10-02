import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalBytes,
  canonicalJson,
  canonicalSha256,
  compareCodePoints,
} from "../src/canonical.ts";

// Vectors computed independently with Python:
// json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + hashlib.sha256.
const MIXED = {
  b: 1,
  a: [true, null, "x", -5, 0],
  A: { z: 'q"\\/\n\t\u0000\u001f\u007f ', y: {} },
  "é": [],
  "Ａ": 1,
  "\u{1F600}": 2,
};
const MIXED_CANONICAL =
  '{"A":{"y":{},"z":"q\\"\\\\/\\n\\t\\u0000\\u001f\u007f "},"a":[true,null,"x",-5,0],"b":1,"é":[],"Ａ":1,"\u{1F600}":2}';

describe("canonical JSON (02 §3)", () => {
  it("pins exact bytes and hash for keys, escapes and non-ASCII", () => {
    expect(canonicalJson(MIXED)).toBe(MIXED_CANONICAL);
    expect(canonicalBytes(MIXED).byteLength).toBe(103);
    expect(canonicalSha256(MIXED)).toBe("2f3a4cb829218d3f5c3ad9eab647e336d4adb3c5e2f3b0156e47ba2cdfc618dc");
  });

  it("sorts keys by code point, not UTF-16 code unit", () => {
    // U+FF21 < U+1F600 by code point, but its UTF-16 unit 0xFF21 > the surrogate 0xD83D.
    expect(compareCodePoints("Ａ", "\u{1F600}")).toBeLessThan(0);
    expect(canonicalJson({ "\u{1F600}": 1, "Ａ": 2 })).toBe('{"Ａ":2,"\u{1F600}":1}');
  });

  it("rejects anything that isn't finite-integer JSON", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 2 ** 53, undefined, 1n, () => 1, Symbol("x")]) {
      expect(() => canonicalJson({ v: bad }), String(bad)).toThrow(CanonicalJsonError);
    }
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
    // eslint-disable-next-line no-sparse-arrays -- the point of the test
    expect(() => canonicalJson([1, , 2])).toThrow(CanonicalJsonError);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it("is independent of key insertion order and reparses to the same value (property)", () => {
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.maxSafeInteger().filter((n) => !Object.is(n, -0)),
        fc.string({ unit: "grapheme" }),
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(fc.string({ unit: "grapheme" }), tie("node"), { maxKeys: 5 }),
      ),
    })).node;
    const reversed = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reversed);
      if (typeof v !== "object" || v === null) return v;
      return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)]));
    };
    fc.assert(
      fc.property(value, (v) => {
        const text = canonicalJson(v);
        expect(canonicalJson(reversed(v))).toBe(text);
        expect(JSON.parse(text)).toEqual(v);
        expect(text).not.toMatch(/^\s|\s$/);
      }),
      { numRuns: 300 },
    );
  });
});

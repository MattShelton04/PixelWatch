import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JsonError, type JsonErrorCode, parseJson } from "../src/json.ts";

function code(input: Uint8Array | string, limits?: Parameters<typeof parseJson>[1]): JsonErrorCode | "ok" {
  try {
    parseJson(input, limits);
    return "ok";
  } catch (error) {
    if (error instanceof JsonError) return error.code;
    throw error;
  }
}

describe("parseJson", () => {
  it("parses ordinary integer JSON like JSON.parse", () => {
    const text = '{"a":[1,-2,0,true,false,null,"x\\u00e9\\n\\"\\/"],"b":{"c":{}},"d":[]}';
    expect(parseJson(text)).toEqual(JSON.parse(text));
  });

  it("rejects duplicate keys, including nested and escaped spellings", () => {
    expect(code('{"a":1,"a":2}')).toBe("json-duplicate-key");
    expect(code('{"x":{"a":1,"b":{"c":1,"c":1}}}')).toBe("json-duplicate-key");
    expect(code('{"a":1,"\\u0061":2}')).toBe("json-duplicate-key");
    expect(code('[{"a":1},{"a":2}]')).toBe("ok");
  });

  it("rejects prototype-pollution keys anywhere", () => {
    expect(code('{"__proto__":{"x":1}}')).toBe("json-unsafe-key");
    expect(code('{"a":[{"constructor":{}}]}')).toBe("json-unsafe-key");
    expect(code('{"prototype":1}')).toBe("json-unsafe-key");
    expect(code('{"\\u005f_proto__":1}')).toBe("json-unsafe-key");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("allows only safe integers", () => {
    expect(code("1.5")).toBe("json-number");
    expect(code("1e3")).toBe("json-number");
    expect(code("1.0")).toBe("json-number");
    expect(code("-0")).toBe("json-number");
    expect(code("9007199254740992")).toBe("json-number");
    expect(parseJson("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(code("01")).toBe("json-syntax");
    expect(code("NaN")).toBe("json-syntax");
    expect(code("Infinity")).toBe("json-syntax");
  });

  it("enforces the size and depth limits", () => {
    expect(code("[1]", { maxBytes: 2, maxDepth: 32 })).toBe("json-too-large");
    expect(code(new Uint8Array(3).fill(0x20), { maxBytes: 2, maxDepth: 32 })).toBe("json-too-large");
    expect(code("[".repeat(32) + "]".repeat(32))).toBe("ok");
    expect(code("[".repeat(33) + "]".repeat(33))).toBe("json-too-deep");
    expect(code('{"a":'.repeat(33) + "1" + "}".repeat(33))).toBe("json-too-deep");
  });

  it("rejects a BOM, invalid UTF-8 and lone surrogates", () => {
    expect(code(Uint8Array.of(0xef, 0xbb, 0xbf, 0x31))).toBe("json-encoding");
    expect(code(Uint8Array.of(0x22, 0xc3, 0x28, 0x22))).toBe("json-encoding");
    expect(code(Uint8Array.of(0x22, 0xed, 0xa0, 0x80, 0x22))).toBe("json-encoding");
    expect(code('"\\ud800"')).toBe("json-encoding");
    expect(code('"\\udc00"')).toBe("json-encoding");
    expect(code('"\\ud800\\u0041"')).toBe("json-encoding");
    expect(parseJson('"\\ud83d\\ude00"')).toBe("\u{1F600}");
  });

  it("rejects malformed syntax", () => {
    for (const bad of ["", "{", '{"a"}', '{"a":1,}', "[1,]", "'a'", '"a\u0001"', '"\\x41"', "tru", "1 2", '{"a":1}x']) {
      expect(code(bad), bad).toBe("json-syntax");
    }
  });

  it("matches JSON.parse on arbitrary integer-only JSON (property)", () => {
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.maxSafeInteger().filter((n) => !Object.is(n, -0)),
        fc.string({ unit: "grapheme" }),
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(
          fc.string().filter((k) => !["__proto__", "constructor", "prototype"].includes(k)),
          tie("node"),
          { maxKeys: 4 },
        ),
      ),
    })).node;
    fc.assert(
      fc.property(value, fc.boolean(), (v, pretty) => {
        const text = JSON.stringify(v, null, pretty ? 2 : undefined);
        expect(parseJson(Buffer.from(text, "utf8"))).toEqual(JSON.parse(text));
      }),
      { numRuns: 300 },
    );
  });
});

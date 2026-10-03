import { Buffer } from "node:buffer";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { JsonError, parseJson } from "../src/json.ts";
import { utf8Length } from "../src/text.ts";

it("matches UTF-8 replacement length for every UTF-16 unit and seeded surrogate sequences", () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    const text = String.fromCharCode(unit);
    expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
  }
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 128 }), (units) => {
    const text = String.fromCharCode(...units);
    expect(utf8Length(text)).toBe(Buffer.byteLength(text, "utf8"));
  }), { seed: 20261003, numRuns: 2000 });
});

it("bounds and parses Unicode JSON without a browser Buffer global", () => {
  vi.stubGlobal("Buffer", undefined);
  try {
    expect(utf8Length("Aé中😀\ud800")).toBe(13);
    expect(parseJson('"😀"', { maxBytes: 6, maxDepth: 1 })).toBe("😀");
    expect(() => parseJson('"😀"', { maxBytes: 5, maxDepth: 1 })).toThrow(JsonError);
    expect(() => parseJson('"\ud800"')).toThrow(JsonError);
  } finally { vi.unstubAllGlobals(); }
});

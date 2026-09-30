// Every schema × valid/invalid fixtures from testdata/schemas. Invalid fixtures are named
// `<expected issue code>.<description>.json`.
import { describe, expect, it } from "vitest";
import { DOCUMENT_KINDS } from "../src/schemas.ts";
import { parseDocument, validateDocument } from "../src/validate.ts";
import { testdata, testdataDir } from "./helpers.ts";

describe.each(DOCUMENT_KINDS)("%s@1", (kind) => {
  const valid = testdataDir("schemas", kind, "valid");
  const invalid = testdataDir("schemas", kind, "invalid");

  it("has valid fixtures and invalid fixtures, including an unknown version", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.some((name) => name.startsWith("unsupported-version."))).toBe(true);
    expect(invalid.some((name) => name.startsWith("schema."))).toBe(true);
  });

  it.each(valid)("accepts valid/%s", (name) => {
    const result = parseDocument(kind, testdata("schemas", kind, "valid", name));
    expect(result.ok ? "ok" : result.issue).toBe("ok");
  });

  it.each(invalid)("rejects invalid/%s with the expected code", (name) => {
    const expected = name.split(".")[0];
    const result = parseDocument(kind, testdata("schemas", kind, "invalid", name));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code, result.issue.message).toBe(expected);
      expect(Buffer.byteLength(result.issue.message)).toBeLessThanOrEqual(2048);
    }
  });
});

describe("cross-cutting rules", () => {
  it("rejects duplicate keys and unsafe keys for every kind", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(parseDocument(kind, '{"schemaVersion":1,"schemaVersion":1}')).toMatchObject({ ok: false, issue: { code: "json-duplicate-key" } });
      expect(parseDocument(kind, '{"schemaVersion":1,"__proto__":null}')).toMatchObject({ ok: false, issue: { code: "json-unsafe-key" } });
    }
  });

  it("reports an unknown version before looking at anything else", () => {
    const result = parseDocument("bundle", '{"schemaVersion":7,"whatever":true}');
    expect(result).toMatchObject({ ok: false, issue: { code: "unsupported-version", path: "/schemaVersion" } });
    if (!result.ok) expect(result.issue.message).toMatch(/bundle schemaVersion 7 is not supported.*bundle@1/);
  });

  it("rejects non-objects and missing versions", () => {
    expect(validateDocument("run", [])).toMatchObject({ ok: false, issue: { code: "schema" } });
    expect(validateDocument("run", { schemaVersion: "1" })).toMatchObject({ ok: false, issue: { code: "schema" } });
  });

  it("names the unknown property without echoing large input", () => {
    const result = validateDocument("stream", { schemaVersion: 1, streamId: "main", runs: [], latest: null, ["x".repeat(5000)]: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.message).toMatch(/unknown property/);
      expect(result.issue.message.length).toBeLessThan(200);
    }
  });
});

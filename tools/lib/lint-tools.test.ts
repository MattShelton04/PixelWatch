import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadManifest, sha256Hex, toolNames, verifySha256 } from "./lint-tools.ts";

describe("pinned lint tool manifest", () => {
  it("pins HTTPS GitHub release assets with SHA-256 digests for CI's platforms", () => {
    const manifest = loadManifest();
    for (const name of toolNames) {
      const tool = manifest[name];
      expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.keys(tool.assets)).toEqual(expect.arrayContaining(["linux-x64", "win32-x64"]));
      for (const asset of Object.values(tool.assets)) {
        expect(asset?.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\//);
        expect(asset?.url).toContain(tool.version);
        expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("verifySha256", () => {
  it("accepts the exact bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (data) => {
        expect(() => {
          verifySha256(data, sha256Hex(data), "sample");
        }).not.toThrow();
      }),
    );
  });

  it("rejects any single-byte change or truncation", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (data, position, flip) => {
          const expected = sha256Hex(data);
          const index = position % data.length;
          const mutated = Uint8Array.from(data);
          mutated[index] = (mutated[index] ?? 0) ^ flip;
          expect(() => {
            verifySha256(mutated, expected, "sample");
          }).toThrow(/mismatch/);
          expect(() => {
            verifySha256(data.subarray(0, index), expected, "sample");
          }).toThrow(/mismatch/);
        },
      ),
    );
  });

  it("rejects a malformed pin", () => {
    expect(() => {
      verifySha256(new Uint8Array(), "ABC", "sample");
    }).toThrow(/64 lowercase hex/);
  });
});

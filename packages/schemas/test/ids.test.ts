import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareGitHubIds,
  compareUnitKeys,
  formatArtifactName,
  formatRunKey,
  parseArtifactName,
  parseRunKey,
  type PartIdentity,
} from "../src/ids.ts";

describe("artifact names (02 §6)", () => {
  it("formats and parses the part identity", () => {
    const part: PartIdentity = { attempt: "2", revision: "head", providerId: "fixture", shard: { index: 1, count: 2 } };
    expect(formatArtifactName(part)).toBe("pixelwatch-b1-a2-head-fixture-s1-of2");
    expect(parseArtifactName("pixelwatch-b1-a2-head-fixture-s1-of2")).toEqual(part);
  });

  it("parses providers that contain hyphens or shard-like text unambiguously", () => {
    expect(parseArtifactName("pixelwatch-b1-a1-base-my-app-s1-of1")?.providerId).toBe("my-app");
    expect(parseArtifactName("pixelwatch-b1-a1-base-x-s1-of2-s2-of3")).toEqual({
      attempt: "1",
      revision: "base",
      providerId: "x-s1-of2",
      shard: { index: 2, count: 3 },
    });
  });

  it("rejects invalid names", () => {
    for (const name of [
      "pixelwatch-b1-a01-head-fixture-s1-of1", // leading zero attempt
      "pixelwatch-b1-a0-head-fixture-s1-of1",
      "pixelwatch-b1-a1-head-fixture-s0-of1",
      "pixelwatch-b1-a1-head-fixture-s2-of1", // index above count
      "pixelwatch-b1-a1-head-fixture-s1-of65", // above the shard limit
      "pixelwatch-b1-a1-head-fixture-s01-of2",
      "pixelwatch-b1-a1-main-fixture-s1-of1",
      "pixelwatch-b1-a1-head-Fixture-s1-of1",
      "pixelwatch-b2-a1-head-fixture-s1-of1",
      "pixelwatch-b1-a1-head-fixture-s1-of1.zip",
      "visual-head-fixture",
    ]) {
      expect(parseArtifactName(name), name).toBeUndefined();
    }
    expect(() => formatArtifactName({ attempt: "0", revision: "head", providerId: "fixture", shard: { index: 1, count: 1 } })).toThrow();
  });

  it("round-trips every valid identity (property)", () => {
    const part = fc.record({
      attempt: fc.bigInt({ min: 1n, max: 10n ** 19n - 1n }).map(String),
      revision: fc.constantFrom("base" as const, "head" as const),
      providerId: fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      shard: fc.integer({ min: 1, max: 64 }).chain((count) => fc.record({ index: fc.integer({ min: 1, max: count }), count: fc.constant(count) })),
    });
    fc.assert(
      fc.property(part, (p) => {
        expect(parseArtifactName(formatArtifactName(p))).toEqual(p);
      }),
    );
  });
});

describe("GitHub numeric IDs and run keys (02 §3)", () => {
  it("compares numerically, never lexically", () => {
    expect(compareGitHubIds("10", "9")).toBe(1);
    expect(compareGitHubIds("36405830015", "36405830015")).toBe(0);
    // Beyond 2^53, where floats would collapse the two.
    expect(compareGitHubIds("9007199254740993", "9007199254740992")).toBe(1);
    expect(() => compareGitHubIds("01", "1")).toThrow();
  });

  it("formats and parses run keys", () => {
    expect(formatRunKey("36405830015", "2")).toBe("36405830015-a2");
    expect(parseRunKey("36405830015-a2")).toEqual({ kind: "source", runId: "36405830015", attempt: "2" });
    expect(parseRunKey(`import-${"a".repeat(64)}`)).toEqual({ kind: "import", digest: "a".repeat(64) });
    expect(parseRunKey("36405830015-a0")).toBeUndefined();
    expect(parseRunKey("036405830015-a1")).toBeUndefined();
    expect(() => formatRunKey("1", "01")).toThrow();
  });

  it("orders unit keys by provider, then view, then variant", () => {
    const k = (providerId: string, viewId: string, variantId = "desktop") => ({ providerId, viewId, variantId });
    const sorted = [k("stack", "a"), k("fixture", "z"), k("fixture", "home", "mobile"), k("fixture", "home")].sort(compareUnitKeys);
    expect(sorted).toEqual([k("fixture", "home"), k("fixture", "home", "mobile"), k("fixture", "z"), k("stack", "a")]);
  });
});

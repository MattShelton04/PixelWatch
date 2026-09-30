// Provider and attempt identity: the same view name under two providers stays two units, and a
// part's attempt/revision/provider/shard agree between its artifact name and its bundle.json.
import { describe, expect, it } from "vitest";
import { canonicalSha256, unitFileName } from "../src/canonical.ts";
import { convertPropertyScope } from "../src/convert/propertyscope.ts";
import { convertTracePilot } from "../src/convert/tracepilot.ts";
import type { Snapshot } from "../src/generated/types.ts";
import { formatRunKey, parseArtifactName } from "../src/ids.ts";
import { parseDocument, validateDocument } from "../src/validate.ts";
import { testdata, tinyPng } from "./helpers.ts";

function psManifest(provider: string, revision = "head"): string {
  return JSON.stringify({
    schema: 1,
    revision,
    provider,
    cases: [{ id: "home", provider, status: "captured", errors: [] }],
  });
}

describe("provider identity", () => {
  const images = new Map([["home.png", tinyPng()]]);
  const fixture = convertPropertyScope({ manifest: psManifest("fixture"), images, attempt: "1" });
  const stack = convertPropertyScope({ manifest: psManifest("stack"), images, attempt: "1" });

  it("gives the same view name distinct files per provider", () => {
    const [a] = fixture.bundle.units;
    const [b] = stack.bundle.units;
    expect(a?.state === "captured" && b?.state === "captured").toBe(true);
    if (a?.state !== "captured" || b?.state !== "captured") return;
    expect(a.file).not.toBe(b.file);
    expect(a.file).toBe(unitFileName({ providerId: "fixture", viewId: "home", variantId: "desktop" }));
    expect(fixture.artifactName).not.toBe(stack.artifactName);
  });

  it("keeps both as separate units in one snapshot", () => {
    const body: Omit<Snapshot, "snapshotId"> = {
      schemaVersion: 1,
      claims: {},
      providers: [
        { providerId: "fixture", environment: {} },
        { providerId: "stack", environment: {} },
      ],
      parts: [],
      units: ["fixture", "stack"].map((providerId) => ({
        providerId,
        viewId: "home",
        variantId: "desktop",
        state: "captured" as const,
        pixelHash: "0".repeat(64),
        width: 1,
        height: 1,
      })),
    };
    const snapshot = { ...body, snapshotId: canonicalSha256(body) };
    expect(validateDocument("snapshot", snapshot).ok).toBe(true);
    // The ID is over the canonical payload, so key order and position don't matter.
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(validateDocument("snapshot", reordered).ok).toBe(true);
  });

  it("refuses a bundle.json whose file names belong to another provider", () => {
    const json = Buffer.from(fixture.files.get("bundle.json") ?? new Uint8Array()).toString("utf8");
    const swapped = json.replace('"providerId":"fixture"', '"providerId":"stack"');
    expect(parseDocument("bundle", swapped)).toMatchObject({ ok: false, issue: { code: "file-name-mismatch" } });
  });
});

describe("attempt identity", () => {
  it("names each part with its attempt, revision, provider and shard, as bundle.json does", () => {
    const converted = convertTracePilot({
      manifest: testdata("prototypes", "tracepilot-36314265418", "visual-base-2", "capture-2-2.json"),
      images: new Map(),
      attempt: "3",
    });
    const identity = parseArtifactName(converted.artifactName);
    expect(converted.artifactName).toBe("pixelwatch-b1-a3-base-fixture-s2-of2");
    expect(identity).toEqual({
      attempt: converted.bundle.attempt,
      revision: converted.bundle.revision,
      providerId: converted.bundle.providerId,
      shard: converted.bundle.shard,
    });
  });

  it("gives each attempt its own run key", () => {
    expect(formatRunKey("36405830015", "1")).not.toBe(formatRunKey("36405830015", "2"));
    expect(formatRunKey("36405830015", "10")).toBe("36405830015-a10");
  });

  it("rejects an attempt that isn't a GitHub run attempt", () => {
    for (const attempt of ["0", "01", "", "1.0", "-1"]) {
      expect(() => convertPropertyScope({ manifest: psManifest("fixture"), images: new Map(), attempt }), attempt).toThrow(/attempt/);
    }
  });
});

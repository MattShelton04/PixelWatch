// Provider and attempt identity: the same view name under two providers stays two units, and a
// part's attempt/revision/provider/shard agree between its artifact name and its bundle.json.
import { describe, expect, it } from "vitest";
import { convertPropertyScope } from "../src/convert/propertyscope.ts";
import { convertTracePilot } from "../src/convert/tracepilot.ts";
import type { Run } from "../src/generated/types.ts";
import { formatRunKey, parseArtifactName } from "../src/ids.ts";
import { validateDocument } from "../src/validate.ts";
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

  it("gives the same view name in two providers distinct artifacts", () => {
    expect(fixture.files.has("home.desktop.png") && stack.files.has("home.desktop.png")).toBe(true);
    expect(fixture.artifactName).not.toBe(stack.artifactName);
  });

  it("keeps both as separate results in one run", () => {
    const run = JSON.parse(testdata("schemas", "run", "valid", "all-eight-statuses.json").toString("utf8")) as Run;
    expect(validateDocument("run", run).ok).toBe(true);
    const homes = run.results.filter((r) => r.viewId === "home" && r.variantId === "desktop").map((r) => r.providerId);
    expect(homes).toEqual(["fixture", "stack"]);
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

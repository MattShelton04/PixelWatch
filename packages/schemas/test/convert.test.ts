import { describe, expect, it } from "vitest";
import { unitFileName } from "../src/canonical.ts";
import { ConversionError, type ConvertedBundle } from "../src/convert/bundle.ts";
import { convertPropertyScope } from "../src/convert/propertyscope.ts";
import { convertTracePilot } from "../src/convert/tracepilot.ts";
import type { Bundle, BundleUnit } from "../src/generated/types.ts";
import { parseArtifactName } from "../src/ids.ts";
import { parseDocument } from "../src/validate.ts";
import { testdata, testdataDir, tinyPng } from "./helpers.ts";

/** Real screenshots where committed, a tiny valid PNG for every other case. */
function imagesFor(manifest: Buffer, dir: string[]): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  const { cases } = JSON.parse(manifest.toString("utf8")) as { cases: { id: string }[] };
  const real = new Set(testdataDir(...dir));
  for (const { id } of cases) images.set(`${id}.png`, real.has(`${id}.png`) ? testdata(...dir, `${id}.png`) : tinyPng());
  return images;
}

/** What every conversion must satisfy, whatever the input. */
function expectWellFormed(converted: ConvertedBundle, caseCount: number): void {
  const { bundle, files } = converted;
  const reparsed = parseDocument("bundle", files.get("bundle.json") ?? new Uint8Array());
  expect(reparsed.ok ? "ok" : reparsed.issue).toBe("ok");
  if (reparsed.ok) expect(reparsed.value).toEqual(bundle);
  expect(bundle.units).toHaveLength(caseCount);
  const captured = bundle.units.filter((u): u is Extract<BundleUnit, { state: "captured" }> => u.state === "captured");
  const pngs = [...files.keys()].filter((name) => name !== "bundle.json");
  expect(pngs.sort()).toEqual(captured.map((u) => u.file).sort());
  for (const unit of captured) {
    expect(unit.file).toBe(unitFileName({ providerId: bundle.providerId, viewId: unit.viewId, variantId: "desktop" }));
  }
  for (const name of files.keys()) expect(name).toMatch(/^(bundle\.json|u-[0-9a-f]{64}\.png)$/);
  expect(parseArtifactName(converted.artifactName)).toEqual({
    attempt: bundle.attempt,
    revision: bundle.revision,
    providerId: bundle.providerId,
    shard: bundle.shard,
  });
}

describe("real prototype output (testdata/prototypes)", () => {
  it.each([
    ["visual-base-fixture", "capture-fixture.json", "base", "fixture", 29],
    ["visual-base-stack", "capture-stack.json", "base", "stack", 13],
    ["visual-head-fixture", "capture-fixture.json", "head", "fixture", 29],
    ["visual-head-stack", "capture-stack.json", "head", "stack", 13],
  ] as const)("PropertyScope %s converts and validates", (artifact, file, revision, provider, count) => {
    const dir = ["prototypes", "propertyscope-36405830015", artifact];
    const manifest = testdata(...dir, file);
    const converted = convertPropertyScope({ manifest, images: imagesFor(manifest, dir), attempt: "1", revision, providerId: provider });
    expectWellFormed(converted, count);
    expect(converted.artifactName).toBe(`pixelwatch-b1-a1-${revision}-${provider}-s1-of1`);
    expect(converted.bundle.units.every((u) => u.state === "captured")).toBe(true);
    expect(converted.bundle.claims.environment?.viewport).toEqual({ width: 1440, height: 1000 });
  });

  it.each([
    ["visual-base-1", "capture-1-2.json", "base", 1, 53],
    ["visual-base-2", "capture-2-2.json", "base", 2, 52],
    ["visual-head-1", "capture-1-2.json", "head", 1, 53],
    ["visual-head-2", "capture-2-2.json", "head", 2, 52],
  ] as const)("TracePilot %s converts and validates", (artifact, file, revision, index, count) => {
    const dir = ["prototypes", "tracepilot-36314265418", artifact];
    const manifest = testdata(...dir, file);
    const converted = convertTracePilot({ manifest, images: imagesFor(manifest, dir), attempt: "1", revision });
    expectWellFormed(converted, count);
    expect(converted.bundle.shard).toEqual({ index, count: 2 });
    expect(converted.bundle.units.every((u) => u.state === "captured")).toBe(true);
  });

  it("covers each revision's catalog exactly once across parts", () => {
    for (const revision of ["base", "head"]) {
      const views: string[] = [];
      for (const index of [1, 2]) {
        const dir = ["prototypes", "tracepilot-36314265418", `visual-${revision}-${String(index)}`];
        const manifest = testdata(...dir, `capture-${String(index)}-2.json`);
        views.push(...convertTracePilot({ manifest, images: new Map(), attempt: "1" }).bundle.units.map((u) => u.viewId));
      }
      expect(views).toHaveLength(105);
      expect(new Set(views).size).toBe(105);
    }
  });
});

type Case = Record<string, unknown>;

function ps(cases: Case[], extra: Case = {}): string {
  return JSON.stringify({ schema: 1, revision: "base", provider: "fixture", revisionSha: "a".repeat(40), cases, ...extra });
}

function unit(bundle: Bundle, viewId: string): BundleUnit | undefined {
  return bundle.units.find((u) => u.viewId === viewId);
}

describe("status mapping (ADR 0003)", () => {
  const cases: Case[] = [
    { id: "ok", status: "captured", errors: [] },
    { id: "no-png", status: "captured", errors: [] },
    { id: "bad-png", status: "captured", errors: [] },
    { id: "broke", status: "failed", errors: ["Timeout 20000ms exceeded.\n    at page.goto"] },
    { id: "noisy", status: "incomplete", errors: ["console: TypeError"] },
    { id: "weird", status: "exploded", errors: [] },
    { id: "new-view", status: "failed", errors: ["route not found"] },
  ];
  const images = new Map([
    ["ok.png", tinyPng()],
    ["bad-png.png", Buffer.from("not a png")],
    ["broke.png", tinyPng()], // TracePilot-style diagnostic screenshot of a failure: ignored
    ["broke.failed.png", tinyPng()],
  ]);

  it("maps every prototype status without dropping a unit", () => {
    const { bundle, files } = convertPropertyScope({ manifest: ps(cases), images, attempt: "1" });
    expect(bundle.units.map((u) => [u.viewId, u.state, "category" in u ? u.category : ""])).toEqual([
      ["bad-png", "failed", "image-invalid"],
      ["broke", "failed", "capture-error"],
      ["new-view", "failed", "capture-error"],
      ["no-png", "failed", "image-missing"],
      ["noisy", "failed", "capture-incomplete"],
      ["ok", "captured", ""],
      ["weird", "failed", "unknown"],
    ]);
    expect(files.size).toBe(2); // bundle.json + ok
    expect(unit(bundle, "broke")).toMatchObject({ message: "Timeout 20000ms exceeded. at page.goto" });
  });

  it("marks a view absent only when the revision's own catalog doesn't declare it", () => {
    const catalog = ["ok", "no-png", "bad-png", "broke", "noisy", "weird"];
    const { bundle } = convertPropertyScope({ manifest: ps(cases), images, attempt: "1", revisionCatalog: catalog });
    expect(unit(bundle, "new-view")).toEqual({ viewId: "new-view", variantId: "desktop", state: "absent", reason: "not-in-revision-catalog" });
    // Declared views that failed stay failed; a failure is never turned into absence.
    expect(unit(bundle, "broke")?.state).toBe("failed");
    // A captured view outside the catalog is still compared.
    const again = convertPropertyScope({ manifest: ps(cases), images, attempt: "1", revisionCatalog: [] });
    expect(unit(again.bundle, "ok")?.state).toBe("captured");
    expect(unit(again.bundle, "no-png")?.state).toBe("failed");
  });

  it("treats TracePilot missing fixtures as an incomplete capture", () => {
    const manifest = JSON.stringify({
      schema: 1,
      revision: "head",
      shard: "1/1",
      cases: [{ id: "sessions", status: "captured", errors: [], missingFixtures: [{ command: "get_sessions" }] }],
    });
    const { bundle } = convertTracePilot({ manifest, images: new Map([["sessions.png", tinyPng()]]), attempt: "1" });
    expect(bundle.units[0]).toMatchObject({ state: "failed", category: "capture-incomplete", message: "missing fixture: get_sessions" });
  });

  it("bounds untrusted labels and messages", () => {
    const long = { id: "long", status: "failed", errors: ["é".repeat(5000)], state: "x\u0000\u009b".repeat(200), section: "   " };
    const { bundle } = convertPropertyScope({ manifest: ps([long]), images: new Map(), attempt: "1" });
    const u = unit(bundle, "long");
    expect(u?.state).toBe("failed");
    if (u?.state !== "failed") return;
    expect(Buffer.byteLength(u.message ?? "")).toBeLessThanOrEqual(2048);
    expect(Array.from(u.labels?.state ?? "").length).toBeLessThanOrEqual(256);
    // eslint-disable-next-line no-control-regex -- asserts that no control characters survive
    expect(u.labels?.state).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(u.labels?.group).toBeUndefined();
  });
});

describe("inputs that must not convert", () => {
  const good = { id: "home", status: "captured", errors: [] };
  it.each([
    ["an invalid case ID", ps([{ ...good, id: "Home Page" }])],
    ["a duplicate case ID", ps([good, good])],
    ["a case from another provider", ps([{ ...good, provider: "stack" }])],
    ["an unknown manifest schema", ps([good], { schema: 2 })],
    ["an unknown revision", ps([good], { revision: "main" })],
    ["a malformed commit SHA", ps([good], { revisionSha: "main" })],
    ["duplicate JSON keys", '{"schema":1,"schema":1}'],
    ["a non-object manifest", "[]"],
    ["too many cases", ps(Array.from({ length: 2001 }, (_, i) => ({ ...good, id: `v${String(i)}` })))],
  ])("rejects %s", (_, manifest) => {
    expect(() => convertPropertyScope({ manifest, images: new Map(), attempt: "1" })).toThrow(ConversionError);
  });

  it("rejects a revision or provider other than the one expected", () => {
    expect(() => convertPropertyScope({ manifest: ps([good]), images: new Map(), attempt: "1", revision: "head" })).toThrow(/expected head/);
    expect(() => convertPropertyScope({ manifest: ps([good]), images: new Map(), attempt: "1", providerId: "stack" })).toThrow(/expected stack/);
  });

  it("rejects a TracePilot manifest without a valid shard", () => {
    for (const shard of [undefined, "3/2", "0/1", "1-2"]) {
      const manifest = JSON.stringify({ schema: 1, revision: "head", shard, cases: [] });
      expect(() => convertTracePilot({ manifest, images: new Map(), attempt: "1" }), String(shard)).toThrow(ConversionError);
    }
  });
});

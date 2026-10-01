// Fixed-part merge (M1.4; 02 §§4, 6; 07 §2; ADR 0008). Pure properties run mergeParts on generated
// part sets against an independent model; selection and rejection run end to end through
// ingestArtifacts on archives from the test-side ZIP writer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResultStatus, Side } from "@pixelwatch/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareImages } from "../src/comparator/compare.ts";
import { COMPARATOR_V1 } from "../src/comparator/policy.ts";
import { unitResult } from "../src/comparator/result.ts";
import { IngressError } from "../src/ingest/errors.ts";
import { ingestArtifacts } from "../src/ingest/ingest.ts";
import { MAX_PARTS, mergeParts } from "../src/ingest/merge.ts";
import { partKeyString, selectArtifacts } from "../src/ingest/select.ts";
import type { Baseline, ListedSide, MergedUnit, RejectedPart, ValidPart } from "../src/ingest/types.ts";
import { type RawPixels, pixelHash } from "../src/pixel-hash.ts";
import { decodePng } from "../src/png/decode.ts";
import {
  ABSENT,
  FAILED,
  type PartSpec,
  VARIANT,
  artifact,
  captured,
  config,
  hex,
  memoryPool,
  tinyPng,
  validPart,
} from "./ingest-fixtures.ts";

const HOSTILE = join(import.meta.dirname, "..", "..", "..", "testdata", "zip", "hostile");

function grey(width: number, height: number, edits: [number, number, number][] = []): RawPixels {
  const data = new Uint8Array(width * height * 4).fill(128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const [x, y, red] of edits) data[(y * width + x) * 4] = red;
  return { width, height, channels: 4, data };
}

// unchanged with itself; subtle, changed and taller against [0]; narrower → dimensions.
const PALETTE = [grey(8, 8), grey(8, 8, [[1, 1, 132]]), grey(8, 8, [[1, 1, 200]]), grey(8, 10), grey(6, 8)];
const BY_HASH = new Map(PALETTE.map((p) => [pixelHash(p), p]));
const paletteSide = (i: number): ListedSide => {
  const image = PALETTE[i % PALETTE.length] ?? grey(1, 1);
  return captured(pixelHash(image), image.width, image.height);
};

function result(unit: MergedUnit) {
  const { base, head } = unit;
  const comparison =
    base.state === "captured" && head.state === "captured"
      ? compareImages(BY_HASH.get(base.pixelHash) ?? grey(1, 1), BY_HASH.get(head.pixelHash) ?? grey(1, 1), COMPARATOR_V1)
      : undefined;
  return unitResult(unit, base, head, comparison);
}

// A generated world: providers × shards, each revision's unit listings spread over shards, and
// each part's fate (valid, rejected, not received). Listings may collide to make conflicts.
const PROVIDERS = ["a", "b", "c"] as const;
const VIEWS = 6;
const REVISIONS = ["base", "head"] as const;
type Fate = "valid" | "rejected" | "not-received";

interface World {
  readonly providers: readonly (readonly [string, number])[];
  readonly baseline: Baseline;
  readonly valid: ValidPart[];
  readonly rejected: RejectedPart[];
}

const worlds = fc
  .record({
    providerCount: fc.integer({ min: 1, max: 3 }),
    shards: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 3, maxLength: 3 }),
    baseline: fc.constantFrom<Baseline>("expected", "expected", "none"),
    // [listed?/shard, state, second shard for a conflict]
    slots: fc.array(fc.tuple(fc.nat(99), fc.nat(99), fc.nat(99)), { minLength: 2 * 3 * VIEWS, maxLength: 2 * 3 * VIEWS }),
    fates: fc.array(fc.constantFrom<Fate>("valid", "valid", "valid", "valid", "rejected", "not-received"), { minLength: 18, maxLength: 18 }),
  })
  .map(({ providerCount, shards, baseline, slots, fates }): World => {
    const providers = PROVIDERS.slice(0, providerCount).map((id, i) => [id, shards[i] ?? 1] as const);
    const listings = new Map<string, [string, ListedSide][]>();
    const list = (key: string, view: string, side: ListedSide) => {
      listings.set(key, [...(listings.get(key) ?? []), [view, side]]);
    };
    providers.forEach(([providerId, count], p) => {
      REVISIONS.forEach((revision, r) => {
        for (let v = 0; v < VIEWS; v++) {
          const [where = 0, state = 0, conflict = 0] = slots[(r * 3 + p) * VIEWS + v] ?? [];
          if (where % 6 === 0) continue;
          const side = state % 7 === 0 ? ABSENT : state % 7 === 1 ? FAILED : paletteSide(state);
          const shard = (where % count) + 1;
          list(`${revision}/${providerId}/${String(shard)}`, `v${String(v)}`, side);
          if (count > 1 && conflict % 13 === 0) list(`${revision}/${providerId}/${String((shard % count) + 1)}`, `v${String(v)}`, side);
        }
      });
    });
    const valid: ValidPart[] = [];
    const rejected: RejectedPart[] = [];
    let id = 1;
    providers.forEach(([providerId, count], p) => {
      REVISIONS.forEach((revision, r) => {
        if (revision === "base" && baseline === "none") return;
        for (let index = 1; index <= count; index++) {
          const fate = fates[(r * 3 + p) * 3 + index - 1] ?? "valid";
          const artifactId = String(id++);
          if (fate === "valid") valid.push(validPart(revision, providerId, [index, count], listings.get(`${revision}/${providerId}/${String(index)}`) ?? [], artifactId));
          if (fate === "rejected") {
            rejected.push({ revision, providerId, shard: { index, count }, artifacts: [{ artifactId, sha256: hex(id) }], diagnostic: { code: "part-bundle-invalid", message: "bundle.json is invalid" } });
          }
        }
      });
    });
    return { providers, baseline, valid, rejected };
  });

function merge(world: World) {
  return mergeParts({ config: config(world.providers), baseline: world.baseline, valid: world.valid, rejected: world.rejected });
}

/** The model: an independent statement of 02 §6 steps 3–5, written over parts rather than maps. */
function model(world: World) {
  const surviving = world.valid.filter(
    (part) =>
      !world.valid.some(
        (other) => other !== part && other.revision === part.revision && other.providerId === part.providerId && other.units.some((u) => part.units.some((w) => w.viewId === u.viewId)),
      ),
  );
  const expectedCount = (providerId: string) => world.providers.find(([id]) => id === providerId)?.[1] ?? 0;
  const keys = new Set(surviving.flatMap((part) => part.units.map((u) => `${part.providerId}/${u.viewId}`)));
  const side = (revision: "base" | "head", providerId: string, viewId: string): Side => {
    if (revision === "base" && world.baseline === "none") return { state: "none" };
    for (const part of surviving) {
      if (part.revision !== revision || part.providerId !== providerId) continue;
      const listed = part.units.find((u) => u.viewId === viewId);
      if (listed !== undefined) return listed.side;
    }
    const valid = surviving.filter((p) => p.revision === revision && p.providerId === providerId).length;
    return { state: "missing", cause: valid < expectedCount(providerId) ? "part-missing" : "unit-missing" };
  };
  const units: { key: string; base: Side; head: Side }[] = [];
  let excluded = 0;
  for (const key of keys) {
    const [providerId = "", viewId = ""] = key.split("/");
    const base = side("base", providerId, viewId);
    const head = side("head", providerId, viewId);
    if (head.state === "absent" && (base.state === "absent" || base.state === "none")) excluded++;
    else units.push({ key, base, head });
  }
  return { units: units.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), excluded };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const spec = (revision: "base" | "head", providerId: string, shard: [number, number], units: PartSpec["units"], attempt = "7"): PartSpec => ({
  attempt,
  revision,
  providerId,
  shard,
  units,
});

describe("artifact selection and merge", () => {
  it("merges only expected names for the selected attempt and rejects duplicates and mixed attempts", async () => {
    const cfg = config([["p", 2]]);
    const units = [{ viewId: "home", state: "captured" as const }];
    const other = [{ viewId: "about", state: "captured" as const }];
    const bomb = readFileSync(join(HOSTILE, "bomb-entry-count.zip"));
    const artifacts = [
      artifact(spec("base", "p", [1, 2], units), { id: "10" }),
      artifact(spec("base", "p", [2, 2], other), { id: "11" }),
      artifact(spec("head", "p", [1, 2], units), { id: "12" }),
      // Two artifacts under one name: the part is rejected; neither is picked.
      artifact(spec("head", "p", [2, 2], other), { id: "13" }),
      artifact(spec("head", "p", [2, 2], [{ viewId: "about", state: "captured", png: tinyPng(9) }]), { id: "14" }),
      // Another attempt's artifacts are never opened: this one would refuse the whole ingestion.
      { artifactName: "pixelwatch-b1-a6-head-p-s1-of2", artifactId: "15", zip: bomb },
      // A bundle from attempt 6 under attempt 7's name mixes attempts: rejected.
      artifact(spec("base", "p", [1, 2], units, "6"), { id: "16", name: "pixelwatch-b1-a7-base-p-s1-of2" }),
      { artifactName: "pixelwatch-b1-a7-head-p-s3-of3", artifactId: "17", zip: bomb },
      { artifactName: "pixelwatch-b1-a7-head-q-s1-of1", artifactId: "18", zip: bomb },
      { artifactName: "pixelwatch-b2-a7-head-p-s1-of2", artifactId: "19", zip: bomb },
      { artifactName: "pixelwatch-b1-a07-head-p-s1-of2", artifactId: "20", zip: bomb },
      { artifactName: "playwright-report", artifactId: "21", zip: bomb },
    ];
    const ingestion = await ingestArtifacts({ config: cfg, attempt: "7", baseline: "expected", artifacts: shuffle(artifacts, 7), pool: memoryPool() });

    expect(ingestion.ignored.map((i) => [i.artifactId, i.reason])).toEqual([
      ["15", "other-attempt"],
      ["17", "unexpected-part"],
      ["18", "unexpected-part"],
      ["19", "unsupported-bundle-version"],
      ["20", "malformed-name"],
      ["21", "not-pixelwatch"],
    ]);
    const parts = ingestion.parts.map((p) => [partKeyString(p), p.status, p.artifacts.map((a) => a.artifactId), p.diagnostic?.code]);
    expect(parts).toEqual([
      ["base/p/1", "rejected", ["10", "16"], "part-duplicate"],
      ["base/p/2", "valid", ["11"], undefined],
      ["head/p/1", "valid", ["12"], undefined],
      ["head/p/2", "rejected", ["13", "14"], "part-duplicate"],
    ]);
    expect(ingestion.units.map((u) => [u.viewId, u.base.state, u.head.state])).toEqual([
      ["about", "captured", "missing"],
      ["home", "missing", "captured"],
    ]);
    expect(ingestion.coverage).toEqual({
      status: "incomplete",
      declaredUnits: 2,
      accountedUnits: 0,
      missingParts: [
        { revision: "base", providerId: "p", shard: { index: 1, count: 2 }, reason: "rejected" },
        { revision: "head", providerId: "p", shard: { index: 2, count: 2 }, reason: "rejected" },
      ],
    });

    // Alone under its name, attempt 6's bundle is rejected for its identity, not merged.
    const mixed = await ingestArtifacts({
      config: cfg,
      attempt: "7",
      baseline: "expected",
      artifacts: [artifacts[6], artifacts[1], artifacts[2]].filter((a) => a !== undefined),
      pool: memoryPool(),
    });
    expect(mixed.parts.find((p) => partKeyString(p) === "base/p/1")).toMatchObject({ status: "rejected", diagnostic: { code: "part-identity" } });
  });

  it("is deterministic under any permutation of parts and entries", async () => {
    fc.assert(
      fc.property(worlds, fc.nat(), (world, seed) => {
        const permuted: World = {
          ...world,
          valid: shuffle(world.valid, seed).map((p) => ({ ...p, units: shuffle(p.units, seed + 1) })),
          rejected: shuffle(world.rejected, seed + 2),
        };
        expect(merge(permuted)).toEqual(merge(world));
      }),
      { numRuns: 300 },
    );

    // End to end: artifact order and entry order inside each archive don't change the result.
    const cfg = config([
      ["p", 2],
      ["q", 1],
    ]);
    const parts = [
      spec("base", "p", [1, 2], [{ viewId: "a", state: "captured" }, { viewId: "b", state: "absent" }]),
      spec("base", "p", [2, 2], [{ viewId: "c", state: "captured" }]),
      spec("head", "p", [1, 2], [{ viewId: "a", state: "captured", png: tinyPng(3) }, { viewId: "b", state: "captured" }]),
      spec("head", "p", [2, 2], [{ viewId: "c", state: "failed" }]),
      spec("head", "q", [1, 1], [{ viewId: "x", state: "captured" }, { viewId: "y", state: "captured" }]),
    ];
    const run = async (seed: number) => {
      const artifacts = parts.map((p, i) => artifact(p, { id: String(100 + i), order: (entries) => shuffle(entries, seed + i) }));
      return ingestArtifacts({ config: cfg, attempt: "7", baseline: "expected", artifacts: shuffle(artifacts, seed), pool: memoryPool() });
    };
    // Reordering entries changes the archive bytes, so only its SHA-256 may differ.
    const stripped = async (seed: number) => {
      const ingestion = await run(seed);
      return { ...ingestion, parts: ingestion.parts.map((p) => ({ ...p, artifacts: p.artifacts.map((a) => a.artifactId) })) };
    };
    const reference = await stripped(1);
    expect(reference.coverage.status).toBe("incomplete");
    for (const seed of [2, 3, 4, 5]) expect(await stripped(seed)).toEqual(reference);
  });

  it("keeps the eight counts exhaustive and disjoint", () => {
    const seen = new Set<ResultStatus>();
    fc.assert(
      fc.property(worlds, (world) => {
        const merged = merge(world);
        const counts = new Map<ResultStatus, number>();
        for (const unit of merged.units) {
          const { status } = result(unit);
          counts.set(status, (counts.get(status) ?? 0) + 1);
          seen.add(status);
        }
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        expect(total).toBe(merged.coverage.declaredUnits);
        expect(merged.coverage.accountedUnits).toBe(total - (counts.get("missing") ?? 0));
        const complete = merged.coverage.missingParts.length === 0 && counts.get("missing") === undefined;
        expect(merged.coverage.status).toBe(complete ? "complete-declared" : total === 0 ? "unknown" : "incomplete");
      }),
      { numRuns: 400 },
    );
    expect([...seen].sort()).toEqual(["added", "changed", "failed", "incomparable", "missing", "removed", "subtle", "unchanged"]);
  });

  it("never mixes attempts, providers or revisions", async () => {
    // Pure: every side comes from a part of its own revision and provider.
    fc.assert(
      fc.property(worlds, (world) => {
        const merged = merge(world);
        const expected = model(world);
        expect(merged.units.map((u) => ({ key: `${u.providerId}/${u.viewId}`, base: u.base, head: u.head }))).toEqual(expected.units);
        expect(merged.excluded.count).toBe(expected.excluded);
      }),
      { numRuns: 400 },
    );

    // End to end: two complete attempts with different images; each ingestion sees only its own.
    const cfg = config([
      ["p", 1],
      ["q", 1],
    ]);
    const seedOf = (attempt: string, revision: string, provider: string) => Number(attempt) * 100 + (revision === "base" ? 10 : 20) + (provider === "p" ? 1 : 2);
    const artifacts = ["6", "7"].flatMap((attempt) =>
      (["base", "head"] as const).flatMap((revision) =>
        ["p", "q"].map((provider) => artifact(spec(revision, provider, [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(seedOf(attempt, revision, provider)) }], attempt))),
      ),
    );
    for (const attempt of ["6", "7"]) {
      const pool = memoryPool();
      const ingestion = await ingestArtifacts({ config: cfg, attempt, baseline: "expected", artifacts, pool });
      expect(ingestion.coverage.status).toBe("complete-declared");
      expect(ingestion.ignored.map((i) => i.reason)).toEqual(["other-attempt", "other-attempt", "other-attempt", "other-attempt"]);
      for (const unit of ingestion.units) {
        for (const revision of ["base", "head"] as const) {
          const side = unit[revision];
          const want = pixelHash(await decodePng(tinyPng(seedOf(attempt, revision, unit.providerId))));
          expect(side).toMatchObject({ state: "captured", pixelHash: want });
        }
      }
    }
  });

  it("reports missing parts with unknown unit counts, never zero", () => {
    const cfg = config([
      ["p", 2],
      ["q", 1],
    ]);
    const merged = mergeParts({
      config: cfg,
      baseline: "expected",
      valid: [validPart("head", "p", [1, 2], [["home", paletteSide(0)]]), validPart("base", "p", [1, 2], [])],
      rejected: [{ revision: "head", providerId: "q", shard: { index: 1, count: 1 }, artifacts: [{ artifactId: "9", sha256: hex(9) }], diagnostic: { code: "zip-crc", message: "x" } }],
    });
    expect(merged.parts.map((p) => [partKeyString(p), p.status, p.unitCount])).toEqual([
      ["base/p/1", "valid", 0],
      ["base/p/2", "not-received", undefined],
      ["base/q/1", "not-received", undefined],
      ["head/p/1", "valid", 1],
      ["head/p/2", "not-received", undefined],
      ["head/q/1", "rejected", undefined],
    ]);
    for (const part of merged.parts.filter((p) => p.status !== "valid")) {
      expect(Object.keys(part).sort()).toEqual(["artifacts", "providerId", "revision", "shard", "status", ...(part.status === "rejected" ? ["diagnostic"] : [])].sort());
    }
    for (const missing of merged.coverage.missingParts) expect(Object.keys(missing).sort()).toEqual(["providerId", "reason", "revision", "shard"]);
    expect(merged.coverage).toMatchObject({ status: "incomplete", declaredUnits: 1, accountedUnits: 0 });
    expect(merged.units[0]?.base).toEqual({ state: "missing", cause: "part-missing" });

    // Nothing received: no units, unknown coverage, every expected part missing.
    const empty = mergeParts({ config: cfg, baseline: "expected", valid: [], rejected: [] });
    expect(empty.coverage).toMatchObject({ status: "unknown", declaredUnits: 0, accountedUnits: 0 });
    expect(empty.coverage.missingParts).toHaveLength(6);
  });

  it("rejects a malformed part with a bounded diagnostic and keeps valid siblings as an incomplete run", async () => {
    const cfg = config([["p", 3]]);
    const hostile = new TextEncoder().encode(`{"schemaVersion":1,"<script>alert(1)</script>${"\u202e".repeat(5000)}":1}`);
    const artifacts = [
      artifact(spec("head", "p", [1, 3], [{ viewId: "a", state: "captured" }])),
      artifact(spec("head", "p", [2, 3], [{ viewId: "b", state: "captured" }]), { bundleBytes: hostile }),
      artifact(spec("head", "p", [3, 3], [{ viewId: "c", state: "failed" }])),
      artifact(spec("base", "p", [1, 3], [{ viewId: "a", state: "captured" }, { viewId: "b", state: "captured" }, { viewId: "c", state: "captured" }])),
      artifact(spec("base", "p", [2, 3], [])),
      artifact(spec("base", "p", [3, 3], [])),
    ];
    const ingestion = await ingestArtifacts({ config: cfg, attempt: "7", baseline: "expected", artifacts, pool: memoryPool() });
    const bad = ingestion.parts.find((p) => partKeyString(p) === "head/p/2");
    expect(bad).toMatchObject({ status: "rejected", diagnostic: { code: "part-bundle-invalid" } });
    const message = bad?.diagnostic?.message ?? "";
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2048);
    expect(message).not.toMatch(/script|\u202e/);
    expect(ingestion.parts.filter((p) => p.status === "valid")).toHaveLength(5);
    expect(ingestion.units.map((u) => [u.viewId, u.head])).toEqual([
      ["a", expect.objectContaining({ state: "captured" })],
      ["b", { state: "missing", cause: "part-missing" }],
      ["c", { state: "failed", category: "capture-error" }],
    ]);
    expect(ingestion.coverage).toMatchObject({ status: "incomplete", declaredUnits: 3, accountedUnits: 2 });
  });

  it("rejects both parts that claim one unit key, never the newest", () => {
    const cfg = config([["p", 2]]);
    for (const ids of [
      ["1", "2"],
      ["2", "1"],
    ] as const) {
      const valid = [
        validPart("head", "p", [1, 2], [["home", paletteSide(0)], ["a", paletteSide(1)]], ids[0]),
        validPart("head", "p", [2, 2], [["home", paletteSide(2)], ["b", paletteSide(1)]], ids[1]),
        // The same key in the other revision is no conflict.
        validPart("base", "p", [1, 2], [["home", paletteSide(0)]]),
        validPart("base", "p", [2, 2], [["a", paletteSide(0)]]),
      ];
      for (const order of [valid, [...valid].reverse()]) {
        const merged = mergeParts({ config: cfg, baseline: "expected", valid: order, rejected: [] });
        expect(merged.parts.map((p) => [partKeyString(p), p.status, p.diagnostic?.code])).toEqual([
          ["base/p/1", "valid", undefined],
          ["base/p/2", "valid", undefined],
          ["head/p/1", "rejected", "part-conflict"],
          ["head/p/2", "rejected", "part-conflict"],
        ]);
        expect(merged.units.map((u) => [u.viewId, u.head])).toEqual([
          ["a", { state: "missing", cause: "part-missing" }],
          ["home", { state: "missing", cause: "part-missing" }],
        ]);
      }
    }
  });

  it("marks a unit absent from one revision's catalogs as missing, never absent", () => {
    const merged = mergeParts({
      config: config([["p", 1]]),
      baseline: "expected",
      valid: [validPart("base", "p", [1, 1], [["kept", paletteSide(0)], ["dropped", paletteSide(0)]]), validPart("head", "p", [1, 1], [["kept", paletteSide(0)]])],
      rejected: [],
    });
    const dropped = merged.units.find((u) => u.viewId === "dropped");
    expect(dropped?.head).toEqual({ state: "missing", cause: "unit-missing" });
    expect(dropped === undefined ? undefined : result(dropped)).toMatchObject({ status: "missing", reasons: ["unit-missing"] });
    expect(merged.coverage).toMatchObject({ status: "incomplete", declaredUnits: 2, accountedUnits: 1, missingParts: [] });
  });

  it("never reports omitted or failed work as unchanged", () => {
    fc.assert(
      fc.property(worlds, (world) => {
        for (const unit of merge(world).units) {
          const status = result(unit).status;
          if (unit.base.state !== "captured" || unit.head.state !== "captured") expect(["unchanged", "subtle", "changed"]).not.toContain(status);
          if ([unit.base.state, unit.head.state].includes("missing")) expect(status).toBe("missing");
          else if ([unit.base.state, unit.head.state].includes("failed")) expect(status).toBe("failed");
        }
      }),
      { numRuns: 400 },
    );
    // Identical pixels on both sides don't help a side whose part was rejected or not received.
    const same = paletteSide(0);
    const merged = mergeParts({
      config: config([["p", 2]]),
      baseline: "expected",
      valid: [validPart("base", "p", [1, 2], [["home", same]]), validPart("base", "p", [2, 2], [["late", same]]), validPart("head", "p", [1, 2], [["home", same]])],
      rejected: [{ revision: "head", providerId: "p", shard: { index: 2, count: 2 }, artifacts: [{ artifactId: "3", sha256: hex(3) }], diagnostic: { code: "zip-crc", message: "x" } }],
    });
    expect(merged.units.map((u) => [u.viewId, result(u).status])).toEqual([
      ["home", "unchanged"],
      ["late", "missing"],
    ]);
  });

  it("excludes both-absent units with a diagnostic", () => {
    const valid = [validPart("base", "p", [1, 1], [["gone", ABSENT], ["new", ABSENT], ["old", paletteSide(0)]]), validPart("head", "p", [1, 1], [["gone", ABSENT], ["new", paletteSide(0)], ["old", ABSENT]])];
    const merged = mergeParts({ config: config([["p", 1]]), baseline: "expected", valid, rejected: [] });
    expect(merged.units.map((u) => [u.viewId, result(u).status])).toEqual([
      ["new", "added"],
      ["old", "removed"],
    ]);
    expect(merged.excluded).toEqual({ count: 1, sample: [{ providerId: "p", viewId: "gone", variantId: VARIANT }] });
    expect(merged.coverage).toMatchObject({ status: "complete-declared", declaredUnits: 2, accountedUnits: 2 });

    // An absent head with no baseline is no unit either; the sample is bounded.
    const many = Array.from({ length: 40 }, (_, i) => [`v${String(i).padStart(2, "0")}`, ABSENT] as const);
    const none = mergeParts({ config: config([["p", 1]]), baseline: "none", valid: [validPart("head", "p", [1, 1], many)], rejected: [] });
    expect(none.units).toEqual([]);
    expect(none.excluded.count).toBe(40);
    expect(none.excluded.sample.map((k) => k.viewId)).toEqual(many.slice(0, 16).map(([v]) => v));
    // checkCoverage: with every part valid and nothing declared, coverage is complete.
    expect(none.coverage).toMatchObject({ status: "complete-declared", declaredUnits: 0, missingParts: [] });
  });

  it("gives every unit a none base when there is no baseline", () => {
    const cfg = config([["p", 1]]);
    const head = validPart("head", "p", [1, 1], [["a", paletteSide(0)], ["b", FAILED]]);
    const merged = mergeParts({ config: cfg, baseline: "none", valid: [head], rejected: [] });
    expect(merged.units.map((u) => [u.viewId, u.base, result(u).status])).toEqual([
      ["a", { state: "none" }, "incomparable"],
      ["b", { state: "none" }, "failed"],
    ]);
    expect(merged.parts.map(partKeyString)).toEqual(["head/p/1"]);
    expect(merged.coverage.status).toBe("complete-declared");
    expect(() => mergeParts({ config: cfg, baseline: "none", valid: [head, validPart("base", "p", [1, 1], [])], rejected: [] })).toThrow(TypeError);

    const selection = selectArtifacts({
      config: cfg,
      attempt: "7",
      baseline: "none",
      artifacts: [
        { artifactName: "pixelwatch-b1-a7-base-p-s1-of1", artifactId: "1", zip: new Uint8Array() },
        { artifactName: "pixelwatch-b1-a7-head-p-s1-of1", artifactId: "2", zip: new Uint8Array() },
      ],
    });
    expect(selection.ignored).toEqual([{ artifactId: "1", name: "pixelwatch-b1-a7-base-p-s1-of1", reason: "base-not-expected" }]);
    expect(selection.selected.map((s) => partKeyString(s.key))).toEqual(["head/p/1"]);
  });

  it("refuses more than 2000 declared units", () => {
    const cfg = config([["p", 2]]);
    const units = (from: number, n: number) => Array.from({ length: n }, (_, i) => [`v${String(from + i)}`, paletteSide(0)] as const);
    const at = (n: number) => mergeParts({ config: cfg, baseline: "none", valid: [validPart("head", "p", [1, 2], units(0, 1000)), validPart("head", "p", [2, 2], units(1000, n - 1000))], rejected: [] });
    expect(at(2000).coverage.declaredUnits).toBe(2000);
    let error: unknown;
    try {
      at(2001);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IngressError);
    expect(error).toMatchObject({ code: "ingest-too-many-units", scope: "ingestion" });
    // A config whose parts run@1 can't record is a caller bug.
    expect(MAX_PARTS).toBe(256);
  });
});

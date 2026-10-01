// Integrity of the comparator-v1 goldens (M0.6, docs/adr/comparator-v1.md). The comparator itself
// is M1.3; these tests prove the committed fixtures are complete, that the expected results are the
// mechanical mapping of RECORDED prototype output, and that every recording fits run@1.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Run, type RunResult, normalizePng, validateDocument } from "@pixelwatch/schemas";
import { describe, expect, it } from "vitest";
import {
  COMPARATOR_TESTDATA,
  type CropRecording,
  type ExpectedFile,
  type RecordedSide,
  type TinyRecording,
  comparedResult,
  loadAndBuild,
  serialize,
} from "../../../tools/prototype-goldens/expected.ts";
import { COMPARATOR_V1, type PrototypeRecord, isComparison } from "../../../tools/prototype-goldens/mapping.ts";
import { type TinyCase, paintTinyImage, serializeTinyCases } from "../../../tools/prototype-goldens/tiny-cases.ts";
import { pixelHash } from "../src/pixel-hash.ts";

const PIN = "6378d8be5b1f418f72279e04b3de23d761b426d3";
const TESTDATA = join(import.meta.dirname, "..", "..", "..", "testdata");
const STATUSES = ["missing", "failed", "incomparable", "added", "removed", "unchanged", "subtle", "changed"] as const;

function text(...path: string[]): string {
  return readFileSync(join(COMPARATOR_TESTDATA, ...path), "utf8");
}
function json(...path: string[]): unknown {
  return JSON.parse(text(...path));
}

interface Recorded {
  recordedWith: { prototype: { commit: string }; constants: Record<string, unknown> };
}

/** Puts results into a real run@1 document so the full schema + semantic checks apply. */
function asRun(results: RunResult[]): Run {
  const template = JSON.parse(readFileSync(join(TESTDATA, "schemas", "run", "valid", "all-eight-statuses.json"), "utf8")) as Run;
  const sorted = [...results].sort((a, b) =>
    a.providerId !== b.providerId ? (a.providerId < b.providerId ? -1 : 1) : a.viewId < b.viewId ? -1 : a.viewId > b.viewId ? 1 : 0,
  );
  const accounted = sorted.filter((r) => r.status !== "missing").length;
  const count = (status: RunResult["status"]) => sorted.filter((r) => r.status === status).length;
  return {
    ...template,
    parts: template.parts.filter((p) => p.status === "valid"),
    coverage: {
      status: accounted === sorted.length ? "complete-declared" : "incomplete",
      declaredUnits: sorted.length,
      accountedUnits: accounted,
      missingParts: [],
    },
    counts: {
      missing: count("missing"),
      failed: count("failed"),
      incomparable: count("incomparable"),
      added: count("added"),
      removed: count("removed"),
      unchanged: count("unchanged"),
      subtle: count("subtle"),
      changed: count("changed"),
    },
    results: sorted,
  };
}

function expectValidRun(results: RunResult[]): void {
  const result = validateDocument("run", asRun(results));
  expect(result.ok ? "ok" : result.issue).toBe("ok");
}

describe("tiny comparator fixtures", () => {
  const { cases } = json("tiny", "cases.json") as { cases: TinyCase[] };
  const expected = json("tiny", "expected.json") as ExpectedFile;
  const recording = json("tiny", "prototype.json") as TinyRecording & Recorded;

  it("cases.json matches its generator (run `node tools/prototype-goldens/tiny-cases.ts`)", () => {
    expect(text("tiny", "cases.json")).toBe(serializeTinyCases());
  });

  it("expected.json is the mapping of the recordings (run `node tools/prototype-goldens/expected.ts`)", () => {
    const built = loadAndBuild();
    expect(text("tiny", "expected.json")).toBe(serialize(built.tiny));
    expect(text("crops", "expected.json")).toBe(serialize(built.crops));
  });

  it("covers all eight results", () => {
    expect(new Set(expected.results.map((r) => r.status))).toEqual(new Set(STATUSES));
  });

  it("covers every threshold, subtle, alpha, dimension, region and precedence edge", () => {
    const covered = new Set(cases.flatMap((c) => c.covers));
    const required = [
      ...STATUSES.map((s) => `status-${s}`),
      ...["missing-over-failed", "failed-over-incomparable", "missing-over-incomparable", "failed-over-added", "failed-over-removed"].map((p) => `precedence-${p}`),
      ...COMPARATOR_V1.thresholds.flatMap((t) => (t === 0 ? ["threshold-0-at", "threshold-0-above"] : [`threshold-${String(t)}-at`, `threshold-${String(t)}-above`])),
      "subtle-pixels-at",
      "subtle-pixels-above",
      "subtle-delta-at",
      "subtle-delta-above",
      "subtle-mixed",
      "channel-max",
      "delta-absolute",
      "delta-extreme",
      "alpha-only",
      "alpha-hidden-rgb",
      "alpha-visible-from-zero",
      "dimensions-height-grow",
      "dimensions-height-shrink",
      "dimensions-zero-delta",
      "dimensions-width",
      "minimum-size",
      ...["tile-boundary", "diagonal", "gap", "clip", "threshold", "sort", "sort-tie", "truncate"].map((r) => `region-${r}`),
    ];
    expect(required.filter((tag) => !covered.has(tag))).toEqual([]);
  });

  it("puts each listed delta (D1 hidden RGB, D2 width) on at least one fixture, and nothing else", () => {
    expect(new Set(cases.flatMap((c) => (c.delta ? [c.delta] : [])))).toEqual(new Set(["D1", "D2"]));
  });

  it("pins the threshold edges to the recorded counts", () => {
    const byId = new Map(expected.results.map((r) => [r.viewId, r]));
    const counts = (id: string) => byId.get(id)?.diff?.analyses.map((a) => a.changedPixels);
    expect(counts("delta-8")).toEqual([1, 0, 0, 0]);
    expect(counts("delta-9")).toEqual([1, 1, 0, 0]);
    expect(counts("delta-17")).toEqual([1, 1, 1, 0]);
    expect(counts("delta-33")).toEqual([1, 1, 1, 1]);
    expect(byId.get("subtle-128")?.status).toBe("subtle");
    expect(byId.get("subtle-129")?.status).toBe("changed");
    expect(byId.get("width-change")?.diff).toBeUndefined();
    expect(byId.get("hidden-rgb")?.status).toBe("unchanged");
    expect(byId.get("region-truncate")?.diff?.analyses[0]).toMatchObject({ regionCount: 16 });
    expect(byId.get("region-truncate")?.diff?.analyses[0]?.regions).toHaveLength(12);
  });

  it("validates as run@1 results (schema, 02 §4 precedence, diff invariants)", () => {
    expectValidRun(expected.results);
  });

  it("was recorded from the pinned prototype with the v1 constants", () => {
    expect(recording.recordedWith.prototype.commit).toBe(PIN);
    expect(recording.recordedWith.constants).toEqual({
      THRESHOLDS: [...COMPARATOR_V1.thresholds],
      SUBTLE_MAX_PIXELS: COMPARATOR_V1.subtleMaxPixels,
      SUBTLE_MAX_DELTA: COMPARATOR_V1.subtleMaxDelta,
      TILE: COMPARATOR_V1.tile,
      MAX_REGIONS: COMPARATOR_V1.maxRegions,
    });
  });

  it("agrees with the independent Python pixel hash on every captured side", () => {
    for (const c of cases) {
      for (const side of ["base", "head"] as const) {
        const spec = c[side];
        if (spec.state !== "captured") continue;
        const { width, height } = spec.image;
        expect(pixelHash({ width, height, channels: 4, data: paintTinyImage(spec.image) }), `${c.id}/${side}`).toBe(
          recording.cases[c.id]?.sides[side]?.pixelHash,
        );
      }
    }
  });
});

interface RealView {
  id: string;
  provider?: string;
  inputs: Partial<Record<"base" | "head", RecordedSide & { fileSha256: string }>>;
  prototype?: PrototypeRecord;
}

/** Maps every compared real view with the same mapping as the tiny fixtures. */
function realResults(providerId: (v: RealView) => string, views: RealView[]): RunResult[] {
  return views.flatMap((v) => {
    const { base, head } = v.inputs;
    if (!base || !head || !v.prototype) return [];
    const side = (s: RecordedSide) => ({ state: "captured" as const, pixelHash: s.pixelHash, width: s.width, height: s.height });
    const r = comparedResult(v.id, base, head, v.prototype, undefined, undefined);
    return [{ providerId: providerId(v), viewId: v.id, variantId: "desktop", ...r, base: side(base), head: side(head) }];
  });
}

describe("PropertyScope PR #123 recording (run 36405830015)", () => {
  const recording = json("propertyscope-pr123", "prototype.json") as Recorded & {
    source: { run: string; artifacts: { name: string; id: string; zipSha256: string }[] };
    summary: Record<string, number>;
    views: RealView[];
  };

  it("names the ADR 0001 inputs", () => {
    expect(recording.recordedWith.prototype.commit).toBe(PIN);
    expect(recording.source.run).toBe("36405830015");
    expect(recording.source.artifacts.map((a) => `${a.id}:${a.zipSha256.slice(0, 12)}`)).toEqual([
      "10962062704:b062b6a961b6",
      "10962640673:b6a7b4c7ceb3",
      "10962785105:1f382cc54aa3",
      "10962835047:e711eb3ebdcd",
    ]);
  });

  it("records 42 views, every one unchanged (base and head PNGs are byte-identical)", () => {
    expect(recording.views).toHaveLength(42);
    expect(recording.summary).toMatchObject({ unchanged: 42, total: 42 });
    expect(recording.views.every((v) => v.inputs.base?.fileSha256 === v.inputs.head?.fileSha256)).toBe(true);
  });

  it("maps to valid run@1 results", () => {
    const results = realResults((v) => v.provider ?? "unknown", recording.views);
    expect(results).toHaveLength(42);
    expectValidRun(results);
  });

  it("records the prototype's own states for mutated inputs", () => {
    const probes = (json("propertyscope-pr123", "state-probes.json") as { probes: { probe: string; change: string }[] }).probes;
    expect(Object.fromEntries(probes.map((p) => [p.probe, p.change]))).toEqual({
      "head-png-deleted": "incomplete",
      "head-status-failed": "incomplete",
      "base-status-failed": "base unavailable",
      "head-case-dropped": "incomplete",
      "base-case-dropped": "base unavailable",
      "head-png-width-1441": "incomplete",
      "base-part-missing": "base unavailable",
    });
  });
});

describe.each(["36287837535", "36301239732"])("TracePilot run %s recording", (run) => {
  const recording = json(`tracepilot-${run}`, "prototype.json") as Recorded & { crossCheck: { compared: number; agreeWithTracePilotPublished: number }; views: RealView[] };

  it("agrees with TracePilot's own published result on every compared view", () => {
    expect(recording.recordedWith.prototype.commit).toBe(PIN);
    expect(recording.crossCheck.compared).toBeGreaterThan(0);
    expect(recording.crossCheck.agreeWithTracePilotPublished).toBe(recording.crossCheck.compared);
  });

  it("maps to valid run@1 results with real changes", () => {
    const results = realResults(() => "fixture", recording.views);
    expect(results).toHaveLength(recording.crossCheck.compared);
    expect(results.some((r) => r.status === "changed")).toBe(true);
    expectValidRun(results);
  });
});

describe("real crops", () => {
  const recording = json("crops", "crops.json") as CropRecording;

  it("include a subtle and a changed pair", () => {
    const changes = recording.crops.map((c) => (isComparison(c.prototype) ? c.prototype.change : "error"));
    expect(changes).toContain("subtle");
    expect(changes).toContain("changed");
  });

  it.each(recording.crops.flatMap((c) => (["base", "head"] as const).map((side) => [c.sides[side].file, c.sides[side]] as const)))(
    "%s matches its recorded hash and fits the 02 §5 PNG profile",
    (file, side) => {
      const png = readFileSync(join(COMPARATOR_TESTDATA, "crops", file));
      expect(createHash("sha256").update(png).digest("hex")).toBe(side.fileSha256);
      const profile = normalizePng(png);
      expect(profile.ok ? { width: profile.width, height: profile.height } : profile.reason).toEqual({ width: side.width, height: side.height });
    },
  );

  it("maps to valid run@1 results", () => {
    expectValidRun((json("crops", "expected.json") as ExpectedFile).results);
  });
});

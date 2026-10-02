// Retention, GC and budget planning (M1.6; 03 §§1, 5; 04 §3; ADR 0012). Everything is a pure
// plan over the store index, the retained runs' records, a store-tree listing with sizes, the
// policy, an injected `now`, a PR-state snapshot, pins and the projector's file sizes. Nothing
// referenced is deleted, an unknown PR state is never closed, a malformed reference is an error,
// and protected roots that don't fit refuse the transaction.
import type { Config, Run, Side, Store } from "@pixelwatch/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blobPath } from "../src/blob-pool.ts";
import { HousekeepingError, type HousekeepingErrorCode } from "../src/housekeeping/errors.ts";
import { changesPath, derivedPath, permalinkPath, prPointerPath, runRecordPath, streamPath } from "../src/housekeeping/paths.ts";
import { type HousekeepingInput, type HousekeepingPlan, planHousekeeping } from "../src/housekeeping/plan.ts";
import { type ProjectedSizes, planBudget } from "../src/housekeeping/budget.ts";
import { planGc } from "../src/housekeeping/gc.ts";
import { type PrState, type RetentionPolicy, retentionPolicy, selectRetention } from "../src/housekeeping/retention.ts";
import { type GraceNamespace, type StoreFile, readStoreTree } from "../src/housekeeping/tree.ts";
import { addRun, newStore } from "../src/run/store.ts";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const sha = (digit: string) => digit.repeat(40);
/** A source-created time `minute` minutes after 2026-10-01T00:00:00Z. */
const t = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString().replace(".000Z", "Z");
const NOW = "2026-10-02T00:00:00Z";
const MiB = 1_048_576;

const RUN_BYTES = 1_000;
const BLOB_BYTES = 10_000;
const BIG_BLOB = 1_000_000;
const DERIVED_BYTES = 5_000;

interface RunSpec {
  readonly key: string;
  readonly at: number;
  /** `main`, `pr-<n>` (corroborated) or `none` (an unassociated pull_request run). */
  readonly stream: string;
  readonly blobs?: readonly number[];
}

/** A valid run@1 whose units each show one blob on both sides. */
function makeRun(spec: RunSpec): Run {
  const [runId = "", attempt = "1"] = spec.key.split("-a");
  const push = spec.stream === "main";
  const pr = spec.stream.startsWith("pr-") ? spec.stream.slice(3) : undefined;
  const units = [...new Set(spec.blobs ?? [])].sort((a, b) => a - b);
  const side = (b: number): Side => ({ state: "captured", pixelHash: hash(b), width: 4, height: 4 });
  const shard = { index: 1, count: 1 };
  return {
    schemaVersion: 1,
    runKey: spec.key,
    source: {
      repositoryId: "42",
      workflowId: "101",
      runId,
      attempt,
      event: push ? "push" : "pull_request",
      createdAt: t(spec.at),
      workflowRef: "refs/heads/main",
      workflowSha: sha("1"),
      association: pr === undefined ? { status: "none" } : { status: "corroborated", prNumber: pr },
      commits: push ? { head: sha("2"), base: sha("4") } : { head: sha("2"), base: sha("4"), baseBranch: sha("3") },
      configSha: sha("5"),
      releaseSha: sha("6"),
    },
    claims: {},
    versions: { release: "0.1.0", config: 1, comparator: 1, bundle: 1, data: 1 },
    parts: [
      { revision: "base", providerId: "p", shard, status: "valid", artifactId: "1" },
      { revision: "head", providerId: "p", shard, status: "valid", artifactId: "2" },
    ],
    coverage: { status: "complete-declared", declaredUnits: units.length, accountedUnits: units.length, missingParts: [] },
    counts: { missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: units.length, subtle: 0, changed: 0 },
    results: units.map((b) => ({
      providerId: "p",
      viewId: `v${String(b).padStart(4, "0")}`,
      variantId: "desktop",
      status: "unchanged",
      reasons: [],
      base: side(b),
      head: side(b),
    })),
  };
}

interface World {
  readonly store: Store;
  readonly runs: Map<string, Run>;
  readonly files: StoreFile[];
}

/** Adds every run through addRun (in the given order) and lists the store tree with sizes. */
function world(specs: readonly RunSpec[], blobBytes = BLOB_BYTES): World {
  let store = newStore("42");
  const runs = new Map<string, Run>();
  const blobs = new Set<number>();
  for (const spec of specs) {
    const run = makeRun(spec);
    runs.set(run.runKey, run);
    store = addRun(store, run).store;
    for (const b of spec.blobs ?? []) blobs.add(b);
  }
  const files: StoreFile[] = [{ path: "store.json", bytes: 300 }];
  for (const key of runs.keys()) files.push({ path: runRecordPath(key), bytes: RUN_BYTES });
  for (const b of blobs) files.push({ path: blobPath(hash(b)), bytes: blobBytes });
  return { store, runs, files };
}

const PROJECTED: ProjectedSizes = {
  fixed: [
    { path: "index.html", bytes: 2_000, category: "html" },
    { path: "site.json", bytes: 1_000, category: "data" },
    { path: "app/0.1.0/app.js", bytes: 100_000, category: "app" },
    { path: "api/v1/index.json", bytes: 500, category: "api" },
    { path: "llms.txt", bytes: 1_500, category: "api" },
  ],
  changes: () => 3_000,
  permalink: () => 700,
  stream: (_streamId, runKeys) => 100 + 20 * runKeys.length,
  prPointer: () => 250,
};

const POLICY: RetentionPolicy = { mainRuns: 30, runsPerPr: 5, prStreams: 30 };

function input(w: World, overrides: Partial<HousekeepingInput> = {}): HousekeepingInput {
  return {
    ...w,
    policy: POLICY,
    limits: { softBytes: 400 * MiB, hardBytes: 500 * MiB },
    now: NOW,
    prStates: new Map(),
    projected: PROJECTED,
    ...overrides,
  };
}

function ok(plan: HousekeepingPlan): Extract<HousekeepingPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`refused: ${plan.refusal.reason}`);
  return plan;
}

const keys = (runs: readonly { runKey: string }[]) => runs.map((r) => r.runKey);

function expectCode(fn: () => unknown, code: HousekeepingErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HousekeepingError);
    expect((error as HousekeepingError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} refusal`);
}

/** The store and tree after applying a plan's deletions: what the next (maintenance) transaction reads. */
function applied(before: HousekeepingInput, plan: Extract<HousekeepingPlan, { ok: true }>): HousekeepingInput {
  const deleted = new Set(plan.gc.delete.map((f) => f.path));
  return { ...before, store: plan.gc.store, files: before.files.filter((f) => !deleted.has(f.path)), newRun: undefined };
}

describe("retention (03 §5)", () => {
  it("keeps the latest N main runs and the latest N runs per PR", () => {
    const w = world([
      ...[1, 2, 3, 4, 5].map((n) => ({ key: `${String(n)}-a1`, at: n, stream: "main" })),
      ...[10, 11, 12, 13].map((n) => ({ key: `${String(n)}-a1`, at: n, stream: "pr-7" })),
    ]);
    const plan = selectRetention({ store: w.store, policy: { mainRuns: 3, runsPerPr: 2, prStreams: 30 }, prStates: new Map([["7", "open"]]) });
    expect(keys(plan.retained)).toEqual(["3-a1", "4-a1", "5-a1", "12-a1", "13-a1"]);
    expect(plan.expired).toEqual([
      { runKey: "1-a1", stream: "main", reason: "main-limit" },
      { runKey: "2-a1", stream: "main", reason: "main-limit" },
      { runKey: "10-a1", stream: "pr-7", reason: "pr-run-limit" },
      { runKey: "11-a1", stream: "pr-7", reason: "pr-run-limit" },
    ]);
    expect(plan.retained.filter((r) => r.protected).map((r) => r.runKey)).toEqual(["5-a1", "13-a1"]);
  });

  it("keeps open PR streams first by most recent capture, then recently closed ones", () => {
    const w = world([
      { key: "11-a1", at: 1, stream: "pr-1" },
      { key: "21-a1", at: 9, stream: "pr-2" },
      { key: "31-a1", at: 5, stream: "pr-3" },
      { key: "41-a1", at: 7, stream: "pr-4" },
    ]);
    const prStates = new Map<string, PrState>([
      ["1", "open"],
      ["2", "closed"],
      ["3", "open"],
      ["4", "closed"],
    ]);
    const plan = selectRetention({ store: w.store, policy: { ...POLICY, prStreams: 3 }, prStates });
    expect(plan.prStreams.map((s) => [s.streamId, s.state, s.retained])).toEqual([
      ["pr-3", "open", true],
      ["pr-1", "open", true],
      ["pr-2", "closed", true],
      ["pr-4", "closed", false],
    ]);
    expect(plan.expired).toEqual([{ runKey: "41-a1", stream: "pr-4", reason: "pr-stream-limit" }]);
    // Open PRs' latest runs are protected; a closed PR's never is.
    expect(plan.retained.filter((r) => r.protected).map((r) => r.runKey)).toEqual(["11-a1", "31-a1"]);
  });

  it("orders history numerically (9 < 10, a2 < a10), never lexically or by publish order", () => {
    // Published newest first, so insertion order disagrees with history order.
    const w = world([
      { key: "20-a10", at: 6, stream: "pr-20" },
      { key: "20-a2", at: 6, stream: "pr-20" },
      { key: "100-a1", at: 5, stream: "pr-10" },
      { key: "30-a1", at: 5, stream: "pr-9" },
      { key: "10-a1", at: 1, stream: "main" },
      { key: "9-a1", at: 1, stream: "main" },
    ]);
    expect(keys(w.store.runs)).toEqual(["9-a1", "10-a1", "30-a1", "100-a1", "20-a2", "20-a10"]);
    const plan = selectRetention({
      store: w.store,
      policy: { mainRuns: 1, runsPerPr: 1, prStreams: 2 },
      prStates: new Map([
        ["9", "open"],
        ["10", "open"],
        ["20", "open"],
      ]),
    });
    // main keeps 10-a1 over 9-a1; pr-20 keeps attempt 10 over attempt 2; pr-10 (latest 100-a1)
    // outranks pr-9 (latest 30-a1) at the same created time, so pr-9 loses the second slot.
    expect(keys(plan.retained)).toEqual(["10-a1", "100-a1", "20-a10"]);
    expect(plan.prStreams.map((s) => [s.streamId, s.retained])).toEqual([
      ["pr-20", true],
      ["pr-10", true],
      ["pr-9", false],
    ]);
  });

  it("never treats an unknown PR state as closed, and reports it", () => {
    const w = world([
      { key: "50-a1", at: 1, stream: "pr-5" },
      { key: "60-a1", at: 2, stream: "pr-6" },
      { key: "70-a1", at: 9, stream: "pr-7" },
    ]);
    // pr-5 is missing from the snapshot (the lookup failed); pr-6 is explicitly unknown.
    const prStates = new Map<string, PrState>([
      ["6", "unknown"],
      ["7", "closed"],
    ]);
    const plan = selectRetention({ store: w.store, policy: { ...POLICY, prStreams: 2 }, prStates });
    expect(plan.prStreams.map((s) => [s.streamId, s.state, s.retained])).toEqual([
      ["pr-6", "unknown", true],
      ["pr-5", "unknown", true],
      ["pr-7", "closed", false],
    ]);
    expect(plan.unknownPrStates).toEqual(["5", "6"]);
    expect(plan.retained.map((r) => [r.runKey, r.runClass, r.protected])).toEqual([
      ["50-a1", "unknown-pr", true],
      ["60-a1", "unknown-pr", true],
    ]);
  });

  it("never prunes an unknown PR as closed under budget pressure", () => {
    const w = world(
      [
        { key: "50-a1", at: 1, stream: "pr-5", blobs: [50] },
        { key: "51-a1", at: 2, stream: "pr-5", blobs: [51] },
        { key: "70-a1", at: 8, stream: "pr-7", blobs: [70] },
        { key: "71-a1", at: 9, stream: "pr-7", blobs: [71] },
        { key: "1-a1", at: 10, stream: "main", blobs: [1] },
      ],
      BIG_BLOB,
    );
    const prStates = new Map<string, PrState>([["7", "closed"]]);
    const at = (hardBytes: number) => planHousekeeping(input(w, { prStates, limits: { softBytes: hardBytes, hardBytes } }));

    // The newer closed PR's history goes first, even though pr-5 is older.
    const two = ok(at(3.5 * BIG_BLOB));
    expect(keys(two.budget.pruned)).toEqual(["70-a1", "71-a1"]);
    expect(two.retention.unknownPrStates).toEqual(["5"]);

    // Then pr-5's older run, but never its latest.
    const three = ok(at(2.5 * BIG_BLOB));
    expect(keys(three.budget.pruned)).toEqual(["70-a1", "71-a1", "50-a1"]);
    expect(keys(three.budget.retained)).toEqual(["51-a1", "1-a1"]);

    const refused = at(1.5 * BIG_BLOB);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.protectedRuns).toEqual(["51-a1", "1-a1"]);
  });

  it("keeps the latest runsPerPr unassociated runs as one group, never protected", () => {
    const w = world([1, 2, 3, 4].map((n) => ({ key: `${String(n)}-a1`, at: n, stream: "none" })));
    const plan = selectRetention({ store: w.store, policy: { ...POLICY, runsPerPr: 2 }, prStates: new Map() });
    expect(plan.retained.map((r) => [r.runKey, r.runClass, r.protected])).toEqual([
      ["3-a1", "unassociated", false],
      ["4-a1", "unassociated", false],
    ]);
    expect(plan.expired.map((e) => [e.runKey, e.reason])).toEqual([
      ["1-a1", "unassociated-limit"],
      ["2-a1", "unassociated-limit"],
    ]);
  });

  it("keeps pinned runs past the count limits and reports unknown pins", () => {
    const w = world([1, 2, 3].map((n) => ({ key: `${String(n)}-a1`, at: n, stream: "main" })));
    const plan = selectRetention({ store: w.store, policy: { ...POLICY, mainRuns: 1 }, prStates: new Map(), pins: new Set(["99-a1", "1-a1"]) });
    expect(plan.retained.map((r) => [r.runKey, r.pinned])).toEqual([
      ["1-a1", true],
      ["3-a1", false],
    ]);
    expect(plan.unknownPins).toEqual(["99-a1"]);
  });

  it("refuses malformed policy, PR-state and pin inputs", () => {
    const { store } = world([{ key: "1-a1", at: 1, stream: "main" }]);
    const base = { store, policy: POLICY, prStates: new Map<string, PrState>() };
    expectCode(() => selectRetention({ ...base, prStates: new Map([["07", "open"]]) }), "invalid-input");
    expectCode(() => selectRetention({ ...base, prStates: new Map([["7", "merged" as PrState]]) }), "invalid-input");
    expectCode(() => selectRetention({ ...base, pins: new Set(["main"]) }), "invalid-input");
    expectCode(() => selectRetention({ ...base, policy: { ...POLICY, mainRuns: 0 } }), "invalid-input");
    expectCode(() => selectRetention({ ...base, policy: { ...POLICY, prStreams: 1.5 } }), "invalid-input");
    expectCode(() => selectRetention({ ...base, store: { ...store, txn: -1 } }), "invalid-input");
  });

  it("takes config@1's retention with its defaults", () => {
    const config: Config = { schemaVersion: 1, source: { workflowIds: ["1"], events: ["push"] }, providers: [{ id: "p", shards: 1 }] };
    expect(retentionPolicy(config)).toEqual({ mainRuns: 30, runsPerPr: 5, prStreams: 30 });
    expect(retentionPolicy({ ...config, retention: { prStreams: 0 } })).toEqual({ mainRuns: 30, runsPerPr: 5, prStreams: 0 });
  });
});

/** Two main runs expire; one open PR keeps only its latest; blob 1 is shared, derived 901/903 are run-owned, 999 is stray. */
function sweepWorld(): HousekeepingInput {
  const w = world([
    { key: "1-a1", at: 1, stream: "main", blobs: [1, 11] },
    { key: "2-a1", at: 2, stream: "main", blobs: [1, 12] },
    { key: "3-a1", at: 3, stream: "main", blobs: [1, 13] },
    { key: "70-a1", at: 4, stream: "pr-7", blobs: [1, 70] },
    { key: "71-a1", at: 5, stream: "pr-7", blobs: [71] },
  ]);
  const derived = new Map<string, readonly string[]>([
    ["1-a1", [hash(901)]],
    ["2-a1", []],
    ["3-a1", [hash(903)]],
    ["70-a1", []],
    ["71-a1", []],
  ]);
  const files = [...w.files, ...[901, 903, 999].map((n) => ({ path: derivedPath(hash(n)), bytes: DERIVED_BYTES }))];
  return input({ ...w, files }, { derived, policy: { mainRuns: 2, runsPerPr: 1, prStreams: 30 }, prStates: new Map([["7", "open"]]) });
}

describe("GC planning (03 §5)", () => {
  it("deletes nothing referenced by a retained run: no blob, derived file, API file, PR pointer or permalink page", () => {
    const before = sweepWorld();
    const plan = ok(planHousekeeping(before));
    expect(keys(plan.budget.retained)).toEqual(["2-a1", "3-a1", "71-a1"]);
    const deleted = new Set(plan.gc.delete.map((f) => f.path));
    const removed = new Set(plan.served.removed.map((f) => f.path));
    const served = new Set(plan.budget.site.map((f) => f.path));

    for (const { runKey } of plan.budget.retained) {
      const run = before.runs.get(runKey);
      if (run === undefined) throw new Error(runKey);
      const owned = [
        runRecordPath(runKey),
        ...run.results.flatMap((r) => [r.base, r.head]).flatMap((s) => (s.state === "captured" ? [blobPath(s.pixelHash)] : [])),
        ...(before.derived?.get(runKey) ?? []).map(derivedPath),
      ];
      for (const path of owned) {
        expect(deleted, path).not.toContain(path);
        expect(removed, path).not.toContain(path);
        expect(served, path).toContain(path);
      }
      for (const path of [changesPath(runKey), permalinkPath(runKey)]) {
        expect(removed, path).not.toContain(path);
        expect(served, path).toContain(path);
      }
    }
    expect(served).toContain(prPointerPath("7"));
    expect(removed).not.toContain(prPointerPath("7"));
    expect(served).toContain(streamPath("main"));
    expect(served).toContain(streamPath("pr-7"));
    // The expired runs' served files go with them.
    for (const runKey of ["1-a1", "70-a1"]) {
      expect(removed).toContain(changesPath(runKey));
      expect(removed).toContain(permalinkPath(runKey));
      expect(served).not.toContain(changesPath(runKey));
    }
  });

  it("lists the exact store paths and bytes it would delete, as a dry run", () => {
    const before = sweepWorld();
    const snapshot = structuredClone({ store: before.store, files: before.files });
    const plan = ok(planHousekeeping(before));
    expect(plan.gc.delete).toEqual(
      [
        { path: runRecordPath("1-a1"), bytes: RUN_BYTES },
        { path: runRecordPath("70-a1"), bytes: RUN_BYTES },
        { path: blobPath(hash(11)), bytes: BLOB_BYTES },
        { path: blobPath(hash(70)), bytes: BLOB_BYTES },
        { path: derivedPath(hash(901)), bytes: DERIVED_BYTES },
        { path: derivedPath(hash(999)), bytes: DERIVED_BYTES },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    );
    expect(plan.gc.deleteBytes).toBe(2 * RUN_BYTES + 2 * BLOB_BYTES + 2 * DERIVED_BYTES);
    expect(plan.gc.storeBytes.after).toBe(plan.gc.storeBytes.before - plan.gc.deleteBytes);
    expect(keys(plan.gc.store.runs)).toEqual(["2-a1", "3-a1", "71-a1"]);
    expect(plan.gc.store.txn).toBe(before.store.txn + 1);
    expect(plan.gc.removedRuns).toEqual(["1-a1", "70-a1"]);
    // A dry run: the inputs are untouched.
    expect({ store: before.store, files: before.files }).toEqual(snapshot);
  });

  it("is a no-op when run on its own output", () => {
    const before = sweepWorld();
    const first = ok(planHousekeeping(before));
    const again = ok(planHousekeeping(applied(before, first)));
    expect(again.gc.delete).toEqual([]);
    expect(again.gc.changed).toBe(false);
    expect(again.gc.store).toBe(first.gc.store);
    expect(again.served.removed).toEqual([]);
    expect(keys(again.budget.retained)).toEqual(keys(first.budget.retained));
  });

  it("refuses a malformed reference instead of widening deletion", () => {
    const before = sweepWorld();
    const without = (path: string) => before.files.filter((f) => f.path !== path);
    // A retained run's blob or derived file is missing.
    expectCode(() => planHousekeeping({ ...before, files: without(blobPath(hash(13))) }), "missing-file");
    expectCode(() => planHousekeeping({ ...before, files: without(derivedPath(hash(903))) }), "missing-file");
    // An index entry without its record, and a record without an index entry.
    expectCode(() => planHousekeeping({ ...before, files: without(runRecordPath("2-a1")) }), "missing-file");
    expectCode(() => planHousekeeping({ ...before, files: [...before.files, { path: runRecordPath("9-a1"), bytes: 1 }] }), "orphan-file");
    // A namespace no grace record accounts for.
    expectCode(() => planHousekeeping({ ...before, files: [...before.files, { path: "data/v2/runs/1-a1/run.json", bytes: 1 }] }), "orphan-file");
    // Run data that disagrees with the index, or isn't supplied.
    const runs = new Map(before.runs);
    runs.set("3-a1", makeRun({ key: "3-a1", at: 3, stream: "pr-9", blobs: [1, 13] }));
    expectCode(() => planHousekeeping({ ...before, runs }), "run-mismatch");
    runs.delete("3-a1");
    expectCode(() => planHousekeeping({ ...before, runs }), "missing-run-data");
    // Derived references unknown for a retained run.
    const derived = new Map(before.derived);
    derived.delete("3-a1");
    expectCode(() => planHousekeeping({ ...before, derived }), "unknown-references");
    // A malformed listing.
    expectCode(() => planHousekeeping({ ...before, files: [...before.files, { path: "store.json", bytes: 1 }] }), "invalid-input");
    expectCode(() => planHousekeeping({ ...before, files: [{ path: "store.json", bytes: -1 }] }), "invalid-input");
    expectCode(() => planHousekeeping({ ...before, now: "2026-10-02" }), "invalid-input");
  });

  it("refuses store files outside the 03 §3 layout rather than serving or deleting them", () => {
    const before = sweepWorld();
    const grace: GraceNamespace[] = [{ namespace: "data/v2", until: "2026-10-15T00:00:00Z", blobs: [] }];
    const paths = [
      "index.html",
      "app/0.1.0/app.js",
      "data/v1/streams/main.json",
      "data/v1/runs/1-a1/index.html",
      "data/v2/runs/1-a1/run.js",
      "data/v2/../x.json",
      `blobs/ff/${hash(1)}.png`,
      `blobs/00/${hash(1)}.PNG`,
      `blobs/00/${hash(1)}.svg`,
      "blobs/../store.json",
    ];
    for (const path of paths) {
      expectCode(() => planHousekeeping({ ...before, grace, files: [...before.files, { path, bytes: 1 }] }), "unrecognized-path");
    }
    // A valid tree's site holds only generated paths, run records, pooled PNGs and grace JSON.
    const plan = ok(planHousekeeping({ ...before, grace, files: [...before.files, { path: "data/v2/runs/1-a1/run.json", bytes: 1 }] }));
    const fixed = new Set(PROJECTED.fixed.map((f) => f.path));
    const generated = /^(?:runs\/[^/]+\/index\.html|api\/v1\/(?:runs\/[^/]+\/changes|pr\/[0-9]+\/latest)\.json|data\/v[0-9]+\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.json|(?:blobs|derived)\/[0-9a-f]{2}\/[0-9a-f]{64}\.png)$/;
    for (const { path } of plan.budget.site) expect(fixed.has(path) || generated.test(path), path).toBe(true);
  });

  it("keeps every derived file while their references are unknown", () => {
    const before = sweepWorld();
    const plan = ok(planHousekeeping({ ...before, derived: undefined }));
    expect(plan.gc.delete.filter((f) => f.path.startsWith("derived/"))).toEqual([]);
    expect(plan.budget.breakdown.derived).toBe(3 * DERIVED_BYTES);
    // A grace namespace naming one of them doesn't count it twice.
    const grace: GraceNamespace[] = [{ namespace: "data/v2", until: "2026-10-15T00:00:00Z", blobs: [], derived: [hash(903)] }];
    const files = [...before.files, { path: "data/v2/runs/1-a1/run.json", bytes: 800 }];
    const withGrace = ok(planHousekeeping({ ...before, files, grace, derived: undefined }));
    expect(withGrace.budget.breakdown.derived).toBe(3 * DERIVED_BYTES);
    expect(withGrace.budget.totalBytes).toBe(plan.budget.totalBytes + 800);
  });

  it("keeps live grace namespaces and their blobs as roots, and deletes expired ones", () => {
    // store@1 has only data/v1, so a test-only data/v2 stands in for the pre-migration namespace (04 §3).
    const w = world([{ key: "1-a1", at: 1, stream: "main", blobs: [1] }]);
    const files = [...w.files, { path: "data/v2/runs/1-a1/run.json", bytes: 800 }, { path: blobPath(hash(50)), bytes: BLOB_BYTES }];
    const grace = (until: string): GraceNamespace[] => [{ namespace: "data/v2", until, blobs: [hash(50)] }];

    const live = ok(planHousekeeping(input({ ...w, files }, { grace: grace("2026-10-15T00:00:00Z") })));
    expect(live.gc.delete).toEqual([]);
    expect(live.budget.breakdown.grace).toBe(800);
    expect(live.budget.breakdown.blobs).toBe(2 * BLOB_BYTES);
    expect(live.budget.grace).toEqual({ kept: ["data/v2"], dropped: [] });

    const expired = ok(planHousekeeping(input({ ...w, files }, { grace: grace(NOW) })));
    expect(expired.gc.delete).toEqual([
      { path: blobPath(hash(50)), bytes: BLOB_BYTES },
      { path: "data/v2/runs/1-a1/run.json", bytes: 800 },
    ]);
    expect(expired.budget.grace).toEqual({ kept: [], dropped: [{ namespace: "data/v2", reason: "expired" }] });
    // A live namespace's reference to a missing blob is an error, not an empty root.
    expectCode(() => planHousekeeping(input({ ...w, files: files.filter((f) => f.path !== blobPath(hash(50))) }, { grace: grace("2026-10-15T00:00:00Z") })), "missing-file");
  });

  it("refuses keep sets that name runs or namespaces the store doesn't have", () => {
    const before = sweepWorld();
    const graph = readStoreTree(before);
    expectCode(() => planGc(graph, { runs: new Set(["404-a1"]), grace: new Set() }), "invalid-input");
    expectCode(() => planGc(graph, { runs: new Set(), grace: new Set(["data/v3"]) }), "invalid-input");
  });
});

describe("budget planning (03 §1)", () => {
  it("counts API files, stubs, derived files and grace copies, not just blobs", () => {
    const w = world([
      { key: "1-a1", at: 1, stream: "main", blobs: [1] },
      { key: "70-a1", at: 2, stream: "pr-7", blobs: [2] },
      { key: "80-a1", at: 3, stream: "none", blobs: [1] },
    ]);
    const files = [...w.files, { path: derivedPath(hash(901)), bytes: DERIVED_BYTES }, { path: "data/v2/runs/1-a1/run.json", bytes: 800 }];
    const plan = ok(
      planHousekeeping(
        input(
          { ...w, files },
          {
            prStates: new Map([["7", "open"]]),
            derived: new Map([
              ["1-a1", [hash(901)]],
              ["70-a1", []],
              ["80-a1", []],
            ]),
            grace: [{ namespace: "data/v2", until: "2026-10-15T00:00:00Z", blobs: [] }],
          },
        ),
      ),
    );
    expect(plan.budget.breakdown).toEqual({
      html: 2_000,
      app: 100_000,
      // api/v1/index.json + llms.txt + three changes.json + pr-7's latest.json
      api: 500 + 1_500 + 3 * 3_000 + 250,
      stubs: 3 * 700,
      // site.json + three run records + the main and pr-7 stream files
      data: 1_000 + 3 * RUN_BYTES + 2 * (100 + 20),
      blobs: 2 * BLOB_BYTES,
      derived: DERIVED_BYTES,
      grace: 800,
    });
    const sum = Object.values(plan.budget.breakdown).reduce((a, b) => a + b, 0);
    expect(plan.budget.totalBytes).toBe(sum);
    expect(plan.budget.site.reduce((a, f) => a + f.bytes, 0)).toBe(sum);
    expect(plan.budget.overSoftLimit).toBe(false);
  });

  it("warns over the soft limit with a size breakdown", () => {
    const w = world([{ key: "1-a1", at: 1, stream: "main", blobs: [1] }]);
    const total = ok(planHousekeeping(input(w))).budget.totalBytes;
    const warned = ok(planHousekeeping(input(w, { limits: { softBytes: total - 1, hardBytes: total } })));
    expect(warned.budget.overSoftLimit).toBe(true);
    expect(warned.budget.pruned).toEqual([]);
    expect(warned.budget.breakdown.blobs).toBe(BLOB_BYTES);
    expect(ok(planHousekeeping(input(w, { limits: { softBytes: total, hardBytes: total } }))).budget.overSoftLimit).toBe(false);
  });

  it("prunes oldest unpinned closed-PR history first, then unassociated runs, then other unpinned runs, then pinned ones", () => {
    const w = world(
      [
        { key: "80-a1", at: 1, stream: "pr-8", blobs: [80] },
        { key: "90-a1", at: 2, stream: "none", blobs: [90] },
        { key: "1-a1", at: 3, stream: "main", blobs: [1] },
        { key: "2-a1", at: 4, stream: "main", blobs: [2] },
        { key: "81-a1", at: 5, stream: "pr-8", blobs: [81] },
        { key: "70-a1", at: 6, stream: "pr-7", blobs: [70] },
        { key: "71-a1", at: 7, stream: "pr-7", blobs: [71] },
        { key: "3-a1", at: 9, stream: "main", blobs: [3] },
      ],
      BIG_BLOB,
    );
    const plan = ok(
      planHousekeeping(
        input(w, {
          prStates: new Map([
            ["7", "open"],
            ["8", "closed"],
          ]),
          pins: new Set(["1-a1"]),
          limits: { softBytes: 2.5 * BIG_BLOB, hardBytes: 2.5 * BIG_BLOB },
        }),
      ),
    );
    expect(plan.budget.pruned.map((p) => [p.runKey, p.reason])).toEqual([
      ["80-a1", "closed-pr"],
      ["81-a1", "closed-pr"],
      ["90-a1", "unassociated"],
      ["2-a1", "unpinned"],
      ["70-a1", "unpinned"],
      ["1-a1", "pinned"],
    ]);
    // The latest main run and the open PR's latest run are always kept.
    expect(keys(plan.budget.retained)).toEqual(["71-a1", "3-a1"]);
    expect(plan.budget.totalBytes).toBeLessThanOrEqual(2.5 * BIG_BLOB);
    expect(plan.gc.delete.filter((f) => f.path.startsWith("blobs/")).map((f) => f.path)).toEqual(
      [80, 90, 1, 2, 81, 70].map((n) => blobPath(hash(n))).sort(),
    );
    // Pruned runs leave the served tree too: pr-8's pointer and stream file go with its history.
    const removed = plan.served.removed.map((f) => f.path);
    expect(removed).toContain(prPointerPath("8"));
    expect(removed).toContain(streamPath("pr-8"));
  });

  it("drops grace copies before any history under hard-limit pressure", () => {
    const w = world(
      [
        { key: "1-a1", at: 1, stream: "main", blobs: [1] },
        { key: "2-a1", at: 2, stream: "main", blobs: [2] },
      ],
      BIG_BLOB,
    );
    const files = [...w.files, { path: "data/v2/runs/1-a1/run.json", bytes: BIG_BLOB }];
    const plan = ok(
      planHousekeeping(
        input(
          { ...w, files },
          {
            grace: [{ namespace: "data/v2", until: "2026-10-15T00:00:00Z", blobs: [] }],
            limits: { softBytes: 2.5 * BIG_BLOB, hardBytes: 2.5 * BIG_BLOB },
          },
        ),
      ),
    );
    expect(plan.budget.grace).toEqual({ kept: [], dropped: [{ namespace: "data/v2", reason: "budget" }] });
    expect(plan.budget.pruned).toEqual([]);
    expect(plan.gc.delete).toEqual([{ path: "data/v2/runs/1-a1/run.json", bytes: BIG_BLOB }]);
  });

  it("refuses the transaction when the protected roots plus the new run don't fit", () => {
    const w = world(
      [
        { key: "1-a1", at: 1, stream: "main", blobs: [1] },
        { key: "2-a1", at: 2, stream: "main", blobs: [2] },
        { key: "70-a1", at: 3, stream: "pr-7", blobs: [70] },
        { key: "90-a1", at: 4, stream: "none", blobs: [90] },
      ],
      BIG_BLOB,
    );
    const limits = { softBytes: 2.5 * BIG_BLOB, hardBytes: 2.5 * BIG_BLOB };
    const prStates = new Map<string, PrState>([["7", "open"]]);

    // Without the new run's protection, the unassociated run is pruned and the rest fit.
    expect(keys(ok(planHousekeeping(input(w, { limits, prStates }))).budget.pruned)).toEqual(["90-a1", "1-a1"]);

    const plan = planHousekeeping(input(w, { limits, prStates, newRun: "90-a1" }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    const { refusal } = plan;
    expect(refusal.protectedRuns).toEqual(["2-a1", "70-a1", "90-a1"]);
    expect(refusal.hardBytes).toBe(2.5 * BIG_BLOB);
    expect(refusal.totalBytes).toBeGreaterThan(refusal.hardBytes);
    expect(refusal.neededBytes).toBe(refusal.totalBytes - refusal.hardBytes);
    expect(refusal.breakdown.blobs).toBe(3 * BIG_BLOB);
    expect(refusal.reason).toMatch(/protected/);
    expect(plan).not.toHaveProperty("gc");
  });

  it("reports a new run that retention expires instead of protecting it past the policy", () => {
    // An old main run published late, after two newer ones, with mainRuns 2.
    const w = world([
      { key: "1-a1", at: 1, stream: "main" },
      { key: "2-a1", at: 2, stream: "main" },
      { key: "3-a1", at: 3, stream: "main" },
    ]);
    const plan = ok(planHousekeeping(input(w, { policy: { ...POLICY, mainRuns: 2 }, newRun: "1-a1" })));
    expect(plan.newRunExpired).toBe(true);
    expect(plan.retention.expired).toEqual([{ runKey: "1-a1", stream: "main", reason: "main-limit" }]);
    expect(plan.gc.removedRuns).toEqual(["1-a1"]);
    expect(ok(planHousekeeping(input(w, { newRun: "3-a1" }))).newRunExpired).toBe(false);
    expectCode(() => planHousekeeping(input(w, { newRun: "4-a1" })), "invalid-input");
  });

  it("refuses projected sizes that aren't byte counts", () => {
    const w = world([{ key: "1-a1", at: 1, stream: "main" }]);
    const graph = readStoreTree(w);
    const retention = selectRetention({ store: w.store, policy: POLICY, prStates: new Map() });
    const plan = (projected: ProjectedSizes) => planBudget({ graph, retention, now: NOW, projected, limits: { softBytes: MiB, hardBytes: MiB } });
    expectCode(() => plan({ ...PROJECTED, changes: () => Number.NaN }), "invalid-input");
    expectCode(() => plan({ ...PROJECTED, permalink: () => -1 }), "invalid-input");
    expectCode(() => plan({ ...PROJECTED, fixed: [...PROJECTED.fixed, { path: runRecordPath("1-a1"), bytes: 1, category: "data" }] }), "invalid-input");
  });
});

interface Generated {
  readonly specs: readonly RunSpec[];
  readonly prStates: ReadonlyMap<string, PrState>;
  readonly pins: ReadonlySet<string>;
  readonly policy: RetentionPolicy;
  readonly hardPercent: number;
  readonly newRun: string | undefined;
  readonly seed: number;
}

// Seeded worlds: any mix of streams, attempts, shared blobs, PR states, pins and limits.
const worldArb = fc
  .record({
    specs: fc.uniqueArray(
      fc.record({
        runId: fc.integer({ min: 1, max: 40 }),
        attempt: fc.integer({ min: 1, max: 12 }),
        at: fc.integer({ min: 0, max: 30 }),
        stream: fc.constantFrom("main", "pr-1", "pr-2", "pr-9", "pr-10", "none"),
        blobs: fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 4 }),
      }),
      { selector: (s) => `${String(s.runId)}-a${String(s.attempt)}`, minLength: 1, maxLength: 24 },
    ),
    states: fc.array(fc.constantFrom<PrState | undefined>("open", "closed", "unknown", undefined), { minLength: 4, maxLength: 4 }),
    pinMask: fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
    policy: fc.record({ mainRuns: fc.integer({ min: 1, max: 4 }), runsPerPr: fc.integer({ min: 1, max: 3 }), prStreams: fc.integer({ min: 0, max: 3 }) }),
    hardPercent: fc.integer({ min: 20, max: 120 }),
    newRunIndex: fc.option(fc.nat({ max: 23 })),
    seed: fc.integer(),
  })
  .map((g): Generated => {
    const specs: RunSpec[] = g.specs.map((s) => ({ key: `${String(s.runId)}-a${String(s.attempt)}`, at: s.at, stream: s.stream, blobs: s.blobs }));
    const prStates = new Map<string, PrState>();
    ["1", "2", "9", "10"].forEach((pr, i) => {
      const state = g.states[i];
      if (state !== undefined) prStates.set(pr, state);
    });
    const pins = new Set(specs.filter((_, i) => g.pinMask[i] === true).map((s) => s.key));
    const newRun = g.newRunIndex === null ? undefined : specs[g.newRunIndex % specs.length]?.key;
    return { specs, prStates, pins, policy: g.policy, hardPercent: g.hardPercent, newRun, seed: g.seed };
  });

/** A deterministic permutation, so a failing seed replays. */
function permute<T>(items: readonly T[], seed: number): T[] {
  let x = seed | 0 || 1;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function generated(g: Generated, order = 0): HousekeepingInput {
  const specs = order === 0 ? g.specs : permute(g.specs, g.seed + order);
  const w = world(specs);
  const unlimited = input(w, { policy: g.policy, prStates: g.prStates, pins: g.pins, newRun: g.newRun });
  const plan = planHousekeeping(unlimited);
  const total = plan.ok ? plan.budget.totalBytes : 0;
  const hardBytes = Math.max(1, Math.floor((total * g.hardPercent) / 100));
  const shuffle = <K, V>(m: ReadonlyMap<K, V>) => new Map(permute([...m], g.seed + order));
  return {
    ...unlimited,
    files: order === 0 ? w.files : permute(w.files, g.seed + order),
    runs: order === 0 ? w.runs : shuffle(w.runs),
    prStates: order === 0 ? g.prStates : shuffle(g.prStates),
    pins: order === 0 ? g.pins : new Set(permute([...g.pins], g.seed + order)),
    limits: { softBytes: hardBytes, hardBytes },
  };
}

describe("housekeeping properties", () => {
  it("reproduces the same selection from fixed time and PR-state inputs, whatever the input order", () => {
    fc.assert(
      fc.property(worldArb, (g) => {
        const reference = planHousekeeping(generated(g));
        for (const order of [1, 2]) expect(planHousekeeping(generated(g, order))).toEqual(reference);
      }),
      { numRuns: 150 },
    );
  });

  it("never deletes a retained run's files, and GC on its own output deletes nothing", () => {
    fc.assert(
      fc.property(worldArb, (g) => {
        const before = generated(g);
        const plan = planHousekeeping(before);
        if (!plan.ok) {
          // Only protected roots (and the new run) may cause a refusal.
          expect(plan.refusal.totalBytes).toBeGreaterThan(plan.refusal.hardBytes);
          return;
        }
        expect(plan.budget.totalBytes).toBeLessThanOrEqual(before.limits.hardBytes);
        const deleted = new Set(plan.gc.delete.map((f) => f.path));
        for (const { runKey } of plan.budget.retained) {
          expect(deleted).not.toContain(runRecordPath(runKey));
          for (const r of before.runs.get(runKey)?.results ?? []) {
            if (r.head.state === "captured") expect(deleted).not.toContain(blobPath(r.head.pixelHash));
          }
        }
        // Protected runs survive every budget.
        for (const r of plan.retention.retained.filter((x) => x.protected || x.runKey === before.newRun)) {
          expect(keys(plan.budget.retained)).toContain(r.runKey);
        }
        const again = ok(planHousekeeping(applied(before, plan)));
        expect(again.gc.delete).toEqual([]);
        expect(again.gc.changed).toBe(false);
        expect(again.budget.pruned).toEqual([]);
        expect(keys(again.budget.retained)).toEqual(keys(plan.budget.retained));
      }),
      { numRuns: 150 },
    );
  });
});

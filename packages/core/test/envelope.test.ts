// Runs and the store run index (M1.5; 01 §§4.3–4.5; 02 §§4, 6, 8; ADR 0010). The trusted
// envelope alone decides identity, commits, association and stream; capture claims ride along as
// untrusted data. Ingestion side states and coverage pass into the run unchanged, an already-stored
// run key is a no-op, and streams are derived from store.json's run index.
import {
  type Run,
  type SourceEnvelope,
  type Store,
  canonicalJson,
  formatRunKey,
  validateDocument,
} from "@pixelwatch/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blobPath } from "../src/blob-pool.ts";
import { type Comparison, compareImages } from "../src/comparator/compare.ts";
import { COMPARATOR_V1 } from "../src/comparator/policy.ts";
import { ingestArtifacts } from "../src/ingest/ingest.ts";
import type { ArtifactInput, Ingestion } from "../src/ingest/types.ts";
import { decodePng } from "../src/png/decode.ts";
import { baselineFor, buildRun, unitKeyString } from "../src/run/build.ts";
import { addRun, deriveStreams, newStore, streamFor } from "../src/run/store.ts";
import { type PartSpec, type UnitSpec, artifact, config, memoryPool, tinyPng } from "./ingest-fixtures.ts";

const sha = (digit: string) => digit.repeat(40);
const SHA = {
  workflow: sha("1"),
  head: sha("2"),
  baseBranch: sha("3"),
  base: sha("4"),
  config: sha("5"),
  release: sha("6"),
  claimedHead: sha("a"),
  claimedBase: sha("b"),
  claimedHarness: sha("c"),
} as const;

const VERSIONS: Run["versions"] = { release: "0.1.0", config: 1, comparator: 1, bundle: 1, data: 1 };
const REPOSITORY = "42";

function envelope(overrides: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    repositoryId: REPOSITORY,
    workflowId: "101",
    runId: "500",
    attempt: "7",
    event: "pull_request",
    createdAt: "2026-10-01T12:00:00Z",
    workflowRef: "refs/heads/main",
    workflowSha: SHA.workflow,
    association: { status: "corroborated", prNumber: "12" },
    commits: { head: SHA.head, base: SHA.base, baseBranch: SHA.baseBranch },
    configSha: SHA.config,
    releaseSha: SHA.release,
    ...overrides,
  };
}

const part = (revision: PartSpec["revision"], providerId: string, shard: [number, number], units: UnitSpec[]): PartSpec => ({
  attempt: "7",
  revision,
  providerId,
  shard,
  units,
});

/** Ingests with the baseline the envelope implies, then compares every two-captured unit's canonical blobs. */
async function ingestAndCompare(
  env: SourceEnvelope,
  providers: readonly (readonly [string, number])[],
  artifacts: readonly ArtifactInput[],
): Promise<{ ingestion: Ingestion; comparisons: Map<string, Comparison> }> {
  const pool = memoryPool();
  const ingestion = await ingestArtifacts({ config: config(providers), attempt: env.attempt, baseline: baselineFor(env), artifacts, pool });
  const read = (hash: string) => decodePng(pool.blobs.get(blobPath(hash)) ?? new Uint8Array());
  const comparisons = new Map<string, Comparison>();
  for (const unit of ingestion.units) {
    if (unit.base.state !== "captured" || unit.head.state !== "captured") continue;
    comparisons.set(unitKeyString(unit), compareImages(await read(unit.base.pixelHash), await read(unit.head.pixelHash), COMPARATOR_V1));
  }
  return { ingestion, comparisons };
}

function valid(run: Run): Run {
  const checked = validateDocument("run", run);
  if (!checked.ok) throw new Error(checked.issue.message);
  return run;
}

function validStore(store: Store): Store {
  const checked = validateDocument("store", store);
  if (!checked.ok) throw new Error(checked.issue.message);
  return store;
}

/** A minimal valid run for store tests: its one expected part never arrived, so coverage is unknown. */
function emptyRun(overrides: Partial<SourceEnvelope> = {}): Run {
  const env = envelope({ commits: { head: SHA.head }, event: "push", association: { status: "none" }, ...overrides });
  const shard = { index: 1, count: 1 };
  const ingestion: Ingestion = {
    attempt: env.attempt,
    units: [],
    coverage: { status: "unknown", declaredUnits: 0, accountedUnits: 0, missingParts: [{ revision: "head", providerId: "p", shard, reason: "not-received" }] },
    parts: [{ revision: "head", providerId: "p", shard, status: "not-received", artifacts: [] }],
    ignored: [],
    ignoredOverflow: 0,
    excluded: { count: 0, sample: [] },
  };
  return buildRun(env, ingestion, new Map(), VERSIONS);
}

describe("runs from the envelope and an ingestion (M1.5)", () => {
  it("builds byte-identical canonical runs from permuted parts and entries", async () => {
    const env = envelope();
    const providers = [
      ["p", 2],
      ["q", 1],
    ] as const;
    const specs: [PartSpec, string][] = [
      [part("base", "p", [1, 2], [{ viewId: "home", state: "captured", png: tinyPng(1) }, { viewId: "gone", state: "captured", png: tinyPng(2) }]), "9001"],
      [part("base", "p", [2, 2], [{ viewId: "list", state: "captured", png: tinyPng(3, 3, 2) }, { viewId: "new", state: "absent" }]), "9002"],
      [part("base", "q", [1, 1], [{ viewId: "home", state: "failed" }]), "9003"],
      [part("head", "p", [1, 2], [{ viewId: "home", state: "captured", png: tinyPng(1) }, { viewId: "gone", state: "absent" }]), "9004"],
      [part("head", "p", [2, 2], [{ viewId: "list", state: "captured", png: tinyPng(4, 3, 2) }, { viewId: "new", state: "captured", png: tinyPng(5) }]), "9005"],
      // A bad artifact is rejected and the run is explicitly incomplete.
      [part("head", "q", [1, 1], [{ viewId: "home", state: "captured", png: new Uint8Array([1, 2, 3]) }]), "9006"],
    ];
    const build = async (order: readonly number[], rotations: readonly number[], reverseComparisons: boolean) => {
      const artifacts = order.map((i) => {
        const [spec, id] = specs[i] as [PartSpec, string];
        const turn = rotations[i] ?? 0;
        return artifact(spec, { id, order: (entries) => entries.map((_, j) => entries[(j + turn) % entries.length] as (typeof entries)[number]) });
      });
      const { ingestion, comparisons } = await ingestAndCompare(env, providers, artifacts);
      const entries = [...comparisons];
      if (reverseComparisons) entries.reverse();
      return canonicalJson(valid(buildRun(env, ingestion, new Map(entries), VERSIONS)));
    };
    const indices = specs.map((_, i) => i);
    const reference = await build(indices, [], false);
    const run = JSON.parse(reference) as Run;
    expect(run.results.map((r) => [r.providerId, r.viewId, r.status])).toEqual([
      ["p", "gone", "removed"],
      ["p", "home", "unchanged"],
      ["p", "list", "changed"],
      ["p", "new", "added"],
      ["q", "home", "missing"],
    ]);
    expect(run.coverage.status).toBe("incomplete");
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(indices, { minLength: indices.length }),
        fc.array(fc.nat(4), { minLength: indices.length, maxLength: indices.length }),
        fc.boolean(),
        async (order, rotations, reverse) => {
          expect(await build(order, rotations, reverse)).toBe(reference);
        },
      ),
      { numRuns: 15 },
    );
  });

  it("takes the run key, stream, commits and PR number only from the envelope, even when claims disagree", async () => {
    const env = envelope();
    const forged = (revisionSha: string) => (bundle: unknown) => ({
      ...(bundle as object),
      claims: { revisionSha, harnessSha: SHA.claimedHarness, environment: { viewport: { width: 390, height: 844 } } },
    });
    const artifacts = [
      artifact(part("base", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }]), { id: "31", edit: forged(SHA.claimedBase) }),
      artifact(part("head", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(2) }]), { id: "32", edit: forged(SHA.claimedHead) }),
    ];
    const { ingestion, comparisons } = await ingestAndCompare(env, [["p", 1]], artifacts);
    const run = valid(buildRun(env, ingestion, comparisons, VERSIONS));

    expect(run.runKey).toBe(formatRunKey("500", "7"));
    expect(run.source).toEqual(env);
    expect(run.source.association).toEqual({ status: "corroborated", prNumber: "12" });
    // The claims survive only as untrusted data, side by side with the envelope.
    expect(run.claims).toEqual({
      base: { revisionSha: SHA.claimedBase, harnessSha: SHA.claimedHarness, environment: { viewport: { width: 390, height: 844 } } },
      head: { revisionSha: SHA.claimedHead, harnessSha: SHA.claimedHarness, environment: { viewport: { width: 390, height: 844 } } },
    });
    expect(run.parts.map((p) => p.artifactId)).toEqual(["31", "32"]);

    // The stream (and so the store index and the PR the comment goes to) is the envelope's.
    expect(streamFor(run.source)).toBe("pr-12");
    const { store } = addRun(newStore(REPOSITORY), run);
    expect(store.runs).toEqual([{ runKey: "500-a7", sourceCreatedAt: env.createdAt, stream: "pr-12" }]);

    // Parts that disagree keep only the claims they share; nothing is picked.
    const mixed = [
      artifact(part("head", "p", [1, 2], [{ viewId: "a", state: "failed" }]), { id: "41", edit: forged(SHA.claimedHead) }),
      artifact(part("head", "p", [2, 2], [{ viewId: "b", state: "failed" }]), { id: "42", edit: (b) => ({ ...(forged(SHA.claimedHead)(b) as object), claims: { revisionSha: SHA.claimedHead } }) }),
    ];
    const noBase = envelope({ commits: { head: SHA.head }, event: "push", association: { status: "none" } });
    const split = await ingestAndCompare(noBase, [["p", 2]], mixed);
    expect(valid(buildRun(noBase, split.ingestion, split.comparisons, VERSIONS)).claims).toEqual({ head: { revisionSha: SHA.claimedHead } });

    // An ingestion of another attempt can't be filed under this envelope.
    expect(() => buildRun(envelope({ attempt: "8" }), ingestion, comparisons, VERSIONS)).toThrow(/attempt/);
  });

  it("keeps workflow, head, base-branch and baseline SHAs in their own fields", async () => {
    const env = envelope();
    const artifacts = [
      artifact(part("base", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }]), { edit: (b) => ({ ...(b as object), claims: { revisionSha: SHA.claimedBase } }) }),
      artifact(part("head", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }]), { edit: (b) => ({ ...(b as object), claims: { revisionSha: SHA.claimedHead } }) }),
    ];
    const { ingestion, comparisons } = await ingestAndCompare(env, [["p", 1]], artifacts);
    const run = valid(buildRun(env, ingestion, comparisons, VERSIONS));
    expect(run.source.workflowSha).toBe(SHA.workflow);
    expect(run.source.commits).toEqual({ head: SHA.head, base: SHA.base, baseBranch: SHA.baseBranch });
    expect(run.claims.head?.revisionSha).toBe(SHA.claimedHead);
    expect(run.claims.base?.revisionSha).toBe(SHA.claimedBase);

    // A missing field stays missing: nothing is filled in from another SHA or from a claim.
    for (const commits of [{ head: SHA.head, base: SHA.base }, { head: SHA.head }, {}] as const) {
      const partial = envelope({ commits, event: "push", association: { status: "none" } });
      const again = await ingestAndCompare(partial, [["p", 1]], artifacts);
      const built = valid(buildRun(partial, again.ingestion, again.comparisons, VERSIONS));
      expect(built.source.commits).toEqual(commits);
      expect(built.source.workflowSha).toBe(SHA.workflow);
    }
    // The envelope's commits are copied, not aliased: a later change to the input can't move them.
    const mutable = envelope();
    const copied = buildRun(mutable, ingestion, comparisons, VERSIONS);
    (mutable.commits as { head?: string }).head = SHA.claimedHead;
    expect(copied.source.commits.head).toBe(SHA.head);
  });

  it("treats an already-stored run key as a no-op and never replaces the stored run", async () => {
    const env = envelope();
    const build = async (headPng: Uint8Array, createdAt: string) => {
      const e = envelope({ createdAt });
      const { ingestion, comparisons } = await ingestAndCompare(e, [["p", 1]], [
        artifact(part("base", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }])),
        artifact(part("head", "p", [1, 1], [{ viewId: "home", state: "captured", png: headPng }])),
      ]);
      return valid(buildRun(e, ingestion, comparisons, VERSIONS));
    };
    const first = await build(tinyPng(1), env.createdAt);
    const retry = await build(tinyPng(9), "2026-10-01T13:00:00Z");
    expect(retry.runKey).toBe(first.runKey);
    expect(retry.results[0]?.status).not.toBe(first.results[0]?.status);

    const once = addRun(validStore(newStore(REPOSITORY)), first);
    expect(once.added).toBe(true);
    expect(once.store.txn).toBe(1);
    const before = canonicalJson(once.store);
    const twice = addRun(once.store, retry);
    expect(twice.added).toBe(false);
    expect(twice.store).toBe(once.store);
    expect(canonicalJson(twice.store)).toBe(before);
    expect(twice.store.runs).toEqual([{ runKey: first.runKey, sourceCreatedAt: env.createdAt, stream: "pr-12" }]);

    // A run of another repository is never filed in this store.
    expect(() => addRun(once.store, emptyRun({ repositoryId: "43", runId: "501" }))).toThrow(/repository/);
  });

  it("orders history by created time, then numeric run ID, then numeric attempt", () => {
    const at = (time: string) => `2026-10-01T${time}Z`;
    const runs = [
      emptyRun({ runId: "100", attempt: "1", createdAt: at("09:00:00") }),
      emptyRun({ runId: "9", attempt: "1", createdAt: at("10:00:00") }),
      emptyRun({ runId: "10", attempt: "1", createdAt: at("10:00:00") }),
      emptyRun({ runId: "10", attempt: "2", createdAt: at("10:00:00") }),
      emptyRun({ runId: "10", attempt: "10", createdAt: at("10:00:00") }),
      emptyRun({ runId: "11", attempt: "1", createdAt: at("10:00:00") }),
      emptyRun({ runId: "2", attempt: "1", createdAt: at("11:00:00") }),
    ];
    const expected = ["100-a1", "9-a1", "10-a1", "10-a2", "10-a10", "11-a1", "2-a1"];
    fc.assert(
      fc.property(fc.shuffledSubarray(runs, { minLength: runs.length }), (order) => {
        let store = newStore(REPOSITORY);
        for (const run of order) store = addRun(store, run).store;
        expect(validStore(store).runs.map((r) => r.runKey)).toEqual(expected);
        expect(store.txn).toBe(runs.length);
      }),
    );
  });

  it("derives streams from the store index, with a latest pointer", () => {
    const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`;
    const pr = (n: string) => ({ event: "pull_request" as const, association: { status: "corroborated" as const, prNumber: n } });
    const runs = [
      emptyRun({ runId: "1", createdAt: at(1) }),
      emptyRun({ runId: "2", createdAt: at(2), ...pr("12") }),
      emptyRun({ runId: "3", createdAt: at(3), ...pr("3") }),
      emptyRun({ runId: "4", createdAt: at(4), event: "pull_request", association: { status: "ambiguous", diagnostic: "2 open PRs have this head" } }),
      emptyRun({ runId: "5", createdAt: at(5), event: "pull_request", association: { status: "none" } }),
      emptyRun({ runId: "6", createdAt: at(6), event: "workflow_dispatch" }),
      emptyRun({ runId: "7", createdAt: at(7), ...pr("12") }),
      emptyRun({ runId: "8", createdAt: at(0) }),
    ];
    let store = newStore(REPOSITORY);
    for (const run of runs) store = addRun(store, run).store;
    // Unassociated, ambiguous and dispatched runs are in history but in no stream.
    expect(validStore(store).runs.map((r) => [r.runKey, r.stream ?? null])).toEqual([
      ["8-a7", "main"],
      ["1-a7", "main"],
      ["2-a7", "pr-12"],
      ["3-a7", "pr-3"],
      ["4-a7", null],
      ["5-a7", null],
      ["6-a7", null],
      ["7-a7", "pr-12"],
    ]);
    const streams = deriveStreams(store);
    for (const stream of streams) expect(validateDocument("stream", stream).ok).toBe(true);
    expect(streams).toEqual([
      { schemaVersion: 1, streamId: "main", runs: ["8-a7", "1-a7"], latest: "1-a7" },
      { schemaVersion: 1, streamId: "pr-3", runs: ["3-a7"], latest: "3-a7" },
      { schemaVersion: 1, streamId: "pr-12", runs: ["2-a7", "7-a7"], latest: "7-a7" },
    ]);
    expect(deriveStreams(newStore(REPOSITORY))).toEqual([]);
  });

  it("keeps the same view name under two providers as two results", async () => {
    const env = envelope();
    const { ingestion, comparisons } = await ingestAndCompare(
      env,
      [
        ["fixture", 1],
        ["stack", 1],
      ],
      [
        artifact(part("base", "fixture", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }])),
        artifact(part("head", "fixture", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }])),
        artifact(part("base", "stack", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }])),
        artifact(part("head", "stack", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(2) }])),
      ],
    );
    expect(comparisons.size).toBe(2);
    const run = valid(buildRun(env, ingestion, comparisons, VERSIONS));
    expect(run.results.map((r) => [r.providerId, r.viewId, r.variantId, r.status])).toEqual([
      ["fixture", "home", "desktop", "unchanged"],
      ["stack", "home", "desktop", "changed"],
    ]);
    expect(run.counts).toMatchObject({ unchanged: 1, changed: 1 });

    // Each comparison belongs to exactly one unit: none may be missing, and none may be extra.
    const one = new Map([...comparisons].slice(0, 1));
    expect(() => buildRun(env, ingestion, one, VERSIONS)).toThrow(/comparison/);
    const extra = new Map([...comparisons, [unitKeyString({ providerId: "other", viewId: "home", variantId: "desktop" }), [...comparisons.values()][0] as Comparison]]);
    expect(() => buildRun(env, ingestion, extra, VERSIONS)).toThrow(/comparison/);
  });

  it("carries missing, failed and incomparable states and coverage into the run unchanged", async () => {
    const env = envelope();
    const { ingestion, comparisons } = await ingestAndCompare(
      env,
      [
        ["p", 2],
        ["q", 1],
      ],
      [
        artifact(part("base", "p", [1, 2], [{ viewId: "a", state: "captured", png: tinyPng(1) }, { viewId: "b", state: "captured", png: tinyPng(2) }])),
        artifact(part("base", "p", [2, 2], [{ viewId: "c", state: "failed" }])),
        artifact(part("base", "q", [1, 1], [{ viewId: "d", state: "captured", png: tinyPng(3) }])),
        artifact(part("head", "p", [1, 2], [{ viewId: "a", state: "captured", png: tinyPng(1) }, { viewId: "c", state: "captured", png: tinyPng(4) }])),
        // head p/2 never arrives, so b is part-missing; head q/1 is rejected.
        artifact(part("head", "q", [1, 1], [{ viewId: "d", state: "captured" }]), { id: "77", drop: ["d.desktop.png"] }),
      ],
    );
    const run = valid(buildRun(env, ingestion, comparisons, VERSIONS));
    expect(run.coverage).toEqual(ingestion.coverage);
    expect(run.coverage.status).toBe("incomplete");
    expect(run.coverage.missingParts.map((p) => [p.revision, p.providerId, p.shard.index, p.reason])).toEqual([
      ["head", "p", 2, "not-received"],
      ["head", "q", 1, "rejected"],
    ]);
    for (const [i, unit] of ingestion.units.entries()) {
      expect(run.results[i]).toMatchObject({ providerId: unit.providerId, viewId: unit.viewId, variantId: unit.variantId, base: unit.base, head: unit.head });
    }
    expect(run.results.map((r) => [r.viewId, r.status, r.reasons])).toEqual([
      ["a", "unchanged", []],
      ["b", "missing", ["part-missing"]],
      ["c", "failed", ["capture-failed"]],
      ["d", "missing", ["part-missing"]],
    ]);
    // Only received parts are listed; a rejected one keeps its diagnostic.
    expect(run.parts.map((p) => [p.revision, p.providerId, p.shard.index, p.status])).toEqual([
      ["base", "p", 1, "valid"],
      ["base", "p", 2, "valid"],
      ["base", "q", 1, "valid"],
      ["head", "p", 1, "valid"],
      ["head", "q", 1, "rejected"],
    ]);
    expect(run.parts.at(-1)).toMatchObject({ artifactId: "77", diagnostic: expect.stringMatching(/^part-file-missing: /) as string });
    expect(Object.values(run.counts).reduce<number>((a, b: number) => a + b, 0)).toBe(run.results.length);

    // No usable artifact at all: a bounded record with unknown coverage, never a pass.
    const none = await ingestAndCompare(env, [["p", 1]], []);
    const empty = valid(buildRun(env, none.ingestion, none.comparisons, VERSIONS));
    expect(empty.coverage).toEqual({ status: "unknown", declaredUnits: 0, accountedUnits: 0, missingParts: none.ingestion.coverage.missingParts });
    expect(empty.counts.unchanged).toBe(0);
    expect(empty.results).toEqual([]);
  });

  it("never substitutes latest main for a missing baseline commit: results are incomparable", async () => {
    const units: UnitSpec[] = [
      { viewId: "home", state: "captured", png: tinyPng(1) },
      { viewId: "list", state: "failed" },
    ];
    const artifacts = [
      // A base artifact uploaded anyway is never opened: without a baseline commit no base part is expected.
      artifact(part("base", "p", [1, 1], [{ viewId: "home", state: "captured", png: tinyPng(1) }])),
      artifact(part("head", "p", [1, 1], units)),
    ];
    const withBase = envelope({ event: "push", association: { status: "none" }, commits: { head: SHA.head, base: SHA.base } });
    const noBase = envelope({ event: "push", association: { status: "none" }, commits: { head: SHA.head } });
    expect(baselineFor(withBase)).toBe("expected");
    expect(baselineFor(noBase)).toBe("none");

    // A store whose latest main run captured the same unit changes nothing: buildRun never reads it.
    let store = newStore(REPOSITORY);
    const main = await ingestAndCompare(withBase, [["p", 1]], artifacts);
    store = addRun(store, valid(buildRun(withBase, main.ingestion, main.comparisons, VERSIONS))).store;
    expect(deriveStreams(store)[0]?.latest).toBe("500-a7");

    const { ingestion, comparisons } = await ingestAndCompare(noBase, [["p", 1]], artifacts);
    expect(ingestion.ignored.map((a) => a.reason)).toEqual(["base-not-expected"]);
    expect(comparisons.size).toBe(0);
    const run = valid(buildRun(noBase, ingestion, comparisons, VERSIONS));
    expect(run.source.commits.base).toBeUndefined();
    expect(run.parts.every((p) => p.revision === "head")).toBe(true);
    expect(run.results.map((r) => [r.viewId, r.status, r.reasons, r.base])).toEqual([
      ["home", "incomparable", ["no-baseline"], { state: "none" }],
      ["list", "failed", ["capture-failed", "no-baseline"], { state: "none" }],
    ]);
    expect(run.results.some((r) => r.diff !== undefined)).toBe(false);

    // A comparison offered against some other image is refused, not used.
    const stolen = new Map([[unitKeyString(run.results[0] as Run["results"][number]), [...main.comparisons.values()][0] as Comparison]]);
    expect(() => buildRun(noBase, ingestion, stolen, VERSIONS)).toThrow(/comparison/);
    // The ingestion's baseline must be the envelope's, both ways.
    expect(() => buildRun(noBase, main.ingestion, main.comparisons, VERSIONS)).toThrow(/baseline/);
    expect(() => buildRun(withBase, ingestion, comparisons, VERSIONS)).toThrow(/baseline/);
  });
});

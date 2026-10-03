// Generates the M1.7 projection goldens (testdata/projection/site/) from the RECORDED comparator
// outputs in testdata/comparator/ (never from .reference/). Nothing here compares pixels:
//
// - tiny: comparator-v1's expected results for the 48 tiny cases (tools/prototype-goldens/
//   expected.ts), split into a pull-request run with a baseline and a push run without one, since
//   one run can't mix the two;
// - propertyscope-pr123 and tracepilot-36287837535: the recorded per-view pixel hashes, dimensions
//   and prototype comparisons, mapped to comparator-v1 results by the same `comparedResult`.
//
// Run IDs, attempts, events, commits and artifact IDs of the real runs are the recorded ones. The
// rest of each envelope (repository and workflow IDs, created times, workflow/config/release
// SHAs, the PR number of the tiny run) is synthetic and fixed. The four runs share one synthetic
// store and site, so the tree exercises main and PR streams together.
//
// The goldens pin the exact served bytes: changes.json must never change under its URL. Only
// regenerate when the recordings change or an ADR changes the projection (ADR 0013):
//
//   node tools/projection-goldens/generate.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECTION_VERSION, generationId } from "../../packages/core/src/projection/documents.ts";
import { type ProjectionInput, projectSite } from "../../packages/core/src/projection/project.ts";
import { addRun, newStore } from "../../packages/core/src/run/store.ts";
import type { CapturedSide, Config, Run, RunResult, SourceEnvelope } from "../../packages/schemas/src/generated/types.ts";
import { compareUnitKeys } from "../../packages/schemas/src/ids.ts";
import { validateDocument } from "../../packages/schemas/src/validate.ts";
import { COMPARATOR_TESTDATA, type RecordedSide, comparedResult, loadAndBuild } from "../prototype-goldens/expected.ts";
import type { PrototypeRecord } from "../prototype-goldens/mapping.ts";

export const PROJECTION_TESTDATA = fileURLToPath(new URL("../../testdata/projection/", import.meta.url));

const REPOSITORY = "987654321";
const WORKFLOW = "123456";
const oid = (digit: string) => digit.repeat(40);
const VERSIONS: Run["versions"] = { release: "0.1.0", config: 1, comparator: 1, bundle: 1, data: 1 };

interface RecordedRun {
  source: { run: string; attempt: string; baseSha: string; headSha: string; artifacts: { name: string; id: string }[] };
  views: {
    id: string;
    provider?: string;
    section?: string;
    inputs: { base: RecordedSide; head: RecordedSide };
    prototype: PrototypeRecord;
  }[];
}

function recording(name: string): RecordedRun {
  return JSON.parse(readFileSync(join(COMPARATOR_TESTDATA, name, "prototype.json"), "utf8")) as RecordedRun;
}

function envelope(fields: Pick<SourceEnvelope, "runId" | "attempt" | "event" | "createdAt" | "association" | "commits">): SourceEnvelope {
  return {
    repositoryId: REPOSITORY,
    workflowId: WORKFLOW,
    workflowRef: "refs/heads/main",
    workflowSha: oid("4"),
    configSha: oid("5"),
    releaseSha: oid("6"),
    ...fields,
  };
}

function captured(side: RecordedSide): CapturedSide {
  return { state: "captured", pixelHash: side.pixelHash, width: side.width, height: side.height };
}

/** Parts named like the prototypes' artifacts: `visual-<revision>-<provider>` or `visual-<revision>-<shard>`. */
function parts(artifacts: RecordedRun["source"]["artifacts"], shards: number): Run["parts"] {
  return artifacts
    .map((a) => {
      const match = /^visual-(base|head)-(.+)$/.exec(a.name);
      if (!match) throw new Error(`unexpected artifact name ${a.name}`);
      const [, revision = "", rest = ""] = match;
      const sharded = /^[1-9]$/.test(rest);
      return {
        revision: revision === "base" ? ("base" as const) : ("head" as const),
        providerId: sharded ? "fixture" : rest,
        shard: sharded ? { index: Number(rest), count: shards } : { index: 1, count: 1 },
        status: "valid" as const,
        artifactId: a.id,
      };
    })
    .sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : a.shard.index - b.shard.index));
}

function finish(source: SourceEnvelope, unsorted: RunResult[], runParts: Run["parts"]): Run {
  const results = [...unsorted].sort(compareUnitKeys);
  const counts: Run["counts"] = { missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: 0, subtle: 0, changed: 0 };
  for (const r of results) counts[r.status] += 1;
  const accounted = results.length - counts.missing;
  const run: Run = {
    schemaVersion: 1,
    runKey: `${source.runId}-a${source.attempt}`,
    source,
    claims: {},
    versions: VERSIONS,
    parts: runParts,
    coverage: {
      status: accounted === results.length ? "complete-declared" : "incomplete",
      declaredUnits: results.length,
      accountedUnits: accounted,
      missingParts: [],
    },
    counts,
    results,
  };
  const checked = validateDocument("run", run);
  if (!checked.ok) throw new Error(`golden run ${run.runKey} is invalid: ${checked.issue.message}`);
  return run;
}

function tinyRuns(): { tiny: Run; noBaseline: Run } {
  const results = loadAndBuild().tiny.results;
  const part = (revision: "base" | "head", artifactId: string) => ({ revision, providerId: "tiny", shard: { index: 1, count: 1 }, status: "valid" as const, artifactId });
  const tiny = finish(
    envelope({
      runId: "11",
      attempt: "1",
      event: "pull_request",
      createdAt: "2026-09-20T10:00:00Z",
      association: { status: "corroborated", prNumber: "7" },
      commits: { head: oid("1"), base: oid("2"), baseBranch: oid("3") },
    }),
    results.filter((r) => r.base.state !== "none"),
    [part("base", "1101"), part("head", "1102")],
  );
  const noBaseline = finish(
    envelope({ runId: "10", attempt: "1", event: "push", createdAt: "2026-09-20T09:00:00Z", association: { status: "none" }, commits: { head: oid("7") } }),
    results.filter((r) => r.base.state === "none"),
    [part("head", "1001")],
  );
  return { tiny, noBaseline };
}

function realRun(name: string, fields: Pick<SourceEnvelope, "event" | "createdAt" | "association">, shards: number): Run {
  const rec = recording(name);
  const results = rec.views.map((v): RunResult => {
    const { base, head } = v.inputs;
    return {
      providerId: v.provider ?? "fixture",
      viewId: v.id,
      variantId: "desktop",
      ...comparedResult(v.id, base, head, v.prototype, undefined, undefined),
      ...(v.section === undefined ? {} : { labels: { group: v.section } }),
      base: captured(base),
      head: captured(head),
    };
  });
  const source = envelope({ runId: rec.source.run, attempt: rec.source.attempt, commits: { head: rec.source.headSha, base: rec.source.baseSha }, ...fields });
  return finish(source, results, parts(rec.source.artifacts, shards));
}

function buildGoldenRuns() {
  const { tiny, noBaseline } = tinyRuns();
  return {
    tiny,
    "tiny-no-baseline": noBaseline,
    "propertyscope-pr123": realRun(
      "propertyscope-pr123",
      { event: "pull_request", createdAt: "2026-09-28T09:48:30Z", association: { status: "corroborated", prNumber: "123" } },
      1,
    ),
    "tracepilot-36287837535": realRun("tracepilot-36287837535", { event: "push", createdAt: "2026-09-26T08:00:00Z", association: { status: "none" } }, 2),
  } as const;
}

/** The golden runs, by name. Treat as read-only; tests clone before changing them. */
export const GOLDEN_RUNS: Readonly<Record<keyof ReturnType<typeof buildGoldenRuns>, Run>> = buildGoldenRuns();

export const GOLDEN_CONFIG: Config = {
  schemaVersion: 1,
  source: { workflowIds: [WORKFLOW], events: ["pull_request", "push"] },
  providers: [
    { id: "fixture", shards: 2 },
    { id: "stack", shards: 1 },
    { id: "tiny", shards: 1 },
  ],
  store: { prefix: "pixelwatch" },
  theme: { preset: "github-dark" },
};

/** The golden site: every golden run in one store. `runs` replaces golden runs with the same key. */
export function goldenInput(options: { runs?: readonly Run[] } = {}): ProjectionInput {
  const runs = new Map(Object.values(GOLDEN_RUNS).map((r) => [r.runKey, r]));
  for (const run of options.runs ?? []) {
    if (!runs.has(run.runKey)) throw new Error(`${run.runKey} isn't a golden run`);
    runs.set(run.runKey, run);
  }
  let store = newStore(REPOSITORY);
  for (const run of runs.values()) store = addRun(store, run).store;
  return {
    config: GOLDEN_CONFIG,
    pages: { url: "https://owner.github.io/repo/", host: "owner.github.io" },
    store,
    runs,
    generation: generationId({ storeTip: oid("8"), releaseCommit: oid("6"), configCommit: oid("5"), projectionVersion: PROJECTION_VERSION }),
    release: "0.1.0",
  };
}

/** The committed tree: everything projectSite emits except the served JSON Schemas, which are schemaFor's output. */
export function goldenTree(): Map<string, Uint8Array> {
  return new Map(projectSite(goldenInput()).filter((f) => !f.path.startsWith("api/v1/schemas/")).map((f) => [f.path, f.bytes]));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(PROJECTION_TESTDATA, "site");
  rmSync(root, { recursive: true, force: true });
  const tree = goldenTree();
  for (const [path, bytes] of tree) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  console.log(`wrote ${String(tree.size)} files under ${root}`);
}

// Invariants JSON Schema can't express: uniqueness, ordering, counts, the 02 §4 result
// precedence, and coverage arithmetic. Each check returns the first
// problem found, or undefined.
import type {
  Analysis,
  ApiIndex,
  Bundle,
  ChangeResult,
  Changes,
  Config,
  Counts,
  Coverage,
  Diff,
  ReceivedPart,
  Run,
  RunResult,
  Site,
  Store,
  Stream,
} from "./generated/types.ts";
import { compareRunOrder, compareStreamIds, compareUnitKeys, formatRunKey } from "./ids.ts";
import { MAX_MESSAGE_BYTES, utf8Length } from "./text.ts";

export interface SemanticIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Check<T> = (doc: T) => SemanticIssue | undefined;

function issue(code: string, path: string, message: string): SemanticIssue {
  return { code, path, message };
}

/** Checks that apply to every document: string byte bounds and shard ranges. */
export function checkGeneric(value: unknown, path = ""): SemanticIssue | undefined {
  if (typeof value === "string") {
    return utf8Length(value) > MAX_MESSAGE_BYTES
      ? issue("text-too-long", path, `string exceeds ${String(MAX_MESSAGE_BYTES)} UTF-8 bytes`)
      : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = checkGeneric(value[i], `${path}/${String(i)}`);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (key === "shard" && typeof child === "object" && child !== null) {
      const { index, count } = child as { index: number; count: number };
      if (index > count) return issue("shard-out-of-range", childPath, `shard index ${String(index)} exceeds count ${String(count)}`);
    }
    const found = checkGeneric(child, childPath);
    if (found) return found;
  }
  return undefined;
}

function firstDuplicate<T>(items: readonly T[], key: (item: T) => string): number {
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const k = key(items[i] as T);
    if (seen.has(k)) return i;
    seen.add(k);
  }
  return -1;
}

/** round-half-up(1e6 × changed / total), in exact integer arithmetic. */
export function changedPpm(changedPixels: number, totalPixels: number): number {
  if (totalPixels <= 0) throw new Error("totalPixels must be positive");
  const c = BigInt(changedPixels);
  const t = BigInt(totalPixels);
  return Number((c * 2_000_000n + t) / (2n * t));
}

const checkBundle: Check<Bundle> = (bundle) => {
  const dup = firstDuplicate(bundle.units, (u) => `${u.viewId}\u0000${u.variantId}`);
  if (dup >= 0) return issue("duplicate-unit", `/units/${String(dup)}`, "unit (viewId, variantId) appears twice");
  return undefined;
};

/** Σ shards over providers; base + head parts then fit run@1's 256 `parts`. */
export const MAX_CONFIG_SHARDS = 128;

const checkConfig: Check<Config> = (config) => {
  const dup = firstDuplicate(config.providers, (p) => p.id);
  if (dup >= 0) return issue("duplicate-provider", `/providers/${String(dup)}/id`, "provider ID appears twice");
  // run@1 records at most 256 parts: base and head of every provider shard (02 §1).
  const shards = config.providers.reduce((sum, p) => sum + p.shards, 0);
  if (shards > MAX_CONFIG_SHARDS) return issue("too-many-parts", "/providers", `shards across providers must total at most ${String(MAX_CONFIG_SHARDS)}`);
  const soft = config.limits?.softBytes ?? 419_430_400;
  const hard = config.limits?.hardBytes ?? 524_288_000;
  if (soft > hard) return issue("limit-order", "/limits", "softBytes must not exceed hardBytes");
  return undefined;
};

const checkStore: Check<Store> = (store) => {
  const dup = firstDuplicate(store.runs, (r) => r.runKey);
  if (dup >= 0) return issue("duplicate-run", `/runs/${String(dup)}`, "run key appears twice");
  for (let i = 1; i < store.runs.length; i++) {
    if (compareRunOrder(store.runs[i - 1] as Store["runs"][number], store.runs[i] as Store["runs"][number]) >= 0) {
      return issue("run-order", `/runs/${String(i)}`, "runs must be in history order");
    }
  }
  return undefined;
};

function checkDiff(diff: Diff, path: string, requireRegions?: boolean): SemanticIssue | undefined {
  let previous = -1;
  for (const [i, analysis] of diff.analyses.entries()) {
    const at = `${path}/analyses/${String(i)}`;
    if (analysis.threshold <= previous) return issue("diff-inconsistent", at, "thresholds must strictly increase");
    previous = analysis.threshold;
    const found = checkAnalysis(analysis, diff.totalPixels, at, requireRegions);
    if (found) return found;
  }
  return undefined;
}

function checkAnalysis(a: Analysis, totalPixels: number, at: string, requireRegions?: boolean): SemanticIssue | undefined {
  if (a.changedPixels > totalPixels) return issue("diff-inconsistent", at, "changedPixels exceeds totalPixels");
  if (a.changedPpm !== changedPpm(a.changedPixels, totalPixels)) {
    return issue("ppm-mismatch", `${at}/changedPpm`, `changedPpm must be ${String(changedPpm(a.changedPixels, totalPixels))}`);
  }
  if ((a.bounds !== undefined) !== a.changedPixels > 0) {
    return issue("diff-inconsistent", at, "bounds are present exactly when pixels changed");
  }
  const hasRegions = a.regions !== undefined;
  if (hasRegions !== (a.regionCount !== undefined)) {
    return issue("diff-inconsistent", at, "regions and regionCount appear together");
  }
  if (requireRegions !== undefined && hasRegions !== requireRegions) {
    return issue("capability-mismatch", at, requireRegions ? "regions capability requires regions" : "regions present without the regions capability");
  }
  if (a.regions !== undefined && a.regionCount !== undefined) {
    if (a.regions.length > a.regionCount) return issue("diff-inconsistent", at, "more regions than regionCount");
    if ((a.regionCount > 0) !== a.changedPixels > 0) return issue("diff-inconsistent", at, "regionCount must be positive exactly when pixels changed");
  }
  return undefined;
}

type AnyResult = RunResult | ChangeResult;

/** The 02 §4 precedence, as a check on one stored result. */
export function checkResult(r: AnyResult, at: string): SemanticIssue | undefined {
  const bad = (message: string) => issue("result-inconsistent", at, message);
  const b = r.base;
  const h = r.head;
  if (h.state === "none") return bad("only the base side can be none");
  if (b.state === "absent" && h.state === "absent") return bad("both sides absent is not a unit");
  if (b.state === "none" && h.state === "absent") return bad("absent head with no baseline is not a unit");

  let expected: RunResult["status"] | undefined;
  if (b.state === "missing" || h.state === "missing") expected = "missing";
  else if (b.state === "failed" || h.state === "failed") expected = "failed";
  else if (b.state === "none") expected = "incomparable";
  else if (b.state === "absent") expected = "added";
  else if (h.state === "absent") expected = "removed";

  if (expected !== undefined && r.status !== expected) return bad(`sides ${b.state}/${h.state} require status ${expected}`);
  if (b.state === "none" && !r.reasons.includes("no-baseline")) return bad("no baseline requires reason no-baseline");

  if (b.state === "captured" && h.state === "captured") {
    const sameSize = b.width === h.width && b.height === h.height;
    const identical = sameSize && b.pixelHash === h.pixelHash;
    switch (r.status) {
      case "unchanged":
        if (!identical) return bad("unchanged requires identical dimensions and pixel hash");
        break;
      case "subtle":
      case "changed":
        if (identical) return bad(`${r.status} requires different pixels`);
        if (!sameSize && (r.status !== "changed" || !r.reasons.includes("dimensions"))) {
          return bad("a dimension change is changed with reason dimensions");
        }
        break;
      case "incomparable":
        if (!r.reasons.includes("environment-mismatch") && !r.reasons.includes("alignment")) {
          return bad("incomparable captures need reason environment-mismatch or alignment");
        }
        break;
      default:
        return bad(`two captured sides can't be ${r.status}`);
    }
    if (r.diff !== undefined && r.status === "unchanged" && r.diff.analyses.some((a) => a.changedPixels > 0)) {
      return bad("unchanged can't have changed pixels");
    }
  } else if (r.diff !== undefined) {
    return bad("a diff needs two captured sides");
  }
  return undefined;
}

const STATUSES = ["missing", "failed", "incomparable", "added", "removed", "unchanged", "subtle", "changed"] as const;

function checkResults(results: readonly AnyResult[], counts: Counts, coverage: Coverage, requireRegions?: boolean): SemanticIssue | undefined {
  for (let i = 0; i < results.length; i++) {
    const at = `/results/${String(i)}`;
    const r = results[i] as AnyResult;
    if (i > 0) {
      const order = compareUnitKeys(results[i - 1] as AnyResult, r);
      if (order === 0) return issue("duplicate-result", at, "unit key appears twice");
      if (order > 0) return issue("unsorted-results", at, "results must be sorted by (providerId, viewId, variantId)");
    }
    const found = checkResult(r, at) ?? (r.diff ? checkDiff(r.diff, `${at}/diff`, requireRegions) : undefined);
    if (found) return found;
  }
  for (const status of STATUSES) {
    const actual = results.filter((r) => r.status === status).length;
    if (counts[status] !== actual) {
      return issue("counts-mismatch", `/counts/${status}`, `counts.${status} is ${String(counts[status])} but ${String(actual)} results have it`);
    }
  }
  return checkCoverage(coverage, results);
}

function checkCoverage(coverage: Coverage, results: readonly AnyResult[]): SemanticIssue | undefined {
  const bad = (message: string) => issue("coverage-mismatch", "/coverage", message);
  const dup = firstDuplicate(coverage.missingParts, (p) => `${p.revision}/${p.providerId}/${String(p.shard.index)}`);
  if (dup >= 0) return issue("duplicate-part", `/coverage/missingParts/${String(dup)}`, "missing part listed twice");
  if (coverage.declaredUnits !== results.length) return bad("declaredUnits must equal the number of results");
  const accounted = results.filter((r) => r.status !== "missing").length;
  if (coverage.accountedUnits !== accounted) return bad(`accountedUnits must be ${String(accounted)}`);
  const complete = coverage.missingParts.length === 0 && accounted === coverage.declaredUnits;
  const expected = complete ? "complete-declared" : coverage.declaredUnits === 0 ? "unknown" : "incomplete";
  if (coverage.status !== expected) return bad(`coverage status must be ${expected}`);
  return undefined;
}

function checkAssociation(status: string, prNumber: string | undefined, path: string): SemanticIssue | undefined {
  if ((status === "corroborated") !== (prNumber !== undefined)) {
    return issue("association-inconsistent", path, "prNumber is present exactly when the association is corroborated");
  }
  return undefined;
}

interface Provenance {
  readonly event: string;
  /** Where the base-branch commit is, when the document has one. */
  readonly baseBranchPath: string | undefined;
  readonly hasBaseline: boolean;
  readonly parts: readonly ReceivedPart[];
  readonly coverage: Coverage;
  readonly results: readonly AnyResult[];
}

/** run@1 and changes@1 alike: the commits, the baseline and the parts agree (ADR 0011). */
function checkProvenance(p: Provenance): SemanticIssue | undefined {
  if (p.baseBranchPath !== undefined && p.event !== "pull_request") {
    return issue("base-branch-inconsistent", p.baseBranchPath, "only a pull_request run has a base-branch commit");
  }
  // The baseline comes only from the envelope (01 §4.4): with no baseline commit every base side is
  // none and no base part was expected; with one, no base side is none.
  if (!p.hasBaseline) {
    const part = p.parts.findIndex((x) => x.revision === "base");
    if (part >= 0) return issue("baseline-inconsistent", `/parts/${String(part)}`, "a run without a baseline commit has no base parts");
    const missing = p.coverage.missingParts.findIndex((x) => x.revision === "base");
    if (missing >= 0) return issue("baseline-inconsistent", `/coverage/missingParts/${String(missing)}`, "a run without a baseline commit expects no base parts");
  }
  const side = p.results.findIndex((r) => (r.base.state === "none") === p.hasBaseline);
  if (side >= 0) {
    return issue("baseline-inconsistent", `/results/${String(side)}/base`, "the base side is none exactly when the run has no baseline commit");
  }
  const partKey = (x: { revision: string; providerId: string; shard: { index: number } }) =>
    `${x.revision}/${x.providerId}/${String(x.shard.index)}`;
  const dup = firstDuplicate(p.parts, partKey);
  if (dup >= 0) return issue("duplicate-part", `/parts/${String(dup)}`, "part listed twice");
  const missing = new Map(p.coverage.missingParts.map((x) => [partKey(x), x.reason]));
  for (const [i, part] of p.parts.entries()) {
    const listed = missing.get(partKey(part));
    if (part.status === "valid" ? listed !== undefined : listed !== "rejected") {
      return issue("part-coverage-mismatch", `/parts/${String(i)}`, "rejected parts, and only those, are missing with reason rejected");
    }
  }
  return undefined;
}

const checkRun: Check<Run> = (run) => {
  if (run.runKey !== formatRunKey(run.source.runId, run.source.attempt)) {
    return issue("run-key-mismatch", "/runKey", "runKey must be <source.runId>-a<source.attempt>");
  }
  const association = checkAssociation(run.source.association.status, run.source.association.prNumber, "/source/association");
  if (association) return association;
  const { commits } = run.source;
  const provenance = checkProvenance({
    event: run.source.event,
    baseBranchPath: commits.baseBranch === undefined ? undefined : "/source/commits/baseBranch",
    hasBaseline: commits.base !== undefined,
    parts: run.parts,
    coverage: run.coverage,
    results: run.results,
  });
  return provenance ?? checkResults(run.results, run.counts, run.coverage);
};

const checkChanges: Check<Changes> = (changes) => {
  const { source, capabilities } = changes;
  if (changes.runKey !== formatRunKey(source.runId, source.attempt)) {
    return issue("run-key-mismatch", "/runKey", "runKey must be <source.runId>-a<source.attempt>");
  }
  const association = checkAssociation(source.association, source.prNumber, "/source");
  if (association) return association;
  const provenance = checkProvenance({
    event: source.event,
    baseBranchPath: source.baseBranchSha === undefined ? undefined : "/source/baseBranchSha",
    hasBaseline: source.baseSha !== undefined,
    parts: changes.parts,
    coverage: changes.coverage,
    results: changes.results,
  });
  if (provenance) return provenance;
  // A capability is true exactly when its fields are there (ADR 0013): never claimed without data,
  // and never data without the claim.
  if (capabilities.diff && !changes.results.some((r) => r.diff !== undefined)) {
    return issue("capability-mismatch", "/capabilities/diff", "the diff capability needs at least one diff");
  }
  if (capabilities.regions && !capabilities.diff) {
    return issue("capability-mismatch", "/capabilities/regions", "the regions capability needs the diff capability");
  }
  for (const [i, r] of changes.results.entries()) {
    const at = `/results/${String(i)}`;
    for (const side of ["base", "head"] as const) {
      if (r.images?.[side] !== undefined && r[side].state !== "captured") {
        return issue("image-without-capture", `${at}/images/${side}`, "an image URL needs a captured side");
      }
    }
    if (!capabilities.diff && r.diff !== undefined) {
      return issue("capability-mismatch", `${at}/diff`, "diff present without the diff capability");
    }
    if (r.images) {
      for (const url of Object.values(r.images)) {
        if (url.split("/").some((segment) => segment === "." || segment === "..")) {
          return issue("unsafe-url", `${at}/images`, "image URLs must not contain dot segments");
        }
      }
    }
  }
  return checkResults(changes.results, changes.counts, changes.coverage, capabilities.regions);
};

const checkStream: Check<Stream> = (stream) => {
  if (stream.latest !== null && !stream.runs.includes(stream.latest)) {
    return issue("latest-not-in-stream", "/latest", "latest must be one of the stream's runs");
  }
  if (stream.latest === null && stream.runs.length > 0) {
    return issue("latest-not-in-stream", "/latest", "a non-empty stream needs a latest run");
  }
  return undefined;
};

const checkSite: Check<Site> = (site) => {
  const dup = firstDuplicate(site.streams, (s) => s.streamId);
  if (dup >= 0) return issue("duplicate-stream", `/streams/${String(dup)}`, "stream listed twice");
  const bad = site.streams.findIndex((s) => (s.latest === null) !== (s.runCount === 0));
  if (bad >= 0) return issue("latest-not-in-stream", `/streams/${String(bad)}`, "latest is null exactly when the stream is empty");
  return undefined;
};

const checkApiIndex: Check<ApiIndex> = (index) => {
  const ids = index.streams.map((s) => s.streamId);
  for (let i = 1; i < ids.length; i++) {
    const order = compareStreamIds(ids[i - 1] ?? "", ids[i] ?? "");
    if (order === 0) return issue("duplicate-stream", `/streams/${String(i)}`, "stream listed twice");
    if (order > 0) return issue("unsorted-streams", `/streams/${String(i)}`, "streams are main first, then pull requests by number");
  }
  return undefined;
};

export const SEMANTIC_CHECKS = {
  bundle: checkBundle,
  config: checkConfig,
  store: checkStore,
  run: checkRun,
  stream: checkStream,
  site: checkSite,
  changes: checkChanges,
  "api-index": checkApiIndex,
  "pr-pointer": () => undefined,
} as const;

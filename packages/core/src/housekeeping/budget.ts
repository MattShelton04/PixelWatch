// Budget planning over the assembled site (03 §1; ADR 0012). The site is everything the projector
// serves: fixed files (entry page, site.json, app, API index, llms.txt), each kept run's record,
// changes.json and permalink stub, stream files and PR pointers, the blobs and derived files the
// kept runs reference, and live grace copies.
//
// - Over the soft limit: warn, with a breakdown by category.
// - Over the hard limit: prune deterministically until it fits. Live grace copies go first (04 §3
//   keeps them only "if the budget allows"), then the oldest unpinned closed-PR history, then
//   unassociated runs, then other unpinned runs, then pinned ones (pins never bypass the budget).
// - Never pruned: the latest main run, each kept open or unknown PR's latest run, and the new run.
//   If those alone don't fit, the transaction is refused; nothing is dropped to make it fit.
import type { Config } from "@pixelwatch/schemas";
import { checkBytes, checkTimestamp, refuse } from "./errors.ts";
import { changesPath, permalinkPath, prPointerPath, runRecordPath, streamPath } from "./paths.ts";
import type { RetainedRun, RetentionPlan } from "./retention.ts";
import type { StoreGraph } from "./tree.ts";

export type SiteCategory = "html" | "app" | "api" | "stubs" | "data" | "blobs" | "derived" | "grace";
export type Breakdown = Record<SiteCategory, number>;

export interface SiteFile {
  /** Relative to the site prefix (03 §3). */
  readonly path: string;
  readonly bytes: number;
  readonly category: SiteCategory;
}

/**
 * Sizes of the files the projector generates (M1.7 supplies the real ones). Each must be a byte
 * count; anything else refuses the plan rather than counting as zero.
 */
export interface ProjectedSizes {
  /**
   * Files emitted once per site: entry page, site.json, the app build, api/v1/index.json,
   * llms.txt. Where a size depends on what's kept (site.json lists streams), an upper bound.
   */
  readonly fixed: readonly SiteFile[];
  changes(runKey: string): number;
  permalink(runKey: string): number;
  /** data/v1/streams/<streamId>.json listing these run keys in history order. */
  stream(streamId: string, runKeys: readonly string[]): number;
  /** api/v1/pr/<prNumber>/latest.json naming the stream's latest run. */
  prPointer(prNumber: string, latest: string): number;
}

export interface SizeLimits {
  readonly softBytes: number;
  readonly hardBytes: number;
}

/** config@1's limits, with the schema defaults (03 §1). */
export function sizeLimits(config: Config): SizeLimits {
  return checkLimits({ softBytes: config.limits?.softBytes ?? 419_430_400, hardBytes: config.limits?.hardBytes ?? 524_288_000 });
}

export function checkLimits(limits: SizeLimits): SizeLimits {
  checkBytes(limits.softBytes, "limits.softBytes");
  checkBytes(limits.hardBytes, "limits.hardBytes");
  if (limits.softBytes < 1 || limits.softBytes > limits.hardBytes) refuse("invalid-input", "limits need 0 < softBytes ≤ hardBytes");
  return { softBytes: limits.softBytes, hardBytes: limits.hardBytes };
}

export interface BudgetInput {
  readonly graph: StoreGraph;
  readonly retention: RetentionPlan;
  readonly now: string;
  readonly projected: ProjectedSizes;
  readonly limits: SizeLimits;
  /** The run this transaction adds. It's protected if retention keeps it. */
  readonly newRun?: string | undefined;
}

export type PruneReason = "closed-pr" | "unassociated" | "unpinned" | "pinned";

export interface PrunedRun {
  readonly runKey: string;
  readonly stream?: string;
  readonly reason: PruneReason;
}

export interface GraceDrop {
  readonly namespace: string;
  readonly reason: "expired" | "budget";
}

export interface BudgetPlan {
  readonly ok: true;
  readonly totalBytes: number;
  readonly breakdown: Breakdown;
  readonly limits: SizeLimits;
  readonly overSoftLimit: boolean;
  /** The runs the site keeps, in history order. */
  readonly retained: readonly RetainedRun[];
  /** Runs pruned for the hard limit, in pruning order. */
  readonly pruned: readonly PrunedRun[];
  readonly grace: { readonly kept: readonly string[]; readonly dropped: readonly GraceDrop[] };
  /** The assembled site, by path. */
  readonly site: readonly SiteFile[];
}

export interface BudgetRefusal {
  readonly ok: false;
  readonly reason: string;
  /** The site with everything prunable pruned. */
  readonly totalBytes: number;
  readonly hardBytes: number;
  readonly neededBytes: number;
  readonly breakdown: Breakdown;
  /** The runs that can't be pruned, in history order. */
  readonly protectedRuns: readonly string[];
}

const FIXED_CATEGORIES: ReadonlySet<SiteCategory> = new Set(["html", "app", "api", "data"]);

function emptyBreakdown(): Breakdown {
  return { html: 0, app: 0, api: 0, stubs: 0, data: 0, blobs: 0, derived: 0, grace: 0 };
}

function size(value: number, what: string): number {
  return checkBytes(value, `the projected size of ${what}`);
}

/** The served files a run owns: its record, changes.json and permalink stub. */
export function runSiteFiles(graph: StoreGraph, runKey: string, projected: ProjectedSizes): SiteFile[] {
  return [
    { path: runRecordPath(runKey), bytes: graph.runRecordBytes(runKey), category: "data" },
    { path: changesPath(runKey), bytes: size(projected.changes(runKey), changesPath(runKey)), category: "api" },
    { path: permalinkPath(runKey), bytes: size(projected.permalink(runKey), permalinkPath(runKey)), category: "stubs" },
  ];
}

/** A stream's file, plus its PR pointer for a PR stream. Nothing for an empty stream. */
export function streamSiteFiles(streamId: string, runKeys: readonly string[], projected: ProjectedSizes): SiteFile[] {
  const latest = runKeys.at(-1);
  if (latest === undefined) return [];
  const files: SiteFile[] = [{ path: streamPath(streamId), bytes: size(projected.stream(streamId, runKeys), streamPath(streamId)), category: "data" }];
  if (streamId !== "main") {
    const pr = streamId.slice(3);
    files.push({ path: prPointerPath(pr), bytes: size(projected.prPointer(pr, latest), prPointerPath(pr)), category: "api" });
  }
  return files;
}

/** The assembled site, kept up to date as runs and grace namespaces leave it. */
class Site {
  readonly breakdown = emptyBreakdown();
  total = 0;
  private readonly owned = new Map<string, readonly SiteFile[]>();
  private readonly pooled = new Map<string, { file: SiteFile; count: number }>();
  private readonly streams = new Map<string, string[]>();
  private readonly graph: StoreGraph;
  private readonly projected: ProjectedSizes;

  constructor(graph: StoreGraph, projected: ProjectedSizes, runs: readonly RetainedRun[], grace: readonly string[]) {
    this.graph = graph;
    this.projected = projected;
    for (const file of projected.fixed) {
      if (!FIXED_CATEGORIES.has(file.category)) refuse("invalid-input", "a fixed file is html, app, api or data");
      size(file.bytes, "a fixed file");
    }
    this.own("fixed", projected.fixed);
    if (!graph.derivedKnown) {
      this.own("derived", graph.derivedFiles.map((path) => ({ path, bytes: graph.bytes(path), category: "derived" })));
    }
    for (const run of runs) {
      this.own(`run:${run.runKey}`, runSiteFiles(graph, run.runKey, projected));
      this.reference(graph.refs(run.runKey), 1);
      if (run.stream !== undefined) {
        const keys = this.streams.get(run.stream);
        if (keys) keys.push(run.runKey);
        else this.streams.set(run.stream, [run.runKey]);
      }
    }
    for (const [streamId, keys] of this.streams) this.own(`stream:${streamId}`, streamSiteFiles(streamId, keys, projected));
    for (const namespace of grace) this.addGrace(namespace);
  }

  removeRun(run: RetainedRun): void {
    this.own(`run:${run.runKey}`, []);
    this.reference(this.graph.refs(run.runKey), -1);
    if (run.stream === undefined) return;
    const keys = (this.streams.get(run.stream) ?? []).filter((k) => k !== run.runKey);
    this.streams.set(run.stream, keys);
    this.own(`stream:${run.stream}`, streamSiteFiles(run.stream, keys, this.projected));
  }

  removeGrace(namespace: string): void {
    this.own(`grace:${namespace}`, []);
    this.reference(this.graph.graceRefs(namespace), -1);
  }

  /** Every served file, by path. Two sources naming one path refuse the plan. */
  files(): SiteFile[] {
    const files = [...[...this.owned.values()].flat(), ...[...this.pooled.values()].map((p) => p.file)];
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (let i = 1; i < files.length; i++) {
      if (files[i]?.path === files[i - 1]?.path) refuse("invalid-input", "two site files share a path");
    }
    if (files.reduce((sum, f) => sum + f.bytes, 0) !== this.total) throw new Error("site total out of step with its files");
    return files;
  }

  private addGrace(namespace: string): void {
    const files = this.graph.graceFiles.get(namespace) ?? [];
    this.own(`grace:${namespace}`, files.map((f) => ({ path: f.path, bytes: f.bytes, category: "grace" })));
    this.reference(this.graph.graceRefs(namespace), 1);
  }

  private count(file: SiteFile, sign: 1 | -1): void {
    this.total += sign * file.bytes;
    this.breakdown[file.category] += sign * file.bytes;
  }

  private own(owner: string, files: readonly SiteFile[]): void {
    for (const file of this.owned.get(owner) ?? []) this.count(file, -1);
    for (const file of files) this.count(file, 1);
    if (files.length === 0) this.owned.delete(owner);
    else this.owned.set(owner, files);
  }

  private reference(refs: { blobs: readonly string[]; derived: readonly string[] }, sign: 1 | -1): void {
    const pooled = [...refs.blobs.map((path) => ({ path, category: "blobs" as const })), ...refs.derived.map((path) => ({ path, category: "derived" as const }))];
    for (const { path, category } of pooled) {
      const entry = this.pooled.get(path) ?? { file: { path, bytes: this.graph.bytes(path), category }, count: 0 };
      entry.count += sign;
      if (sign === 1 && entry.count === 1) this.count(entry.file, 1);
      if (entry.count === 0) {
        this.count(entry.file, -1);
        this.pooled.delete(path);
      } else {
        this.pooled.set(path, entry);
      }
    }
  }
}

const REASONS: readonly PruneReason[] = ["closed-pr", "unassociated", "unpinned", "pinned"];

/** Pruning tier, or undefined for a run that's never pruned. */
function tier(run: RetainedRun, newRun: string | undefined): number | undefined {
  if (run.protected || run.runKey === newRun) return undefined;
  if (run.pinned) return 3;
  if (run.runClass === "closed-pr") return 0;
  if (run.runClass === "unassociated") return 1;
  return 2;
}

export function planBudget(input: BudgetInput): BudgetPlan | BudgetRefusal {
  const { graph, retention, projected } = input;
  const now = checkTimestamp(input.now, "now");
  const limits = checkLimits(input.limits);
  if (input.newRun !== undefined && !graph.entries.has(input.newRun)) refuse("invalid-input", "the new run isn't in the store");

  const namespaces = [...graph.grace.values()].filter((g) => graph.graceFiles.has(g.namespace));
  namespaces.sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : a.namespace < b.namespace ? -1 : 1));
  const live = namespaces.filter((g) => g.until > now).map((g) => g.namespace);
  const dropped: GraceDrop[] = namespaces
    .filter((g) => g.until <= now)
    .map((g) => ({ namespace: g.namespace, reason: "expired" as const }))
    .sort((a, b) => (a.namespace < b.namespace ? -1 : 1));

  const site = new Site(graph, projected, retention.retained, live);
  const kept = new Set(live);
  for (const namespace of live) {
    if (site.total <= limits.hardBytes) break;
    site.removeGrace(namespace);
    kept.delete(namespace);
    dropped.push({ namespace, reason: "budget" });
  }

  const candidates = retention.retained
    .map((run) => ({ run, tier: tier(run, input.newRun) }))
    .filter((c): c is { run: RetainedRun; tier: number } => c.tier !== undefined)
    .sort((a, b) => a.tier - b.tier);
  const pruned: PrunedRun[] = [];
  for (const { run, tier: t } of candidates) {
    if (site.total <= limits.hardBytes) break;
    site.removeRun(run);
    pruned.push({ runKey: run.runKey, ...(run.stream === undefined ? {} : { stream: run.stream }), reason: REASONS[t] ?? "pinned" });
  }

  const gone = new Set(pruned.map((p) => p.runKey));
  const retained = retention.retained.filter((r) => !gone.has(r.runKey));
  const files = site.files();
  const breakdown = { ...site.breakdown };
  if (site.total > limits.hardBytes) {
    const needed = site.total - limits.hardBytes;
    return {
      ok: false,
      reason:
        `the protected runs (the latest main run, each kept open or unknown PR's latest run and the new run) ` +
        `need ${String(site.total)} bytes, ${String(needed)} over the hard limit of ${String(limits.hardBytes)}; ` +
        `the transaction is refused and the previous site stays`,
      totalBytes: site.total,
      hardBytes: limits.hardBytes,
      neededBytes: needed,
      breakdown,
      protectedRuns: retained.map((r) => r.runKey),
    };
  }
  return {
    ok: true,
    totalBytes: site.total,
    breakdown,
    limits,
    overSoftLimit: site.total > limits.softBytes,
    retained,
    pruned,
    grace: { kept: [...kept], dropped },
    site: files,
  };
}

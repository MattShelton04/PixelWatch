// One housekeeping plan per store transaction (03 §§1, 5; ADR 0012): retention, then the budget
// over the assembled site, then GC of the store tree. Pure: time, PR states, pins and projected
// sizes are injected. A refusal returns no GC plan, so the caller writes nothing and the previous
// site stays.
import { type BudgetPlan, type BudgetRefusal, type ProjectedSizes, type SiteFile, type SizeLimits, planBudget, runSiteFiles, streamSiteFiles } from "./budget.ts";
import { checkTimestamp } from "./errors.ts";
import { type GcPlan, planGc } from "./gc.ts";
import { type PrState, type RetentionPlan, type RetentionPolicy, selectRetention } from "./retention.ts";
import { type StoreGraph, type StoreTree, readStoreTree } from "./tree.ts";

export interface HousekeepingInput extends StoreTree {
  readonly policy: RetentionPolicy;
  readonly limits: SizeLimits;
  readonly now: string;
  readonly prStates: ReadonlyMap<string, PrState>;
  readonly pins?: ReadonlySet<string> | undefined;
  readonly projected: ProjectedSizes;
  /** The run this transaction adds, if any. */
  readonly newRun?: string | undefined;
}

export type HousekeepingPlan =
  | {
      readonly ok: true;
      readonly retention: RetentionPlan;
      readonly budget: BudgetPlan;
      readonly gc: GcPlan;
      /**
       * Generated served files that leave the site with their runs and streams: run records,
       * changes.json, permalink stubs, stream files and PR pointers. Pool and grace files leave
       * at the same paths as in `gc.delete`.
       */
      readonly served: { readonly removed: readonly SiteFile[] };
      /** The new run is outside retention (e.g. an old run published late): stored, then expired. */
      readonly newRunExpired: boolean;
    }
  | { readonly ok: false; readonly retention: RetentionPlan; readonly refusal: BudgetRefusal; readonly newRunExpired: boolean };

function removedServedFiles(graph: StoreGraph, budget: BudgetPlan, projected: ProjectedSizes): SiteFile[] {
  const after = new Set(budget.site.map((f) => f.path));
  const kept = new Set(budget.retained.map((r) => r.runKey));
  const removed: SiteFile[] = [];
  const streams = new Map<string, string[]>();
  for (const entry of graph.store.runs) {
    if (!kept.has(entry.runKey)) removed.push(...runSiteFiles(graph, entry.runKey, projected));
    if (entry.stream === undefined) continue;
    const keys = streams.get(entry.stream);
    if (keys) keys.push(entry.runKey);
    else streams.set(entry.stream, [entry.runKey]);
  }
  for (const [streamId, keys] of streams) {
    for (const file of streamSiteFiles(streamId, keys, projected)) if (!after.has(file.path)) removed.push(file);
  }
  return removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function planHousekeeping(input: HousekeepingInput): HousekeepingPlan {
  const now = checkTimestamp(input.now, "now");
  const graph = readStoreTree(input);
  const retention = selectRetention({ store: graph.store, policy: input.policy, prStates: input.prStates, pins: input.pins });
  const newRunExpired = input.newRun !== undefined && !retention.retained.some((r) => r.runKey === input.newRun);
  const budget = planBudget({ graph, retention, now, projected: input.projected, limits: input.limits, newRun: input.newRun });
  if (!budget.ok) return { ok: false, retention, refusal: budget, newRunExpired };
  const gc = planGc(graph, { runs: new Set(budget.retained.map((r) => r.runKey)), grace: new Set(budget.grace.kept) });
  return { ok: true, retention, budget, gc, served: { removed: removedServedFiles(graph, budget, input.projected) }, newRunExpired };
}

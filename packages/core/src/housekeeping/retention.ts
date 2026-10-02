// Retention (03 §5; ADR 0012): which runs the store keeps. A pure function of the validated store
// index, the policy, a PR-state snapshot and pins. No clock, network or forge.
//
// - main keeps its latest `mainRuns` runs; each kept PR stream its latest `runsPerPr`.
// - At most `prStreams` PR streams: open (and unknown) PRs first, then closed ones, each by most
//   recent capture. A PR the snapshot doesn't know is unknown, never closed, and it's reported.
// - Runs in no stream (ADR 0011) keep their latest `runsPerPr` as one group.
// - A pinned run is kept whatever the counts say; the hard budget can still prune it.
// - Order is history order (`compareRunOrder`), never publish time or lexical order.
import { type Config, type Store, compareRunOrder, isGitHubId, parseRunKey, validateDocument } from "@pixelwatch/schemas";
import { refuse } from "./errors.ts";

export type PrState = "open" | "closed" | "unknown";

export interface RetentionPolicy {
  readonly mainRuns: number;
  readonly runsPerPr: number;
  readonly prStreams: number;
}

/** config@1's retention, with the schema defaults (03 §5). */
export function retentionPolicy(config: Config): RetentionPolicy {
  const r = config.retention;
  return checkPolicy({ mainRuns: r?.mainRuns ?? 30, runsPerPr: r?.runsPerPr ?? 5, prStreams: r?.prStreams ?? 30 });
}

export interface RetentionInput {
  readonly store: Store;
  readonly policy: RetentionPolicy;
  /** Last known state per PR number. A PR missing from the snapshot is unknown. */
  readonly prStates: ReadonlyMap<string, PrState>;
  /** Pinned run keys. Nothing writes pins yet (ADR 0012), so this is usually empty. */
  readonly pins?: ReadonlySet<string> | undefined;
}

/** What a run is to the budget's pruning order. */
export type RunClass = "main" | "open-pr" | "unknown-pr" | "closed-pr" | "unassociated";

export interface RetainedRun {
  readonly runKey: string;
  readonly sourceCreatedAt: string;
  readonly stream?: string;
  readonly runClass: RunClass;
  readonly pinned: boolean;
  /** The latest main run, or the latest run of a kept open or unknown PR stream: never pruned. */
  readonly protected: boolean;
}

export type ExpiryReason = "main-limit" | "pr-run-limit" | "pr-stream-limit" | "unassociated-limit";

export interface ExpiredRun {
  readonly runKey: string;
  readonly stream?: string;
  readonly reason: ExpiryReason;
}

export interface PrStreamRetention {
  readonly streamId: string;
  readonly prNumber: string;
  readonly state: PrState;
  /** The stream's most recent capture, which ranks it. */
  readonly latest: string;
  readonly retained: boolean;
}

export interface RetentionPlan {
  /** In history order. */
  readonly retained: readonly RetainedRun[];
  /** In history order. */
  readonly expired: readonly ExpiredRun[];
  /** Every PR stream in rank order. */
  readonly prStreams: readonly PrStreamRetention[];
  /** PR numbers whose state is unknown, numerically. They're kept like open PRs. */
  readonly unknownPrStates: readonly string[];
  /** Pins naming no run in the store. */
  readonly unknownPins: readonly string[];
}

type Entry = Store["runs"][number];

const PR_STATES: ReadonlySet<string> = new Set(["open", "closed", "unknown"]);

function checkCount(value: number, min: number, max: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) refuse("invalid-input", `${what} must be an integer from ${String(min)} to ${String(max)}`);
}

/** The config@1 bounds. */
export function checkPolicy(policy: RetentionPolicy): RetentionPolicy {
  checkCount(policy.mainRuns, 1, 1000, "retention.mainRuns");
  checkCount(policy.runsPerPr, 1, 100, "retention.runsPerPr");
  checkCount(policy.prStreams, 0, 1000, "retention.prStreams");
  return { mainRuns: policy.mainRuns, runsPerPr: policy.runsPerPr, prStreams: policy.prStreams };
}

export function checkStore(store: Store): Store {
  const result = validateDocument("store", store);
  if (!result.ok) refuse("invalid-input", `invalid store: ${result.issue.message}`);
  return result.value;
}

function checkPrStates(states: ReadonlyMap<string, PrState>): ReadonlyMap<string, PrState> {
  for (const [pr, state] of states) {
    if (!isGitHubId(pr)) refuse("invalid-input", "PR-state keys must be PR numbers");
    if (!PR_STATES.has(state)) refuse("invalid-input", "a PR state must be open, closed or unknown");
  }
  return states;
}

function checkPins(pins: ReadonlySet<string> | undefined): ReadonlySet<string> {
  for (const pin of pins ?? []) if (parseRunKey(pin) === undefined) refuse("invalid-input", "a pin must be a run key");
  return pins ?? new Set();
}

const numerically = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

export function selectRetention(input: RetentionInput): RetentionPlan {
  const store = checkStore(input.store);
  const policy = checkPolicy(input.policy);
  const states = checkPrStates(input.prStates);
  const pins = checkPins(input.pins);

  const main: Entry[] = [];
  const unassociated: Entry[] = [];
  const prs = new Map<string, Entry[]>();
  for (const entry of store.runs) {
    if (entry.stream === undefined) unassociated.push(entry);
    else if (entry.stream === "main") main.push(entry);
    else {
      const stream = prs.get(entry.stream);
      if (stream) stream.push(entry);
      else prs.set(entry.stream, [entry]);
    }
  }

  // Rank PR streams: open and unknown before closed, then by most recent capture (newest first).
  const ranked = [...prs].map(([streamId, entries]) => {
    const prNumber = streamId.slice(3);
    const latest = entries.at(-1) as Entry;
    return { streamId, prNumber, state: states.get(prNumber) ?? "unknown", latest, entries };
  });
  ranked.sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed") || compareRunOrder(b.latest, a.latest));

  const expiry = new Map<string, ExpiryReason>();
  const runClass = new Map<string, RunClass>();
  const expireAllBut = (entries: readonly Entry[], keep: number, reason: ExpiryReason) => {
    for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) expiry.set(entry.runKey, reason);
  };
  const protectedKeys = new Set<string>();

  expireAllBut(main, policy.mainRuns, "main-limit");
  for (const entry of main) runClass.set(entry.runKey, "main");
  if (main.length > 0) protectedKeys.add((main.at(-1) as Entry).runKey);

  const prStreams: PrStreamRetention[] = ranked.map((s, rank) => {
    const retained = rank < policy.prStreams;
    if (retained) expireAllBut(s.entries, policy.runsPerPr, "pr-run-limit");
    else expireAllBut(s.entries, 0, "pr-stream-limit");
    if (retained && s.state !== "closed") protectedKeys.add(s.latest.runKey);
    for (const entry of s.entries) runClass.set(entry.runKey, `${s.state}-pr`);
    return { streamId: s.streamId, prNumber: s.prNumber, state: s.state, latest: s.latest.runKey, retained };
  });

  expireAllBut(unassociated, policy.runsPerPr, "unassociated-limit");
  for (const entry of unassociated) runClass.set(entry.runKey, "unassociated");

  const retained: RetainedRun[] = [];
  const expired: ExpiredRun[] = [];
  for (const entry of store.runs) {
    const stream = entry.stream === undefined ? {} : { stream: entry.stream };
    const pinned = pins.has(entry.runKey);
    const reason = expiry.get(entry.runKey);
    if (reason !== undefined && !pinned) {
      expired.push({ runKey: entry.runKey, ...stream, reason });
      continue;
    }
    retained.push({
      runKey: entry.runKey,
      sourceCreatedAt: entry.sourceCreatedAt,
      ...stream,
      runClass: runClass.get(entry.runKey) ?? "unassociated",
      pinned,
      protected: protectedKeys.has(entry.runKey),
    });
  }

  const known = new Set(store.runs.map((r) => r.runKey));
  return {
    retained,
    expired,
    prStreams,
    unknownPrStates: ranked
      .filter((s) => s.state === "unknown")
      .map((s) => s.prNumber)
      .sort(numerically),
    unknownPins: [...pins].filter((p) => !known.has(p)).sort(),
  };
}

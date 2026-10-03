export const INTERLEAVINGS = [
  "ingest-same-tip", "push-accepted", "lease-conflict", "project-lock-read",
  "coalesced-projector", "head-before-comment", "older-release", "comment-accepted",
  "deploy-cancelled", "cdn-regression", "migration-lease", "github-redirect",
  "version-before-write", "viewer-stale",
] as const;
export type FaultPoint = typeof INTERLEAVINGS[number];
export type FaultEffect = "conflict" | "fail-before" | "accepted-timeout" | "cancelled-after" | "stale";
export interface Fault { actor: string; point: FaultPoint; occurrence: number; effect: FaultEffect }
export class Faults {
  readonly trace: string[] = [];
  #plan: readonly Fault[];
  #counts = new Map<string, number>();
  #reached = new Set<Fault>();
  constructor(plan: readonly Fault[]) {
    const keys = plan.map((f) => `${f.actor}:${f.point}:${String(f.occurrence)}`);
    if (new Set(keys).size !== keys.length) throw new Error("fault-ambiguous");
    for (const f of plan) {
      if (!/^[a-z][a-z0-9-]*$/.test(f.actor) || !INTERLEAVINGS.includes(f.point) || !["conflict", "fail-before", "accepted-timeout", "cancelled-after", "stale"].includes(f.effect) || !Number.isSafeInteger(f.occurrence) || f.occurrence < 1) throw new Error("fault-invalid");
    }
    this.#plan = plan.map((f) => ({ ...f }));
  }
  hit(actor: string, point: FaultPoint): FaultEffect | undefined {
    const key = `${actor}:${point}`;
    const occurrence = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, occurrence);
    const fault = this.#plan.find((f) => f.actor === actor && f.point === point && f.occurrence === occurrence);
    if (fault === undefined) return undefined;
    this.#reached.add(fault);
    this.trace.push(`${key}:${String(occurrence)}:${fault.effect}`);
    return fault.effect;
  }
  assertReached(): void {
    if (this.#reached.size !== this.#plan.length) throw new Error("fault-not-reached");
  }
}

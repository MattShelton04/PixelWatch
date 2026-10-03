// Executable assertions and written stimuli, not a toy implementation of the missing product.
import assert from "node:assert/strict";
import type { Fault, FaultPoint } from "../faults.ts";
export type Prerequisite = "M2.1" | "M2.2" | "M2.3" | "M2.7" | "M3.1" | "M3.4";
export interface Observation {
  kind: "fetch" | "push" | "lock" | "read-store" | "read-config" | "deploy" | "ready" | "head" | "comment" | "rediscover" | "preview";
  actor: string; tip?: string; expected?: string; runKey?: string; head?: string;
  generation?: string; release?: string; config?: string;
}
export interface Evidence {
  events?: readonly Observation[]; runs?: readonly string[]; attempts?: readonly number[];
  beforeTip?: string; afterTip?: string; beforeSite?: string; afterSite?: string;
  summary?: string; comments?: readonly { runKey: string; head: string; generation: string }[];
  polls?: readonly boolean[]; pollTimes?: readonly number[]; configCommit?: string;
  siteRelease?: string; previousCommentRun?: string; reloads?: number; fallback?: string;
  freshPreview?: boolean; authorization?: readonly boolean[]; logs?: readonly string[];
  coverage?: string; noMisparse?: boolean; generation?: string; repairedGeneration?: string;
  storeTips?: readonly string[]; refusals?: readonly string[];
}
export interface ScenarioCase {
  name: string; requires: readonly Prerequisite[];
  stimulus: string;
  barriers: readonly FaultPoint[]; faults: readonly Fault[];
  verify: (evidence: Evidence) => void;
}
export interface Scenario { id: string; cases: readonly ScenarioCase[] }
export function spec(name: string, requires: readonly Prerequisite[], point: FaultPoint,
  effect: Fault["effect"], stimulus: string, verify: ScenarioCase["verify"]): ScenarioCase {
  return { name, requires, stimulus, barriers: [point], faults: [{ actor: "a", point, occurrence: 1, effect }], verify };
}
export function events(e: Evidence): readonly Observation[] { assert.ok(e.events); return e.events; }
export function noWrites(e: Evidence): void {
  assert.equal(events(e).filter((x) => ["push", "deploy", "comment"].includes(x.kind)).length, 0);
}
export function bounded(e: Evidence): void {
  assert.ok(e.attempts && e.attempts.length > 0);
  for (const attempts of e.attempts) assert.ok(attempts >= 1 && attempts <= 5);
}
export function afterLock(e: Evidence): void {
  const list = events(e);
  const reads = list.filter((x) => x.kind === "read-store" || x.kind === "read-config");
  assert.ok(reads.length > 0);
  for (const read of reads) assert.ok(list.slice(0, list.indexOf(read)).some((x) => x.kind === "lock" && x.actor === read.actor));
}
export function noRollback(e: Evidence): void {
  assert.ok(e.comments && e.comments.length > 0);
  for (const c of e.comments) assert.equal(c.runKey, "102-a1");
}
export function noStaleDeployment(e: Evidence): void {
  assert.ok(e.storeTips && e.storeTips.length > 0);
  assert.equal(new Set(e.storeTips).size, e.storeTips.length);
  const deployments = events(e).filter((x) => x.kind === "deploy");
  assert.ok(deployments.length > 0);
  let previous = -1;
  for (const deployment of deployments) {
    assert.ok(deployment.tip);
    const index = e.storeTips.indexOf(deployment.tip);
    assert.ok(index >= 0 && index >= previous);
    previous = index;
  }
}

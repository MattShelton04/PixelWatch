import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runStoreCase, type StoreCaseKey } from "./store.ts";
import { SEEDS } from "../schedule.ts";
import { assertNoSecrets } from "../capture.ts";
import ingest from "../scenarios/sim-ingest-cas-race.sim.test.ts";
import unknown from "../scenarios/sim-push-outcome-unknown.sim.test.ts";

interface Trace {
  schedule: string[]; faults: string[]; pushes: { actor: string; expected: string; status: string }[];
  facts: { sameTipBeforePush: boolean; rejectedLeases: number; unknownReturned: boolean; mutatedInput: boolean; canonicalRunUnchanged: boolean; retryDelays: number };
}
async function repeat(caseKey: StoreCaseKey, seed: number) {
  const first = await runStoreCase(caseKey, seed); const repeated = await runStoreCase(caseKey, seed);
  expect(first.normalized).toBe(repeated.normalized); expect(first.evidence).toEqual(repeated.evidence); assertNoSecrets([first.normalized, JSON.stringify(first.evidence)]);
  const trace = JSON.parse(first.normalized) as Trace; expect(trace.schedule.length).toBeGreaterThan(0); expect(trace.faults).toHaveLength(1);
  const report = `${caseKey} seed=${String(seed)} trace-sha256=${createHash("sha256").update(first.normalized).digest("hex")} schedule=${JSON.stringify(trace.schedule)} faults=${JSON.stringify(trace.faults)}`;
  assertNoSecrets([report]); process.stdout.write(`${report}\n`); return { ...first, trace };
}
describe("production store simulation cases (M2.2, ADR 0015)", { timeout: 0 }, () => {
  it.each(SEEDS)("four production writers survive the same-tip lease conflict for seed %i", async (seed) => {
    const result = await repeat("sim-ingest-cas-race/four-writers", seed); ingest.cases[0]?.verify(result.evidence);
    expect(result.trace.facts.sameTipBeforePush).toBe(true); expect(result.trace.facts.rejectedLeases).toBe(3);
    expect(result.trace.pushes.filter((push) => push.status === "accepted")).toHaveLength(4);
    expect(result.trace.pushes.every((push) => /^[a-f0-9]{40}$/.test(push.expected))).toBe(true);
    expect(result.trace.faults).toEqual(["a:ingest-same-tip:1:conflict"]);
  });
  it.each(SEEDS)("an accepted production push survives a lost reply and changed input for seed %i", async (seed) => {
    const result = await repeat("sim-push-outcome-unknown/accepted-push", seed); unknown.cases[0]?.verify(result.evidence);
    expect(result.trace.facts.unknownReturned).toBe(true); expect(result.trace.facts.mutatedInput).toBe(true);
    expect(result.trace.facts.canonicalRunUnchanged).toBe(true); expect(result.trace.facts.retryDelays).toBe(0);
    expect(result.trace.pushes).toHaveLength(1); expect(result.trace.pushes[0]?.status).toBe("accepted");
    expect(result.trace.faults).toEqual(["a:push-accepted:1:accepted-timeout"]);
  });
});

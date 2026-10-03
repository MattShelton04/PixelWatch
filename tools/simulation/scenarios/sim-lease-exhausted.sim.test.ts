import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BareRemote } from "../git.ts";
import { assertNoSecrets } from "../capture.ts";
import { Faults } from "../faults.ts";
import { SEEDS, Scheduler, checkpoint } from "../schedule.ts";
import { bounded, events, spec, type Scenario } from "./spec.ts";

// Runnable harness probe: actual rejected Git leases. Not store retries/site/repair acceptance.
export function probeLeaseExhaustion(): string {
  const traces: string[][] = [];
  for (const seed of SEEDS) {
    const remote = new BareRemote();
    try {
      const a = remote.writer("a"); const b = remote.writer("b");
      const initial = a.commit(new Map([["store.json", "initial"]]));
      assert.ok(a.push(initial, undefined));
      const schedule = new Scheduler(seed);
      const faults = new Faults([1, 2, 3, 4, 5].map((occurrence) => ({ actor: "a", point: "lease-conflict", occurrence, effect: "conflict" } as const)));
      for (let i = 1; i <= 5; i++) schedule.barrier(`read-${String(i)}`, ["a", "b"]);
      for (let i = 1; i <= 5; i++) schedule.barrier(`advanced-${String(i)}`, ["a", "b"]);
      let stale: string | undefined;
      let current = initial;
      let rejected = 0;
      schedule.add("a", function* () {
        for (let i = 1; i <= 5; i++) {
          yield checkpoint("fetch", () => { stale = a.fetch(); }, `read-${String(i)}`);
          yield checkpoint("wait", undefined, `advanced-${String(i)}`);
          yield checkpoint("lease-conflict", () => {
            assert.equal(faults.hit("a", "lease-conflict"), "conflict");
            const candidate = a.commit(new Map([["store.json", `candidate-${String(i)}`]]));
            assert.equal(a.push(candidate, stale), false); rejected++;
          });
        }
      });
      schedule.add("b", function* () {
        for (let i = 1; i <= 5; i++) {
          yield checkpoint("wait", undefined, `read-${String(i)}`);
          yield checkpoint("advance", () => {
            const candidate = b.commit(new Map([["store.json", `foreign-${String(i)}`]]));
            assert.ok(b.push(candidate, current)); current = candidate;
          }, `advanced-${String(i)}`);
        }
      });
      schedule.run(); faults.assertReached();
      assert.equal(rejected, 5);
      assert.equal(a.fetch(), current);
      assert.equal(a.read(current).get("store.json"), "foreign-5");
      assertNoSecrets([...schedule.trace, ...faults.trace, ...remote.trace, ...a.read(current).values()]);
      traces.push([...schedule.trace, ...faults.trace, ...remote.trace]);
    } catch { throw new Error(`lease-probe-failed seed=${String(seed)} point=lease-conflict`); }
    finally { remote.close(); }
  }
  assert.equal(traces.length, SEEDS.length);
  return createHash("sha256").update(JSON.stringify(traces)).digest("hex");
}
export default {
  id: "sim-lease-exhausted",
  cases: [spec("five-conflicts", ["M2.2", "M2.3"], "lease-conflict", "conflict",
    "Force five successive conflicts in the production writer; keep the pre-existing served tree; collect its pending/repair summary.", (e) => {
      bounded(e); assert.deepEqual(e.attempts, [5]);
      assert.ok(e.beforeTip && e.beforeSite);
      assert.equal(e.beforeTip, e.afterTip); assert.equal(e.beforeSite, e.afterSite);
      assert.ok(e.summary?.includes("repair"));
      assert.equal(events(e).filter((x) => x.kind === "deploy" || x.kind === "comment").length, 0);
    })],
} satisfies Scenario;

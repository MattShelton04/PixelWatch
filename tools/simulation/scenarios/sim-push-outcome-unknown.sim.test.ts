import assert from "node:assert/strict";
import { bounded, events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-push-outcome-unknown",
  cases: [spec("accepted-push", ["M2.2"], "push-accepted", "accepted-timeout",
    "Accept the production writer's push, then lose its response; refetch before retry with changed candidate contents.", (e) => {
      bounded(e);
      assert.deepEqual(e.runs, ["101-a1"]);
      assert.equal(events(e).filter((x) => x.kind === "push").length, 1);
      assert.ok(events(e).filter((x) => x.kind === "fetch").length >= 2);
      assert.ok(e.beforeTip && e.afterTip);
      assert.equal(e.beforeTip, e.afterTip); // accepted tip captured before client retry
    })],
} satisfies Scenario;

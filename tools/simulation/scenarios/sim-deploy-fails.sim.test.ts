import assert from "node:assert/strict";
import { events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-deploy-fails",
  cases: [spec("failure-cancellation-and-repair", ["M2.2", "M2.3"], "deploy-cancelled", "cancelled-after",
    "Run failed deployment, cancelled-before-deploy and cancelled-after-accepted-deploy variants; repair each with unchanged inputs.", (e) => {
      assert.deepEqual(e.runs, ["101-a1"]);
      assert.ok(e.summary?.includes("stored; deployment pending")); assert.ok(e.summary?.includes("repair"));
      assert.ok(e.generation); assert.equal(e.repairedGeneration, e.generation);
      assert.ok(events(e).some((x) => x.kind === "ready"));
    })],
} satisfies Scenario;

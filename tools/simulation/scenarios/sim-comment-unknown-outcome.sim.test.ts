import assert from "node:assert/strict";
import { events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-comment-unknown-outcome",
  cases: [spec("accepted-create", ["M2.1", "M2.3"], "comment-accepted", "accepted-timeout",
    "After readiness, accept a marker-owned comment create but lose the reply; rediscover before any retry.", (e) => {
      assert.equal(e.comments?.length, 1);
      assert.equal(events(e).filter((x) => x.kind === "comment").length, 1);
      assert.ok(events(e).some((x) => x.kind === "ready"));
      assert.ok(events(e).some((x) => x.kind === "rediscover"));
    })],
} satisfies Scenario;

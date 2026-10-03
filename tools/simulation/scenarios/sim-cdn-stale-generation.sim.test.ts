import assert from "node:assert/strict";
import { events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-cdn-stale-generation",
  cases: [spec("regressing-mixed-and-negative-cache", ["M2.3"], "cdn-regression", "stale",
    "At TTL 0/60/600/900 s inject old generation 200, stale pointer, wrong digest, cached 404, then pass/fail/pass/pass/pass at 10 s intervals.", (e) => {
      assert.deepEqual(e.polls, [false, false, false, false, true, false, true, true, true]);
      assert.ok(e.pollTimes && e.pollTimes.length === e.polls.length);
      for (let i = 1; i < e.pollTimes.length; i++) assert.ok((e.pollTimes[i] ?? 0) - (e.pollTimes[i - 1] ?? 0) >= 10_000);
      const list = events(e); const ready = list.findIndex((x) => x.kind === "ready");
      assert.ok(ready >= 0);
      for (const comment of list.filter((x) => x.kind === "comment")) assert.ok(list.indexOf(comment) > ready);
    })],
} satisfies Scenario;

import assert from "node:assert/strict";
import { bounded, events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-ingest-cas-race",
  cases: [spec("four-writers", ["M2.2"], "ingest-same-tip", "conflict",
    "Four production ingestors fetch the same marked tip; release all fetch barriers before pushes; advance the remote at the first lease push.", (e) => {
      bounded(e);
      assert.deepEqual([...(e.runs ?? [])].sort(), ["101-a1", "102-a1", "103-a1", "104-a1"]);
      const list = events(e);
      const firstPush = list.findIndex((x) => x.kind === "push");
      const fetches = list.slice(0, firstPush).filter((x) => x.kind === "fetch");
      assert.equal(new Set(fetches.map((x) => x.actor)).size, 4);
      assert.equal(new Set(fetches.map((x) => x.tip)).size, 1);
      for (const push of list.filter((x) => x.kind === "push")) assert.ok(push.expected);
    })],
} satisfies Scenario;

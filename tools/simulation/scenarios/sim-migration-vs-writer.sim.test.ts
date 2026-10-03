import assert from "node:assert/strict";
import { events, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-migration-vs-writer",
  cases: [spec("migration-and-rollback-conflict", ["M2.2", "M3.4"], "migration-lease", "conflict",
    "Pause migration and rollback after loss preview; commit an active writer before their lease pushes; demand a fresh preview of that tip.", (e) => {
      assert.equal(e.freshPreview, true);
      const list = events(e); const previews = list.filter((x) => x.kind === "preview");
      assert.ok(previews.length >= 2);
      assert.ok(previews[0]?.tip && previews[1]?.tip && previews[0].tip !== previews[1].tip);
    })],
} satisfies Scenario;

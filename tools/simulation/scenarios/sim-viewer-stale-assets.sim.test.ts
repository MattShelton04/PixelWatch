import assert from "node:assert/strict";
import { spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-viewer-stale-assets",
  cases: [spec("independent-html-js-json-and-404", ["M2.7", "M3.1"], "viewer-stale", "stale",
    "Independently cache old HTML, absent old JS, unsupported JSON and 404; repeat the failing load after the automatic reload.", (e) => {
      assert.ok(e.reloads !== undefined && e.reloads <= 1 && e.reloads >= 0);
      assert.equal(e.noMisparse, true); assert.equal(e.fallback, "static-reload-link");
    })],
} satisfies Scenario;

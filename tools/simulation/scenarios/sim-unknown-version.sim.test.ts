import assert from "node:assert/strict";
import { noWrites, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-unknown-version",
  cases: [spec("config-bundle-and-store", ["M2.1", "M2.2", "M2.3"], "version-before-write", "fail-before",
    "Independently supply future config, bundle and store versions to production ingest/project; forbid every push/deploy/comment.", (e) => {
      assert.deepEqual(e.refusals, ["unknown-config", "unknown-bundle", "unknown-store"]);
      noWrites(e);
    })],
} satisfies Scenario;

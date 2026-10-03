import assert from "node:assert/strict";
import { afterLock, events, noRollback, noStaleDeployment, spec, type Scenario } from "./spec.ts";
export default {
  id: "sim-deploy-comment-race",
  cases: [
    spec("A", ["M2.2", "M2.3"], "project-lock-read", "stale",
      "Queue A and B, reorder at lock acquisition, ingest both runs before B reads the store.", (e) => {
        afterLock(e); assert.deepEqual(e.runs, ["101-a1", "102-a1"]);
        const deploys = events(e).filter((x) => x.kind === "deploy");
        assert.equal(deploys.length, 2); noStaleDeployment(e);
      }),
    spec("B", ["M2.1", "M2.2", "M2.3"], "coalesced-projector", "cancelled-after",
      "Replace pending A with B after A's ingestion is durable; B repairs both retained PR comments.", (e) => {
        afterLock(e); assert.deepEqual(e.runs, ["101-a1", "102-a1"]);
        assert.deepEqual(e.comments?.map((x) => x.runKey).sort(), ["101-a1", "102-a1"]);
        assert.equal(events(e).filter((x) => x.kind === "deploy").length, 1);
      }),
    spec("C", ["M2.1", "M2.2", "M2.3"], "head-before-comment", "stale",
      "Advance the PR from old head to new head between selection and final head re-fetch; an older projector follows.", (e) => {
        noRollback(e);
        for (const comment of e.comments ?? []) assert.equal(comment.head, "b".repeat(40));
        const list = events(e);
        for (const comment of list.filter((x) => x.kind === "comment")) {
          const preceding = list.slice(0, list.indexOf(comment));
          const last = preceding.at(-1);
          assert.ok(last);
          assert.equal(last.kind, "head");
          assert.equal(last.head, comment.head);
        }
      }),
    spec("D", ["M2.1", "M2.2", "M2.3"], "older-release", "stale",
      "Project a newer release then an older one; resolve config after the second lock; retain newest head/comment.", (e) => {
        afterLock(e); noRollback(e);
        assert.equal(e.siteRelease, "old-release"); assert.ok(e.configCommit);
        const list = events(e); const deploys = list.filter((x) => x.kind === "deploy");
        assert.equal(deploys.length, 2); noStaleDeployment(e);
        assert.equal(list.filter((x) => x.kind === "read-config").at(-1)?.config, e.configCommit);
      }),
  ],
} satisfies Scenario;

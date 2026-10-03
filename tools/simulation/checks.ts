// The same executable checks run in pnpm check and in the standalone simulation runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Clock, SEEDS, Scheduler, checkpoint } from "./schedule.ts";
import { Faults, INTERLEAVINGS } from "./faults.ts";
import { Cdn, TTLS } from "./cdn.ts";
import { API, BLOB, FakeGitHub, download } from "./github.ts";
import { Capture, CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "./capture.ts";
import { BareRemote } from "./git.ts";
import { probeGitHubFaults } from "./scenarios/sim-github-faults.sim.test.ts";
import { probeLeaseExhaustion } from "./scenarios/sim-lease-exhausted.sim.test.ts";
export interface HarnessCheck { name: string; run: () => unknown }
// Recorded by running scheduleProbe on 2026-10-03; shared Linux/Windows assertions.
const TRACE_HASHES = [
  "e7f918005d7d4290631bac567665fc62ecbab991e458b8af9a4cc261cfa43ec5",
  "7a49a0f22b2b4499baf0a7ee7a3743bd0cbca4c18a5e37cc225ded2c861df52a",
  "940c6af9b93737bad1284456feb4310a8fc397fc55fb0f3e8637bc2391b58fad",
  "04eb3dbc2ed925563fb017c5b87fa812c26343de3a6dc58cec480826329ae19d",
];
export function scheduleProbe(seed: number): string[] {
  const schedule = new Scheduler(seed);
  schedule.barrier("fetched", ["a", "b", "c", "d"]);
  let readers = 0;
  for (const actor of ["d", "b", "a", "c"]) schedule.add(actor, function* () {
    yield checkpoint("fetch", () => { readers++; }, "fetched");
    yield checkpoint("push", () => { assert.equal(readers, 4); });
  });
  schedule.run(); return schedule.trace;
}
export const harnessChecks: readonly HarnessCheck[] = [
  { name: "barriers-and-seed-replay", run() {
    const unique = new Set<string>();
    for (const [index, seed] of SEEDS.entries()) {
      const trace = scheduleProbe(seed);
      assert.deepEqual(trace, scheduleProbe(seed));
      assertNoSecrets(trace);
      assert.equal(createHash("sha256").update(JSON.stringify(trace)).digest("hex"), TRACE_HASHES[index], `trace-drift seed=${String(seed)}`);
      unique.add(JSON.stringify(trace));
    }
    assert.ok(unique.size > 1);
  } },
  { name: "injected-clock", run() {
    const clock = new Clock();
    assert.equal(clock.now, 946684800000);
    assert.equal(clock.now, clock.now);
    clock.advance(10_000); assert.equal(clock.now, 946684810000);
    for (const ms of [-1, 0.1, NaN, Infinity]) assert.throws(() => { clock.advance(ms); });
  } },
  { name: "named-injection-reachability", run() {
    for (const seed of SEEDS) for (const point of INTERLEAVINGS) {
      const faults = new Faults([{ actor: "a", point, occurrence: 1, effect: "accepted-timeout" }]);
      const schedule = new Scheduler(seed);
      schedule.barrier("window", ["a", "b"]);
      let readers = 0;
      for (const actor of ["a", "b"]) schedule.add(actor, function* () {
        yield checkpoint("read", () => { readers++; }, "window");
        yield checkpoint(point, () => {
          assert.equal(readers, 2);
          if (actor === "a") assert.equal(faults.hit(actor, point), "accepted-timeout");
        });
      });
      schedule.run(); faults.assertReached(); assertNoSecrets([...schedule.trace, ...faults.trace]);
    }
  } },
  { name: "strict-fakes-and-redirects", run() {
    const absent = new FakeGitHub();
    assert.throws(() => absent.request({ method: "GET", url: `${API}/unknown` }));
    for (const origin of [API, BLOB]) {
      const fake = new FakeGitHub(); const capture = new Capture();
      const url = `${API}/repos/sim/upstream/actions/artifacts/201/zip`;
      const next = `${origin}/artifact.zip`;
      fake.route({ method: "GET", url }, [{ status: 302, headers: { location: next } }]);
      assert.throws(() => { fake.route({ method: "GET", url }, [{ status: 410 }]); });
      fake.route({ method: "GET", url: next }, [{ status: 200, body: new Uint8Array([1]) }]);
      assert.equal(download(fake, url, new Clock(), capture).kind, "downloaded");
      assert.deepEqual(fake.calls.map((c) => c.authorized), [true, origin === API]);
      fake.assertConsumed(); capture.assertClean(); assertNoSecrets([JSON.stringify(fake.calls)]);
      assert.throws(() => fake.request({ method: "GET", url }));
    }
  } },
  { name: "secret-containment", run() {
    const c = new Capture();
    c.log(CANARY_TOKEN); c.summary(SIGNED_URL); c.error(new Error(SIGNED_URL)); c.store("summary.txt", CANARY_TOKEN);
    c.assertClean(); assert.throws(() => { assertNoSecrets([CANARY_TOKEN]); });
  } },
  { name: "cdn-ttl-and-regression", run() {
    for (const ttl of TTLS) {
      const clock = new Clock(); const cdn = new Cdn(clock, ttl);
      cdn.deploy("old", new Map([["site.json", "old"], ["latest.json", "old"]]));
      assert.equal(cdn.get("a", "site.json").body, "old");
      cdn.deploy("new", new Map([["site.json", "new"], ["latest.json", "new"]]));
      assert.equal(cdn.get("b", "site.json").body, "new");
      assert.equal(cdn.get("a", "latest.json").body, "new");
      assert.equal(cdn.get("a", "site.json").body, ttl === 0 ? "new" : "old");
      clock.advance(ttl * 1000); assert.equal(cdn.get("a", "site.json").body, "new");
      cdn.script("runner", "site.json", [{ status: 200, body: "new", generation: "new" }, { status: 200, body: "old", generation: "old" }, { status: 404, body: "", generation: "old" }]);
      assert.equal(cdn.get("runner", "site.json").body, "new");
      assert.equal(cdn.get("runner", "site.json").body, "old");
      assert.equal(cdn.get("runner", "site.json").status, 404);
      assert.throws(() => cdn.get("runner", "site.json"));
      assert.throws(() => cdn.get("runner", "unknown.json")); assertNoSecrets(cdn.trace);
      cdn.deploy("with-preview", new Map([["preview.png", "image"]]));
      cdn.deploy("without-preview", new Map());
      assert.equal(cdn.get("negative", "preview.png").status, 404);
      cdn.deploy("with-preview-again", new Map([["preview.png", "image"]]));
      assert.equal(cdn.get("negative", "preview.png").status, ttl === 0 ? 200 : 404);
      clock.advance(ttl * 1000); assert.equal(cdn.get("negative", "preview.png").status, 200);
    }
  } },
  { name: "git-isolation-parentless-and-accepted-push", run() {
    const remote = new BareRemote();
    try {
      const writer = remote.writer("a");
      const oid = writer.commit(new Map([["store.json", "accepted"]]));
      assert.ok(writer.push(oid, undefined));
      // Deliberately discard the accepted push result: the remote is durable before the client knows.
      assert.equal(writer.fetch(), oid); assert.equal(writer.read(oid).get("store.json"), "accepted");
      assert.deepEqual(writer.parents(oid), []);
      for (const file of remote.storedFiles()) assertNoSecrets([readFileSync(file)]);
      assertNoSecrets(remote.trace);
    } finally { remote.close(); }
  } },
  { name: "sim-github-faults (HARNESS PROBE ONLY)", run: probeGitHubFaults },
  { name: "sim-lease-exhausted (HARNESS PROBE ONLY)", run: probeLeaseExhaustion },
];

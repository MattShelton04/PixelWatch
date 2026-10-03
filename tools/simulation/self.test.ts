// Tests first: harness evidence only. Product scenario coverage is reported by runner.ts.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Clock, SEEDS, Scheduler, checkpoint } from "./schedule.ts";
import { Faults, INTERLEAVINGS } from "./faults.ts";
import { BareRemote } from "./git.ts";
import { Cdn, TTLS } from "./cdn.ts";
import { FakeGitHub, API, BLOB, CANARY_TOKEN, SIGNED_URL, download } from "./github.ts";
import { Capture, assertNoSecrets } from "./capture.ts";
import { harnessChecks } from "./checks.ts";
import { scenarios } from "./scenarios/index.ts";
import { runSimulation, main } from "./runner.ts";
import { probeLeaseExhaustion } from "./scenarios/sim-lease-exhausted.sim.test.ts";
import { probeGitHubFaults } from "./scenarios/sim-github-faults.sim.test.ts";

// Simulation is bounded by steps and fixture queues, never by a wall-clock test deadline.
describe("simulation harness (ADR 0015; not product acceptance)", { timeout: 0 }, () => {
  it("barriers force all four readers to fetch before any writer pushes", () => {
    for (const seed of SEEDS) {
      const schedule = new Scheduler(seed);
      const reads: string[] = [];
      const writes: string[] = [];
      schedule.barrier("fetched", ["a", "b", "c", "d"]);
      for (const actor of ["a", "b", "c", "d"]) {
        schedule.add(actor, function* () {
          yield checkpoint("fetch", () => { reads.push(actor); }, "fetched");
          yield checkpoint("push", () => { expect(reads).toHaveLength(4); writes.push(actor); });
        });
      }
      schedule.run();
      expect(writes).toHaveLength(4);
      expect(schedule.trace.filter((x) => x.includes("release:fetched"))).toHaveLength(1);
    }
  });

  it("every seed reproduces the same complete trace exactly", () => {
    for (const seed of SEEDS) {
      const run = () => {
        const schedule = new Scheduler(seed);
        schedule.barrier("both", ["a", "b"]);
        for (const actor of ["b", "a"]) schedule.add(actor, function* () {
          yield checkpoint("read", undefined, "both");
          yield checkpoint("write");
          yield checkpoint("finish");
        });
        schedule.run();
        return schedule.trace;
      };
      expect(run()).toEqual(run());
    }
  });

  it("the clock never advances on its own and rejects backwards or fractional time", async () => {
    const clock = new Clock();
    const initial = clock.now;
    await Promise.resolve();
    expect(clock.now).toBe(initial);
    clock.advance(10_000);
    expect(clock.now).toBe(initial + 10_000);
    for (const value of [-1, 0.5, Infinity, NaN]) expect(() => { clock.advance(value); }).toThrow();
  });

  it("deadlocks and bounded-step exhaustion fail with the replay seed", () => {
    const schedule = new Scheduler(42, 8);
    schedule.barrier("missing", ["a", "b"]);
    schedule.add("a", function* () { yield checkpoint("read", undefined, "missing"); });
    expect(() => { schedule.run(); }).toThrow("seed=42");
    const endless = new Scheduler(42, 8);
    endless.add("a", function* () { for (;;) yield checkpoint("spin"); });
    expect(() => { endless.run(); }).toThrow("step-limit seed=42");
  });

  it("failure injection reaches every named racy interleaving under every seed", () => {
    for (const seed of SEEDS) for (const name of INTERLEAVINGS) {
      const faults = new Faults([{ actor: "a", point: name, occurrence: 1, effect: "accepted-timeout" }]);
      const schedule = new Scheduler(seed);
      let readers = 0;
      let mutation = 0;
      schedule.barrier("window", ["a", "b"]);
      for (const actor of ["a", "b"]) schedule.add(actor, function* () {
        yield checkpoint("read", () => { readers++; }, "window");
        yield checkpoint(name, () => {
          expect(readers).toBe(2);
          const effect = faults.hit(actor, name);
          mutation++;
          if (actor === "a") expect(effect).toBe("accepted-timeout");
        });
      });
      schedule.run();
      faults.assertReached();
      expect(mutation).toBe(2);
      expect(faults.trace).toEqual([`a:${name}:1:accepted-timeout`]);
    }
  });

  it("unused and duplicate fault plans fail instead of implying coverage", () => {
    expect(() => new Faults([
      { actor: "a", point: "push-accepted", occurrence: 1, effect: "accepted-timeout" },
      { actor: "a", point: "push-accepted", occurrence: 1, effect: "conflict" },
    ])).toThrow("ambiguous");
    expect(() => { new Faults([{ actor: "a", point: "push-accepted", occurrence: 1, effect: "accepted-timeout" }]).assertReached(); }).toThrow("not-reached");
  });

  it("the GitHub fake refuses unknown, ambiguous and exhausted requests", () => {
    const fake = new FakeGitHub();
    const request = { method: "GET" as const, url: `${API}/repos/sim/upstream/actions/runs/101` };
    expect(() => fake.request(request)).toThrow("unknown-request");
    fake.route(request, [{ status: 200, body: { message: "fixture" } }]);
    expect(() => { fake.route(request, [{ status: 200 }]); }).toThrow("ambiguous");
    expect(fake.request(request).status).toBe(200);
    expect(() => fake.request(request)).toThrow("exhausted");
    expect(() => fake.request({ ...request, headers: { Authorization: "x", authorization: "y" } })).toThrow("ambiguous-header");
  });

  it("a cross-origin 302 strips auth and a same-origin redirect retains it", () => {
    for (const origin of [API, BLOB]) {
      const fake = new FakeGitHub();
      const first = `${API}/repos/sim/upstream/actions/artifacts/201/zip`;
      const second = `${origin}/artifact.zip?sig=simulation-canary-signature`;
      fake.route({ method: "GET", url: first }, [{ status: 302, headers: { location: second } }]);
      fake.route({ method: "GET", url: second }, [{ status: 200, body: new Uint8Array([1, 2, 3]) }]);
      expect(download(fake, first, new Clock(), new Capture()).kind).toBe("downloaded");
      expect(fake.calls.map((call) => call.authorized)).toEqual([true, origin === API]);
    }
  });

  it("fake tokens and signed URLs never reach logs summaries errors or stored files", () => {
    const capture = new Capture();
    capture.log(`error ${CANARY_TOKEN} ${SIGNED_URL}`);
    capture.summary(`pending ${SIGNED_URL}`);
    capture.error(new Error(CANARY_TOKEN));
    capture.store("summary.txt", `${CANARY_TOKEN} ${SIGNED_URL}`);
    capture.assertClean();
    expect(JSON.stringify(capture)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(capture)).not.toContain("simulation-canary-signature");
    expect(() => { assertNoSecrets([SIGNED_URL]); }).toThrow("secret-leak");
  });

  it("the Git remote is temporary and isolated and only explicit leases can push", () => {
    const remote = new BareRemote();
    try {
      const a = remote.writer("a");
      const b = remote.writer("b");
      const first = a.commit(new Map([["store.json", "old"]]));
      expect(a.push(first, undefined)).toBe(true);
      expect(a.fetch()).toBe(first);
      expect(b.fetch()).toBe(first);
      const newer = b.commit(new Map([["store.json", "new"]]));
      expect(b.push(newer, first)).toBe(true);
      const stale = a.commit(new Map([["store.json", "stale"]]));
      expect(a.push(stale, first)).toBe(false);
      expect(a.fetch()).toBe(newer);
      expect(a.read(newer).get("store.json")).toBe("new");
      expect(remote.trace.every((line) => !line.includes("--force "))).toBe(true);
      expect(remote.trace.some((line) => line === "push:expected-absent:accepted")).toBe(true);
      expect(remote.environment["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(remote.environment["GIT_ALLOW_PROTOCOL"]).toBe("file");
      expect(remote.environment["GH_TOKEN"]).toBeUndefined();
      expect(remote.environment["GITHUB_TOKEN"]).toBeUndefined();
    } finally { remote.close(); }
  });

  it("hostile hooks and attributes never execute and commit IDs reproduce", () => {
    const commit = () => {
      const remote = new BareRemote();
      try {
        const sentinel = join(remote.root, "hook-ran");
        writeFileSync(join(remote.remotePath, "hooks", "pre-receive"), `#!/bin/sh\nprintf ran > '${sentinel.replaceAll("\\", "/")}'\n`, { mode: 0o755 });
        const writer = remote.writer("a");
        const oid = writer.commit(new Map([[".gitattributes", "* filter=evil"], ["store.json", "stable"]]));
        expect(writer.push(oid, undefined)).toBe(true);
        expect(existsSync(sentinel)).toBe(false);
        expect(writer.parents(oid)).toEqual([]);
        for (const file of remote.storedFiles()) assertNoSecrets([readFileSync(file)]);
        expect(oid).toBe("dc3db15812cfb7c007797141f3ca9e1972d29772");
        return oid;
      } finally { remote.close(); }
    };
    expect(commit()).toBe(commit());
  });

  it("accepted Git pushes remain discoverable after their replies are discarded", () => {
    const remote = new BareRemote();
    try {
      const writer = remote.writer("a");
      const oid = writer.commit(new Map([["store.json", "accepted"]]));
      writer.push(oid, undefined); // Lost response: only the subsequent fetch establishes success.
      expect(writer.fetch()).toBe(oid);
      expect(writer.read(oid).get("store.json")).toBe("accepted");
      expect(() => writer.commit(new Map([["store.json", CANARY_TOKEN]]))).toThrow("secret-leak");
    } finally { remote.close(); }
  });

  it("scripted GitHub creates mutate before a lost reply and can be rediscovered", () => {
    const fake = new FakeGitHub();
    const comments: { id: number; body: string; user: { id: number; login: string; type: string }; created_at: string; updated_at: string }[] = [];
    const url = `${API}/repos/sim/upstream/issues/3/comments`;
    fake.route({ method: "POST", url, body: { body: "marker" } }, [() => {
      comments.push({ id: 301, body: "marker", user: { id: 4, login: "simulation-bot", type: "Bot" }, created_at: "2000-01-01T00:00:00Z", updated_at: "2000-01-01T00:00:00Z" });
      throw new Error("fixture-outcome-unknown");
    }]);
    fake.route({ method: "GET", url }, [() => ({ status: 200, body: comments })]);
    expect(() => fake.request({ method: "POST", url, body: { body: "marker" } })).toThrow("outcome-unknown");
    expect(fake.request({ method: "GET", url }).body).toEqual(comments);
    expect(comments).toHaveLength(1);
    fake.assertConsumed();
  });

  it("CDN caches are independent by file and edge and expire only on injected time", () => {
    for (const ttl of TTLS) {
      const clock = new Clock();
      const cdn = new Cdn(clock, ttl);
      cdn.deploy("old", new Map([["site.json", "old"], ["latest.json", "old-pointer"]]));
      expect(cdn.get("a", "site.json").body).toBe("old");
      cdn.deploy("new", new Map([["site.json", "new"], ["latest.json", "new-pointer"]]));
      expect(cdn.get("b", "site.json").body).toBe("new");
      expect(cdn.get("a", "latest.json").body).toBe("new-pointer");
      expect(cdn.get("a", "site.json").body).toBe(ttl === 0 ? "new" : "old");
      clock.advance(ttl * 1000);
      expect(cdn.get("a", "site.json").body).toBe("new");
    }
  });

  it("CDN scripting reaches regressions mixed generations and negative cache entries", () => {
    const cdn = new Cdn(new Clock(), 600);
    cdn.deploy("new", new Map([["site.json", "new"], ["latest.json", "pointer"]]));
    cdn.script("runner", "site.json", [
      { status: 200, body: "new", generation: "new" },
      { status: 200, body: "old", generation: "old" },
      { status: 404, body: "", generation: "old" },
    ]);
    expect(cdn.get("runner", "site.json").body).toBe("new");
    expect(cdn.get("runner", "site.json").body).toBe("old");
    expect(cdn.get("runner", "latest.json").generation).toBe("new");
    expect(cdn.get("runner", "site.json").status).toBe(404);
    expect(() => cdn.get("runner", "site.json")).toThrow("exhausted");
    expect(() => cdn.get("runner", "unknown.json")).toThrow("unknown-path");
  });

  it.each(harnessChecks.filter((c) => !c.name.includes("HARNESS PROBE")))("runner harness check $name executes behind the network guard", (check) => {
    check.run();
  });

  it("a cached 404 survives a redeploy until its injected TTL expires", () => {
    const clock = new Clock(); const cdn = new Cdn(clock, 600);
    cdn.deploy("old", new Map([["preview.png", "image"]]));
    cdn.deploy("missing", new Map());
    expect(cdn.get("edge", "preview.png").status).toBe(404);
    cdn.deploy("repaired", new Map([["preview.png", "image"]]));
    expect(cdn.get("edge", "preview.png").status).toBe(404);
    clock.advance(599_999);
    expect(cdn.get("edge", "preview.png").status).toBe(404);
    clock.advance(1);
    expect(cdn.get("edge", "preview.png").body).toBe("image");
  });

  it("rejects five real stale leases per seed at the injected fetch-push interleaving", () => {
    expect(probeLeaseExhaustion()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bounds fake GitHub faults and strips auth without leaking canaries", () => {
    probeGitHubFaults();
  });

  it("runner failures print the seed safely and win over incomplete coverage", async () => {
    const result = await runSimulation([{ name: "failure-probe", run() { throw new Error(`seed=42 ${CANARY_TOKEN} ${SIGNED_URL}`); } }], new Map());
    expect(result.code).toBe(1);
    expect(result.output).toContain("seed=42");
    assertNoSecrets([result.output]);
    let help = "";
    expect(await main(["--help"], (value) => { help += value; })).toBe(4);
    expect(help).toContain("No scenario ran");
  });

  it("simulation code never reads token variables or uses ambient time randomness or sleeps", () => {
    const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? visit(join(directory, entry.name)) : entry.name.endsWith(".ts") && entry.name !== "self.test.ts" ? [join(directory, entry.name)] : []);
    for (const file of visit(import.meta.dirname)) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/process\.env(?:\.(?:GH_TOKEN|GITHUB_TOKEN)|\["(?:GH_TOKEN|GITHUB_TOKEN)"\])/);
      expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random|setTimeout|setInterval|Atomics\.wait/);
    }
  });

  it("the runner lists every unavailable case and exits incomplete instead of passing", async () => {
    const checks = [{ name: "runner-report-probe", run() {} }];
    // Explicit empty registry models missing adapters, without filtering the production CLI.
    const first = await runSimulation(checks, new Map());
    const second = await runSimulation(checks, new Map());
    expect(first).toEqual(second);
    expect(first.code).toBe(2);
    for (const scenario of scenarios) for (const test of scenario.cases) {
      expect(first.output).toContain(`NOT RUN ${scenario.id}/${test.name}`);
    }
    expect(first.output).toContain("PRODUCT COVERAGE INCOMPLETE");
    expect(first.output).not.toContain("all passed");
    expect(first.output).toContain("HARNESS ONLY");
  });

  it("scenario specifications cover 07 section 4 and reject evidence that lacks their invariants", () => {
    const design = readFileSync(join(import.meta.dirname, "../../docs/design/07-testing.md"), "utf8");
    const section = design.split("## 4.")[1]?.split("## 5.")[0] ?? "";
    const ids = [...new Set([...section.matchAll(/^\| `(sim-[a-z-]+)`/gm)].map((m) => m[1] ?? ""))].sort();
    expect(scenarios.map((s) => s.id).sort()).toEqual(ids);
    expect(scenarios.flatMap((s) => s.cases)).toHaveLength(14);
    expect(readdirSync(join(import.meta.dirname, "scenarios")).filter((x) => x.endsWith(".sim.test.ts")).sort())
      .toEqual(ids.map((id) => `${id}.sim.test.ts`).sort());
    for (const scenario of scenarios) for (const test of scenario.cases) {
      expect(test.requires.length).toBeGreaterThan(0);
      expect(test.barriers.length).toBeGreaterThan(0);
      expect(test.faults.length).toBeGreaterThan(0);
      expect(() => { test.verify({}); }).toThrow();
    }
  });
});

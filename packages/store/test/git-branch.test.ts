import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes } from "@pixelwatch/schemas";
import { GitBranchStore, writeRun, type StoreAdapter, type WriterCheckpoint, type GitCheckpoint } from "../src/index.ts";
import { candidate, METADATA, REPOSITORY_ID, run, Scratch } from "./helpers.ts";

const scratches: Scratch[] = [];
const adapters: GitBranchStore[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.close(); for (const scratch of scratches.splice(0)) scratch.close(); });
function fixture() {
  const scratch = new Scratch(); scratches.push(scratch);
  const make = (extra = {}) => { const adapter = new GitBranchStore({ remote: scratch.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main", testRemote: { root: scratch.root }, ...extra }); adapters.push(adapter); return adapter; };
  return { scratch, make };
}
const dependencies = { metadata: METADATA, delay: () => Promise.resolve(), jitter: () => 0 };
describe("marked Git store (M2.2)", () => {
  it("uses expected-absent and explicit stale leases and creates parentless commits", async () => {
    const { scratch, make } = fixture(); const a = make(); const b = make();
    expect((await a.read()).tip).toBeNull();
    const first = await a.cas(null, candidate()); expect(first.status).toBe("accepted");
    expect((await b.cas(null, candidate([run()]))).status).toBe("conflict");
    if (first.status !== "accepted") throw new Error("first push");
    expect((await a.cas(first.tip, candidate([run()]))).status).toBe("accepted");
    expect((await b.cas(first.tip, candidate([run("102")]))).status).toBe("conflict");
    expect(scratch.git(["cat-file", "commit", (await a.read()).tip ?? ""]).split("\n").filter((s) => s.startsWith("parent "))).toEqual([]);
  });
  it("refuses the default branch unsafe refs and production remotes before any write", () => {
    const { make, scratch } = fixture();
    for (const branch of ["main", "../main", "refs/heads/main", "x.lock", "x..y"]) expect(() => make({ branch })).toThrow();
    for (const remote of ["http://github.com/o/r.git", "https://evil.invalid/o/r.git", "https://github.com/o/r.git?token=fake-canary", "https://user:fake-canary@github.com/o/r.git", scratch.remote]) {
      expect(() => new GitBranchStore({ remote, repositoryId: REPOSITORY_ID, defaultBranch: "main" })).toThrow();
    }
    expect(scratch.git(["for-each-ref", "--format=%(refname)"])).toBe("");
  });
  it("refuses unmarked foreign and newer stores without initializing over them", async () => {
    for (const data of [canonicalBytes({ unrelated: true }), canonicalBytes({ ...candidate().store, repositoryId: "1" }), canonicalBytes({ ...candidate().store, dataVersion: 2 })]) {
      const { scratch, make } = fixture(); const old = scratch.seed(new Map([["store.json", data]])); const adapter = make();
      await expect(adapter.read()).rejects.toThrow(); await expect(adapter.cas(old, candidate())).rejects.toThrow();
      expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
    }
  });
  it("refuses hostile tree modes active files and attributes without executing hooks filters or helpers", async () => {
    for (const mode of ["100755", "120000"]) {
      const { scratch, make } = fixture(); scratch.seed(candidate().files, undefined, mode); await expect(make().read()).rejects.toThrow();
    }
    const { scratch, make } = fixture();
    const marker = join(scratch.root, "hook-ran"); const hook = join(scratch.remote, "hooks", "pre-receive");
    mkdirSync(join(scratch.remote, "hooks"), { recursive: true }); writeFileSync(hook, `#!/bin/sh\n touch '${marker.replaceAll("\\", "/")}'\nexit 1\n`, { mode: 0o755 });
    scratch.git(["config", "uploadpack.packObjectsHook", `touch '${marker.replaceAll("\\", "/")}'`]);
    expect((await make().cas(null, candidate())).status).toBe("accepted"); expect(existsSync(marker)).toBe(false);
    expect((await make().read()).store).toEqual(candidate().store); expect(existsSync(marker)).toBe(false);
    scratch.seed(new Map([[".gitattributes", new TextEncoder().encode("* filter=evil")], ["store.json", canonicalBytes(candidate().store)]]));
    await expect(make().read()).rejects.toThrow();
  });
  it("four readers at one barrier keep every run within five recomputations", async () => {
    const { make } = fixture(); const initial = make(); expect((await initial.cas(null, candidate())).status).toBe("accepted");
    const originalTip = (await initial.read()).tip;
    let readers = 0; let release: (() => void) | undefined; const barrier = new Promise<void>((resolve) => { release = resolve; });
    let pushers = 0; let pushRelease: (() => void) | undefined; const pushBarrier = new Promise<void>((resolve) => { pushRelease = resolve; }); let actualRejectedLeases = 0;
    const gitCheckpoint = async (event: GitCheckpoint) => {
      if (event.point === "before-push" && event.expectedTip === originalTip) { if (++pushers === 4) pushRelease?.(); await pushBarrier; }
      if (event.point === "after-push" && event.result === "conflict") actualRejectedLeases++;
    };
    const tips: (string | null)[] = [];
    const checkpoint = async (event: WriterCheckpoint) => {
      if (event.point === "after-read" && event.attempt === 1) { tips.push(event.tip); if (++readers === 4) release?.(); await barrier; }
    };
    const results = await Promise.all(["101", "102", "103", "104"].map((id) => writeRun(make({ checkpoint: gitCheckpoint }), { run: run(id), blobs: new Map() }, { ...dependencies, checkpoint })));
    expect(new Set(tips).size).toBe(1); expect(results.every((r) => r.attempts <= 5)).toBe(true);
    expect(pushers).toBe(4); expect(actualRejectedLeases).toBeGreaterThanOrEqual(3);
    expect((await initial.read()).store.runs.map((r) => r.runKey)).toEqual(["101-a1", "102-a1", "103-a1", "104-a1"]);
  }, 0); // ADR 0015 §5 lines 109–113: timer disabled; two fixed four-actor barriers, ≤5 attempts, bounded Git processes.
  it("an accepted push with a lost reply refetches and preserves the unchanged stored run", async () => {
    const { make } = fixture(); const adapter = make(); let pushes = 0; let reads = 0;
    const lost: StoreAdapter = { read: async () => { reads++; return adapter.read(); }, cas: async (tip, value) => { pushes++; const result = await adapter.cas(tip, value); return result.status === "accepted" ? { status: "unknown" } : result; } };
    const result = await writeRun(lost, { run: run(), blobs: new Map() }, dependencies);
    expect(pushes).toBe(1); expect(reads).toBe(2); expect(result.run).toEqual(run());
    const changed = run(); changed.claims = {};
    const retry = await writeRun(adapter, { run: changed, blobs: new Map() }, dependencies);
    expect(retry.added).toBe(false); expect(retry.tip).toBe(result.tip); expect(retry.run).toEqual(run());
  });
  it("five lease conflicts exhaust bounded retries without mutating the existing store", async () => {
    const { make } = fixture(); const adapter = make(); await adapter.cas(null, candidate()); const before = (await adapter.read()).tip;
    let pushes = 0; let delays = 0;
    const conflict: StoreAdapter = { read: () => adapter.read(), cas: () => { pushes++; return Promise.resolve({ status: "conflict" }); } };
    await expect(writeRun(conflict, { run: run(), blobs: new Map() }, { ...dependencies, delay: () => { delays++; return Promise.resolve(); } })).rejects.toThrow("lease-exhausted");
    expect(pushes).toBe(5); expect(delays).toBe(4); expect((await adapter.read()).tip).toBe(before);
  });
  it("validates expired indexed records and missing blob references before returning a snapshot", async () => {
    const { scratch, make } = fixture(); const value = candidate([run("101"), run("102")]); const invalid = run("101"); invalid.source.repositoryId = "1";
    value.files.set("data/v1/runs/101-a1/run.json", canonicalBytes(invalid)); const old = scratch.seed(value.files);
    await expect(make().read()).rejects.toThrow("store-graph-invalid"); await expect(make().cas(old, candidate())).rejects.toThrow("store-graph-invalid");
    expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
    const missing = fixture(); const noBlob = candidate([run("101", true), run("102")]); const noBlobTip = missing.scratch.seed(noBlob.files);
    await expect(missing.make().read()).rejects.toThrow("store-graph-invalid"); await expect(missing.make().cas(noBlobTip, candidate())).rejects.toThrow("store-graph-invalid");
    expect(missing.scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(noBlobTip);
  });
  it("refuses unknown grace namespaces active paths and malformed pooled PNGs before mutation", async () => {
    for (const path of ["data/v2/runs/101-a1/run.json", "index.html", `blobs/aa/${"a".repeat(64)}.png`]) {
      const { scratch, make } = fixture(); const value = candidate(); value.files.set(path, new TextEncoder().encode("fake-canary-token <script>")); const old = scratch.seed(value.files);
      await expect(make().read()).rejects.toThrow(); await expect(make().cas(old, candidate())).rejects.toThrow(); expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
    }
  });
  it("lost accepted replies contain no fake token signed URL or native Git diagnostic", async () => {
    const { make } = fixture(); let pushes = 0; const canary = "fake-canary-token"; const signed = "https://signed.invalid/a?token=fake-canary-token";
    const checkpoint = (event: GitCheckpoint) => { if (event.point === "after-push" && event.result === "accepted") { pushes++; return Promise.reject(new Error(`${canary} ${signed}`)); } return Promise.resolve(); };
    const adapter = make({ checkpoint }); const result = await writeRun(adapter, { run: run(), blobs: new Map() }, dependencies);
    expect(pushes).toBe(1); const raw = JSON.stringify(result); expect(raw).not.toContain(canary); expect(raw).not.toContain(signed);
    const snapshot = await adapter.read(); for (const file of snapshot.files) { const text = Buffer.from(await snapshot.readFile(file.path)).toString("utf8"); expect(text).not.toContain(canary); expect(text).not.toContain(signed); }
  });
  it("unknown native pushes return their privately computed attempted commit without leaking checkpoint errors", async () => {
    const { make } = fixture(); let reached = 0;
    const canary = "fake-canary-token"; const signed = "https://signed.invalid/a?token=fake-canary-token";
    const adapter = make({ checkpoint: (event: GitCheckpoint) => {
      if (event.point !== "after-push" || event.result !== "accepted") return Promise.resolve();
      reached++; Object.assign(event, { newTip: "f".repeat(40) });
      return Promise.reject(new Error(`${canary} ${signed}`));
    } });
    const outcome = await adapter.cas(null, candidate()); const current = await adapter.read();
    expect(reached).toBe(1); expect(current.tip).not.toBeNull(); expect(current.tip).not.toBe("f".repeat(40));
    expect(outcome).toEqual({ status: "unknown", attemptedTip: current.tip });
    const raw = JSON.stringify(outcome); expect(raw).not.toContain(canary); expect(raw).not.toContain(signed);
  });
  it("freezes CAS candidate bytes and paths before asynchronous validation", async () => {
    const { make } = fixture(); const adapter = make(); const value = candidate(); const expected = Buffer.from(value.files.get("store.json") ?? []);
    const pending = adapter.cas(null, value); queueMicrotask(() => { value.files.set("../../../escaped.txt", new TextEncoder().encode("fake-canary-token")); });
    expect((await pending).status).toBe("accepted"); expect(await (await adapter.read()).readFile("store.json")).toEqual(expected);
  });
  it("freezes CAS candidate byte contents before asynchronous validation", async () => {
    const { make } = fixture(); const adapter = make(); const value = candidate(); const expected = Buffer.from(value.files.get("store.json") ?? []);
    const pending = adapter.cas(null, value); queueMicrotask(() => { value.files.get("store.json")?.fill(1); });
    expect((await pending).status).toBe("accepted"); expect(await (await adapter.read()).readFile("store.json")).toEqual(expected);
  });
  it("an injected pack deadline terminates the child before indexing and preserves the remote tip", async () => {
    const { make, scratch } = fixture(); const old = scratch.seed(candidate().files); const controller = new AbortController(); let started = 0; let indexed = 0; let disposed = 0; let pid: number | undefined;
    const adapter = make({ timing: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) }, packCheckpoint: (event: { point: string; pid?: number }) => {
      if (event.point === "child-started") { started++; pid = event.pid; controller.abort("fake-canary-token https://signed.invalid/?token=fake-canary-token"); }
      if (event.point === "before-index") indexed++; return Promise.resolve();
    } });
    await expect(adapter.read()).rejects.toThrow("git-pack-command-failed"); expect(started).toBe(1); expect(indexed).toBe(0); expect(disposed).toBe(1); expect(pid).toBeDefined();
    const stoppedPid = pid; if (stoppedPid === undefined) throw new Error("missing fixture child"); expect(() => process.kill(stoppedPid, 0)).toThrow(); expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
  });
});

import { mkdirSync, symlinkSync, writeFileSync, linkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes } from "@pixelwatch/schemas";
import { LocalDirStore, writeRun } from "../src/index.ts";
import { candidate, METADATA, REPOSITORY_ID, run, Scratch } from "./helpers.ts";
const scratches: Scratch[] = [];
afterEach(() => { for (const scratch of scratches.splice(0)) scratch.close(); });
function fixture() { const scratch = new Scratch(); scratches.push(scratch); const directory = join(scratch.root, "local"); return { scratch, directory, make: () => new LocalDirStore({ directory, repositoryId: REPOSITORY_ID, defaultBranch: "main" }) }; }
describe("local directory store (M2.2)", () => {
  it("performs expected-absent and stale-tip CAS with stable immutable snapshot reads", async () => {
    const { make } = fixture(); const a = make(); const b = make(); const empty = await a.read(); expect(empty.tip).toBeNull();
    const first = await a.cas(null, candidate()); expect(first.status).toBe("accepted");
    const snapshot = await a.read(); const bytes = await snapshot.readFile("store.json");
    expect((await b.cas(null, candidate())).status).toBe("conflict"); expect((await a.cas(snapshot.tip, candidate([run()]))).status).toBe("accepted");
    expect((await b.cas(snapshot.tip, candidate([run("102")]))).status).toBe("conflict"); expect(await snapshot.readFile("store.json")).toEqual(bytes);
  });
  it("refuses symbolic links junctions and hard-linked store data without following them", async () => {
    const { make, scratch, directory } = fixture(); const outside = join(scratch.root, "outside"); mkdirSync(outside); symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(make().read()).rejects.toThrow();
    const other = fixture(); mkdirSync(other.directory); const target = join(other.scratch.root, "file"); writeFileSync(target, canonicalBytes(candidate().store)); linkSync(target, join(other.directory, ".pixelwatch-tip")); await expect(other.make().read()).rejects.toThrow();
  });
  it("refuses unmarked existing content and foreign metadata before mutation", async () => {
    const { directory, make } = fixture(); mkdirSync(directory); writeFileSync(join(directory, "store.json"), canonicalBytes(candidate().store)); await expect(make().read()).rejects.toThrow(); await expect(make().cas(null, candidate())).rejects.toThrow();
    const other = fixture(); const value = candidate(); const foreign = { ...value.store, repositoryId: "1" }; value.files.set("store.json", canonicalBytes(foreign)); await expect(other.make().cas(null, { ...value, store: foreign })).rejects.toThrow();
  });
  it("validates every indexed run and reference including records retention would expire", async () => {
    const { make } = fixture(); const value = candidate([run("101"), run("102")]); const invalid = run("101"); invalid.source.repositoryId = "1";
    value.files.set("data/v1/runs/101-a1/run.json", canonicalBytes(invalid)); value.runs.set("101-a1", invalid);
    await expect(make().cas(null, value)).rejects.toThrow(); expect((await make().read()).tip).toBeNull();
    await expect(make().cas(null, candidate([run("101", true), run("102")]))).rejects.toThrow("store-graph-invalid"); expect((await make().read()).tip).toBeNull();
  });
  it("never rewrites immutable run records and returns only fixed errors for hostile paths", async () => {
    const { make } = fixture(); const adapter = make(); const stored = await adapter.cas(null, candidate([run()]));
    if (stored.status !== "accepted") throw new Error("fixture write failed");
    const changed = run(); changed.claims = {}; await expect(adapter.cas(stored.tip, candidate([changed]))).rejects.toThrow("immutable-file");
    const snapshot = await adapter.read(); const canary = "fake-canary-token";
    await expect(snapshot.readFile(`../${canary}`)).rejects.toThrow("store-file-missing");
    try { await snapshot.readFile(`https://signed.invalid/file?token=${canary}`); } catch (error) { expect(String(error)).not.toContain(canary); expect(String(error)).not.toContain("signed.invalid"); }
  });
  it("rejects recomputation that omits the accepted run before CAS", async () => {
    const { make } = fixture(); const adapter = make(); let writes = 0;
    await expect(writeRun({ read: () => adapter.read(), cas: (tip, value) => { writes++; return adapter.cas(tip, value); } }, { run: run(), blobs: new Map() }, {
      metadata: METADATA, delay: () => Promise.resolve(), jitter: () => 0, recompute: () => Promise.resolve(candidate()),
    })).rejects.toThrow("accepted-run-changed");
    expect(writes).toBe(0); expect((await adapter.read()).tip).toBeNull();
  });
  it("rejects recomputation that replaces the accepted run before CAS", async () => {
    const { make } = fixture(); const adapter = make(); let writes = 0; const changed = run(); changed.claims = {};
    await expect(writeRun({ read: () => adapter.read(), cas: (tip, value) => { writes++; return adapter.cas(tip, value); } }, { run: run(), blobs: new Map() }, {
      metadata: METADATA, delay: () => Promise.resolve(), jitter: () => 0, recompute: () => Promise.resolve(candidate([changed])),
    })).rejects.toThrow("accepted-run-changed");
    expect(writes).toBe(0); expect((await adapter.read()).tip).toBeNull();
  });
  it("refuses grace namespaces before local CAS until maintenance metadata is supported", async () => {
    const { make } = fixture(); const adapter = make(); const value = candidate();
    value.files.set("data/v2/runs/101-a1/run.json", canonicalBytes(run()));
    await expect(adapter.cas(null, value)).rejects.toThrow("store-path-refused"); expect((await adapter.read()).tip).toBeNull();
  });
  it("freezes CAS candidate bytes and paths before asynchronous validation", async () => {
    const { make, scratch } = fixture(); const adapter = make(); const value = candidate(); const expected = Buffer.from(value.files.get("store.json") ?? []);
    const pending = adapter.cas(null, value);
    queueMicrotask(() => { value.files.set("../../../escaped.txt", new TextEncoder().encode("fake-canary-token")); });
    expect((await pending).status).toBe("accepted"); expect(existsSync(join(scratch.root, "escaped.txt"))).toBe(false); expect(await (await adapter.read()).readFile("store.json")).toEqual(expected);
  });
  it("freezes CAS candidate byte contents before asynchronous validation", async () => {
    const { make } = fixture(); const adapter = make(); const value = candidate(); const expected = Buffer.from(value.files.get("store.json") ?? []);
    const pending = adapter.cas(null, value); queueMicrotask(() => { value.files.get("store.json")?.fill(1); });
    expect((await pending).status).toBe("accepted"); expect(await (await adapter.read()).readFile("store.json")).toEqual(expected);
  });
  it("recomputation cannot mutate the accepted run after validation and checkpoints", async () => {
    const { make } = fixture(); const adapter = make(); let retained: ReturnType<typeof candidate> | undefined; const accepted = run();
    const result = await writeRun(adapter, { run: accepted, blobs: new Map() }, {
      metadata: METADATA, delay: () => Promise.resolve(), jitter: () => 0,
      recompute: (_snapshot, value) => { retained = value as ReturnType<typeof candidate>; return Promise.resolve(value); },
      checkpoint: (event) => { if (event.point === "before-cas") { const changed = run(); changed.claims = {}; retained?.runs.set(changed.runKey, changed); retained?.files.set(`data/v1/runs/${changed.runKey}/run.json`, canonicalBytes(changed)); } return Promise.resolve(); },
    });
    expect(result.run).toEqual(accepted); expect((await adapter.read()).runs.get(accepted.runKey)).toEqual(accepted);
  });
  it("keeps the original injected timestamp across conflicts and caller mutation", async () => {
    const { make } = fixture(); const adapter = make(); const metadata = { ...METADATA }; const seen: string[] = [];
    await writeRun({ read: () => adapter.read(), cas: (tip, value) => { seen.push(value.metadata.timestamp); return seen.length === 1 ? Promise.resolve({ status: "conflict" }) : adapter.cas(tip, value); } }, { run: run(), blobs: new Map() }, {
      metadata, jitter: () => 0, delay: () => { metadata.timestamp = "2001-01-01T00:00:00Z"; return Promise.resolve(); },
    });
    expect(seen).toEqual([METADATA.timestamp, METADATA.timestamp]);
  });
  it("rejects recomputation that changes the accepted timestamp before CAS", async () => {
    const { make } = fixture(); const adapter = make(); let writes = 0;
    await expect(writeRun({ read: () => adapter.read(), cas: (tip, value) => { writes++; return adapter.cas(tip, value); } }, { run: run(), blobs: new Map() }, {
      metadata: METADATA, jitter: () => 0, delay: () => Promise.resolve(), recompute: (_snapshot, value) => Promise.resolve({ ...value, metadata: { timestamp: "2001-01-01T00:00:00Z" } }),
    })).rejects.toThrow("accepted-metadata-changed"); expect(writes).toBe(0);
  });
});

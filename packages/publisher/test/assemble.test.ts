import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addRun, appScriptPath, blobPath, changesPath, encodePng, generationId, newStore, permalinkPath, pixelHash, projectChanges, projectSite, PROJECTION_VERSION, runRecordPath, siteLocation, siteUrls } from "@pixelwatch/core";
import { canonicalBytes, parseDocument, type Config, type Run } from "@pixelwatch/schemas";
import type { StoreSnapshot } from "@pixelwatch/store";
import { buildViewerAssets } from "../../../tools/viewer/build.ts";
import { GOLDEN_RUNS, goldenInput } from "../../../tools/projection-goldens/generate.ts";
import { renderEntry } from "../../viewer/src/entry.ts";
import { assembleSite } from "../src/assemble.ts";
import { PublisherError, type AssemblyInput } from "../src/types.ts";

const oid = (value: string) => value.repeat(40);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CANARY = "FAKE_ASSEMBLY_TOKEN_67d31";
const SIGNED = "https://signed.invalid/pool?sig=FAKE_ASSEMBLY_SIGNED_98e";
function required<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error("missing fixture value"); return value; }
let script: Uint8Array;
beforeAll(async () => { script = (await buildViewerAssets("0.1.0-rc.1")).script; });
afterAll(() => vi.restoreAllMocks());
function fixture(): { input: AssemblyInput; files: Map<string, Uint8Array>; reads: string[]; run: Run; png: Uint8Array; blob: string } {
  const parsed = parseDocument("run", readFileSync(new URL("../../../testdata/schemas/run/valid/initial-commit-no-baseline.json", import.meta.url)));
  if (!parsed.ok) throw new Error("invalid committed run fixture");
  const run = parsed.value;
  const pixels = { width: 4, height: 4, channels: 3 as const, data: new Uint8Array(48).fill(125) };
  const png = encodePng(pixels); const pixel = pixelHash(pixels); const blob = blobPath(pixel);
  required(run.results[0]).head = { state: "captured", pixelHash: pixel, width: 4, height: 4 };
  const store = addRun(newStore(run.source.repositoryId), run).store;
  const files = new Map([["store.json", canonicalBytes(store)], [runRecordPath(run.runKey), canonicalBytes(run)], [blob, png]]);
  const reads: string[] = [];
  const snapshot: StoreSnapshot = { tip: oid("5"), store, runs: new Map([[run.runKey, run]]), files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength })),
    readFile: (path) => { reads.push(path); const bytes = files.get(path); if (bytes === undefined) throw new Error(`${CANARY} ${SIGNED}`); return Promise.resolve(bytes); } };
  const config: Config = { schemaVersion: 1, source: { workflowIds: ["123456"], events: ["pull_request", "push"] }, providers: [{ id: "fixture", shards: 1 }] };
  return { input: { snapshot, config, configCommit: oid("3"), pages: { url: "https://owner.github.io/repo/", host: "owner.github.io" }, repository: { repositoryId: run.source.repositoryId, owner: "owner", name: "repo" }, assets: { release: "0.1.0-rc.1", releaseCommit: oid("4"), script } }, files, reads, run, png, blob };
}
function refresh(world: ReturnType<typeof fixture>): void {
  world.files.set("store.json", canonicalBytes(world.input.snapshot.store));
  for (const [key, run] of world.input.snapshot.runs) world.files.set(runRecordPath(key), canonicalBytes(run));
  (world.input.snapshot as { files: StoreSnapshot["files"] }).files = [...world.files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength }));
}
async function refusal(input: AssemblyInput, code?: string): Promise<PublisherError> {
  let error: unknown; try { await assembleSite(input); } catch (value) { error = value; }
  expect(error).toBeInstanceOf(PublisherError); if (code !== undefined) expect((error as PublisherError).code).toBe(code);
  const raw = String(error) + JSON.stringify(error) + ((error as Error).stack ?? "");
  expect(raw).not.toContain(CANARY); expect(raw).not.toContain(SIGNED); expect((error as Error).cause).toBeUndefined();
  return error as PublisherError;
}
describe("complete final site assembly", () => {
  it("assembles the complete allowlisted served tree from real projection final app and entry bytes", async () => {
    const w = fixture(); const site = await assembleSite(w.input); const urls = siteUrls(siteLocation(w.input.config, w.input.pages));
    const generation = generationId({ storeTip: required(w.input.snapshot.tip), releaseCommit: oid("4"), configCommit: oid("3"), projectionVersion: PROJECTION_VERSION });
    const expected = new Map(projectSite({ config: w.input.config, pages: w.input.pages, store: w.input.snapshot.store, runs: w.input.snapshot.runs, generation, release: w.input.assets.release }).map((file) => [file.path, file.bytes]));
    expected.set(appScriptPath(w.input.assets.release), script); expected.set("index.html", renderEntry({ urls, repository: w.input.repository, assets: w.input.assets }));
    expected.set(permalinkPath(w.run.runKey), renderEntry({ urls, repository: w.input.repository, assets: w.input.assets, changes: projectChanges(w.run, urls) }));
    expected.set(runRecordPath(w.run.runKey), canonicalBytes(w.run)); expected.set(w.blob, w.png);
    expect(site.generation).toBe(generation); expect(site.storeTip).toBe(oid("5")); expect(site.configCommit).toBe(oid("3")); expect(site.releaseCommit).toBe(oid("4"));
    expect(site.files.map((file) => file.path)).toEqual([...expected.keys()].sort());
    for (const file of site.files) { expect(Buffer.from(file.bytes)).toEqual(Buffer.from(required(expected.get(file.path)))); expect(file.sha256).toBe(hash(file.bytes)); }
    expect(site.files.some((file) => file.path === "store.json")).toBe(false); expect(w.reads).not.toContain("store.json");
    const text = new TextDecoder().decode(required(site.files.find((file) => file.path === permalinkPath(w.run.runKey))).bytes);
    expect(text).toContain("<meta http-equiv=\"Content-Security-Policy\""); expect(text).toContain(`integrity="sha256-${createHash("sha256").update(script).digest("base64")}"`);
    expect(required(site.files.find((file) => file.path === appScriptPath(w.input.assets.release))).immutable).toBe(true);
    expect(required(site.files.find((file) => file.path === permalinkPath(w.run.runKey))).immutable).toBe(false);
  });
  it("preserves recorded changes@1 bytes and accepted run bytes without rewriting goldens", async () => {
    const w = fixture(); const source = goldenInput(); const runs = new Map(Object.values(GOLDEN_RUNS).map((run) => [run.runKey, structuredClone(run)]));
    const pool = new Map<string, Uint8Array>();
    // Structural stand-ins deliberately cannot corroborate these historical pixel hashes:
    // ADR0010 forbids decoding or rehashing publisher-owned existing blobs during projection.
    for (const run of runs.values()) for (const result of run.results) for (const side of [result.base, result.head]) if (side.state === "captured") pool.set(blobPath(side.pixelHash), w.png);
    const files = new Map([["store.json", canonicalBytes(source.store)], ...[...runs].map(([key, run]): [string, Uint8Array] => [runRecordPath(key), canonicalBytes(run)]), ...pool]);
    const input: AssemblyInput = { ...w.input, config: source.config, pages: source.pages, snapshot: { tip: oid("5"), store: source.store, runs, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.byteLength })), readFile: (path) => Promise.resolve(required(files.get(path))) } };
    const site = await assembleSite(input);
    for (const run of runs.values()) {
      expect(Buffer.from(required(site.files.find((file) => file.path === changesPath(run.runKey))).bytes)).toEqual(readFileSync(new URL(`../../../testdata/projection/site/${changesPath(run.runKey)}`, import.meta.url)));
      expect(Buffer.from(required(site.files.find((file) => file.path === runRecordPath(run.runKey))).bytes)).toEqual(Buffer.from(required(files.get(runRecordPath(run.runKey)))));
    }
  });
  it("derives sorted identical bytes and hashes independently of input map and listing order", async () => {
    const a = fixture(); const b = fixture(); (b.input.snapshot as {files: StoreSnapshot["files"]}).files = [...b.input.snapshot.files].reverse();
    expect(await assembleSite(a.input)).toEqual(await assembleSite(b.input)); expect(await assembleSite(a.input)).toEqual(await assembleSite(a.input));
  });
  it("applies the validated prefix exactly once for root project and nested Pages sites", async () => {
    for (const [url, prefix] of [["https://owner.github.io/", "pixelwatch"], ["https://owner.github.io/repo/", "pixelwatch"], ["https://owner.github.io/repo/", "reports/nested/visual"]] as const) {
      const w = fixture(); w.input.config.store = { prefix }; const input = { ...w.input, pages: { url, host: "owner.github.io" } }; const site = await assembleSite(input);
      expect(site.urls.base).toBe(`${url}${prefix}/`); expect(site.files.every((file) => !file.path.startsWith(`${prefix}/`))).toBe(true);
      const entry = new TextDecoder().decode(required(site.files.find((file) => file.path === permalinkPath(w.run.runKey))).bytes);
      expect(entry).toContain(`data-pw-site="${url}${prefix}/"`); expect(entry).toContain(`src="../../${appScriptPath(input.assets.release)}"`);
    }
  });
  it("refuses unknown config store and indexed run versions before any stored byte read", async () => {
    for (const part of ["config", "store", "run"] as const) {
      const w = fixture(); const target = part === "config" ? w.input.config : part === "store" ? w.input.snapshot.store : w.run;
      (target as {schemaVersion: number}).schemaVersion = 2; await refusal(w.input); expect(w.reads).toEqual([]);
    }
    const w = fixture(); (w.input.snapshot.store as {dataVersion: number}).dataVersion = 2; await refusal(w.input); expect(w.reads).toEqual([]);
  });
  it("refuses repository OID release and Pages authority mismatches before stored reads", async () => {
    const mutations: ((input: AssemblyInput) => AssemblyInput)[] = [
      (input) => ({ ...input, repository: { ...input.repository, repositoryId: "123" } }),
      (input) => ({ ...input, repository: { ...input.repository, owner: `../${CANARY}` } }),
      (input) => ({ ...input, repository: { ...input.repository, name: "../repo" } }),
      (input) => ({ ...input, configCommit: CANARY }), (input) => ({ ...input, assets: { ...input.assets, releaseCommit: SIGNED } }),
      (input) => ({ ...input, assets: { ...input.assets, release: "../app" } }), (input) => ({ ...input, assets: { ...input.assets, script: new Uint8Array() } }),
      (input) => ({ ...input, pages: { url: SIGNED, host: "owner.github.io" } }),
      (input) => ({ ...input, snapshot: { ...input.snapshot, tip: null } }), (input) => ({ ...input, snapshot: { ...input.snapshot, tip: "5" } }),
    ];
    for (const mutation of mutations) { const w = fixture(); await refusal(mutation(w.input)); expect(w.reads).toEqual([]); }
  });
  it("validates missing unindexed duplicate and expired malformed graph paths before selection", async () => {
    const mutations: ((w: ReturnType<typeof fixture>) => void)[] = [
      (w) => { w.files.delete(w.blob); refresh(w); },
      (w) => { w.files.delete(runRecordPath(w.run.runKey)); refresh(w); w.files.delete(runRecordPath(w.run.runKey)); (w.input.snapshot as {files: StoreSnapshot["files"]}).files = [...w.files].map(([path, bytes]) => ({path, bytes: bytes.byteLength})); },
      (w) => { w.files.set(runRecordPath("42-a1"), canonicalBytes(w.run)); refresh(w); },
      (w) => { (w.input.snapshot as {files: StoreSnapshot["files"]}).files = [...w.input.snapshot.files, required(w.input.snapshot.files[0])]; },
      (w) => { w.input.config.retention = { mainRuns: 1 }; const newer = structuredClone(w.run); newer.runKey = "6-a1"; newer.source.runId = "6"; newer.source.createdAt = "2026-10-03T00:00:00Z"; const store = addRun(w.input.snapshot.store, newer).store; (w.input.snapshot as {store: StoreSnapshot["store"]}).store = store; (w.input.snapshot.runs as Map<string,Run>).set(newer.runKey, newer); (w.run.versions as {comparator:number}).comparator = 2; refresh(w); },
    ];
    for (const mutation of mutations) { const w = fixture(); mutation(w); await refusal(w.input); expect(w.reads).toEqual([]); }
  });
  it("never copies store ownership metadata orphan blobs or active and old release files", async () => {
    const w = fixture(); const orphan = blobPath("f".repeat(64)); w.files.set(orphan, w.png); refresh(w);
    const site = await assembleSite(w.input); expect(site.files.some((file) => file.path === orphan || file.path === "store.json")).toBe(false); expect(w.reads).not.toContain(orphan);
    for (const path of ["index.html", "danger.svg", "style.css", "app/0.0.1/app.js", "data/v1/runs/5-a1/active.js", "../escape.json", "data/v2/run.json"]) {
      const bad = fixture(); bad.files.set(path, new TextEncoder().encode(CANARY)); refresh(bad); await refusal(bad.input); expect(bad.reads).toEqual([]);
    }
  });
  it("privately captures config records listing targets reader and app before asynchronous reads", async () => {
    const w = fixture(); const baseline = await assembleSite(fixture().input); const captured = new Map([...w.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
    const assets = { ...w.input.assets, script: Uint8Array.from(script) }; const input: AssemblyInput = { ...w.input, assets };
    const originalRead = async (path: string): Promise<Uint8Array> => {
      w.input.config.store = { prefix: "foreign" }; w.run.source.configSha = oid("9"); (input.repository as {owner:string}).owner = "evil";
      (input.pages as {url:string}).url = SIGNED; (assets as {releaseCommit:string}).releaseCommit = CANARY; assets.script.fill(0);
      (input.snapshot as {tip:string|null}).tip = oid("8"); (input.snapshot as {files:StoreSnapshot["files"]}).files = [];
      (input.snapshot.runs as Map<string,Run>).clear(); (input.snapshot as {readFile: StoreSnapshot["readFile"]}).readFile = () => { throw new Error(CANARY); };
      await Promise.resolve(); return required(captured.get(path));
    };
    (input.snapshot as {readFile:StoreSnapshot["readFile"]}).readFile = originalRead;
    expect(await assembleSite(input)).toEqual(baseline);
  });
  it("captures each returned stored byte array before a later read can mutate it", async () => {
    const w = fixture(); const before = Uint8Array.from(required(w.files.get(runRecordPath(w.run.runKey)))); let previous: Uint8Array | undefined;
    const readFile = (path: string) => { previous?.fill(0); const current = Uint8Array.from(required(w.files.get(path))); previous = current; return Promise.resolve(current); };
    const site = await assembleSite({ ...w.input, snapshot: { ...w.input.snapshot, readFile } }); previous?.fill(0);
    expect(required(site.files.find((file) => file.path === runRecordPath(w.run.runKey))).bytes).toEqual(before); expect(required(site.files.find((file) => file.path === w.blob)).bytes).toEqual(w.png);
    for (const file of site.files) expect(file.sha256).toBe(hash(file.bytes));
  });
  it("refuses changed sizes same size run records malformed PNGs and derived byte hash changes", async () => {
    const record = fixture(); const path = runRecordPath(record.run.runKey); record.files.set(path, new TextEncoder().encode(new TextDecoder().decode(required(record.files.get(path))).replace("home", "evil")));
    await refusal(record.input);
    const size = fixture(); size.files.set(size.blob, Uint8Array.from([...size.png, 1])); await refusal(size.input);
    const badPng = fixture(); const bytes = Uint8Array.from(badPng.png); bytes[0] = 0; badPng.files.set(badPng.blob, bytes); await refusal(badPng.input);
    const derived = fixture(); const old = `derived/${hash(derived.png).slice(0,2)}/${hash(derived.png)}.png`; const other = encodePng({ width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(126) }); derived.files.set(old, other); refresh(derived); await refusal(derived.input);
  });
  it("counts every exact category and shared pool once while preserving immutable PNG reuse", async () => {
    const w = fixture(); const second = structuredClone(w.run); second.runKey = "6-a1"; second.source.runId = "6"; second.source.createdAt = "2026-10-03T00:00:00Z";
    (w.input.snapshot as {store:StoreSnapshot["store"]}).store = addRun(w.input.snapshot.store, second).store; (w.input.snapshot.runs as Map<string,Run>).set(second.runKey, second);
    const derived = `derived/${hash(w.png).slice(0,2)}/${hash(w.png)}.png`; w.files.set(derived, w.png); refresh(w);
    const site = await assembleSite(w.input); expect(site.files.filter((file) => file.path === w.blob)).toHaveLength(1); expect(required(site.files.find((file) => file.path === derived)).bytes).toEqual(w.png);
    expect(site.totalBytes).toBe(site.files.reduce((sum,file) => sum + file.bytes.byteLength,0));
    for (const category of ["html","app","api","stubs","data","blobs","derived","grace"] as const) expect(site.breakdown[category]).toBe(site.files.filter((file) => file.category === category).reduce((sum,file) => sum + file.bytes.byteLength,0));
    expect(site.breakdown.blobs).toBe(w.png.byteLength); expect(site.breakdown.derived).toBe(w.png.byteLength); expect(site.breakdown.app).toBe(script.byteLength);
    expect(required(site.files.find((file) => file.path === w.blob)).immutable).toBe(true); expect(required(site.files.find((file) => file.path === derived)).immutable).toBe(true);
  });
  it("reports soft overage and refuses hard overage before stored reads without mutating data", async () => {
    // config@1 permits budgets >=1MiB. Pad only the trusted app input with JS whitespace
    // to exercise exact boundary accounting without changing the production schema/budget.
    const budgetFixture = () => { const world = fixture(); const padded = new Uint8Array(1024*1024).fill(32); padded.set(script); world.input = {...world.input, assets:{...world.input.assets,script:padded}}; return world; };
    const baseline = await assembleSite(budgetFixture().input); const soft = budgetFixture(); soft.input.config.limits = { softBytes: 1024*1024, hardBytes: baseline.totalBytes };
    expect((await assembleSite(soft.input)).overSoftLimit).toBe(true);
    const hard = budgetFixture(); hard.input.config.limits = { softBytes: 1024*1024, hardBytes: baseline.totalBytes - 1 }; const before = canonicalBytes(hard.input.snapshot.store);
    await refusal(hard.input); expect(hard.reads).toEqual([]); expect(canonicalBytes(hard.input.snapshot.store)).toEqual(before);
    const configurable = budgetFixture(); configurable.input.config.limits = { softBytes: 500 * 1024 * 1024, hardBytes: 1024 * 1024 * 1024 }; expect((await assembleSite(configurable.input)).totalBytes).toBe(baseline.totalBytes);
  });
  it("refuses oversized generated JSON instead of emitting data the final viewer cannot read", async () => {
    const w = fixture(); const original = required(w.run.results[0]); w.run.results = Array.from({length:1400}, (_,i) => ({ ...structuredClone(original), viewId: `v${String(i).padStart(4,"0")}` }));
    w.run.counts.incomparable = 1400; w.run.coverage.declaredUnits = 1400; w.run.coverage.accountedUnits = 1400; refresh(w);
    const pages = { url: `https://owner.github.io/${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/${"d".repeat(100)}/${"e".repeat(100)}/`, host:"owner.github.io" };
    expect(canonicalBytes(w.run).byteLength).toBeLessThanOrEqual(1024*1024); expect(canonicalBytes(projectChanges(w.run, siteUrls(siteLocation(w.input.config,pages)))).byteLength).toBeGreaterThan(1024*1024);
    await refusal({...w.input,pages}); expect(w.reads).toEqual([]);
  });
  it("uses no ambient network credentials clock or randomness and leaks no raw reader error", async () => {
    const w = fixture(); const previous = process.env; const clock = vi.spyOn(Date,"now").mockImplementation(() => {throw new Error("ambient-clock");}); const random = vi.spyOn(Math,"random").mockImplementation(() => {throw new Error("ambient-random");});
    process.env = new Proxy(previous,{get(target,key): unknown { if(key === "GH_TOKEN" || key === "GITHUB_TOKEN") throw new Error("credential-read"); return Reflect.get(target,key) as unknown; }});
    try { const site = await assembleSite(w.input); const raw = JSON.stringify(site); expect(raw).not.toContain(CANARY); expect(raw).not.toContain(SIGNED); }
    finally {process.env = previous; clock.mockRestore(); random.mockRestore();}
    const bad = fixture(); await refusal({...bad.input,snapshot:{...bad.input.snapshot,readFile:()=>Promise.reject(new Error(`${CANARY} ${SIGNED}`))}});
  });
  it("renders a marked empty store home but never invents provenance for an absent store", async () => {
    const w = fixture(); const store = newStore(w.input.repository.repositoryId); const snapshot = {...w.input.snapshot,store,runs:new Map(),files:[{path:"store.json",bytes:canonicalBytes(store).byteLength}]};
    const site = await assembleSite({...w.input,snapshot}); expect(site.files.some((file)=>file.path === "index.html")).toBe(true); expect(site.files.some((file)=>file.path.startsWith("runs/"))).toBe(false); expect(w.reads).toEqual([]);
    await refusal({...w.input,snapshot:{...snapshot,tip:null,files:[]}});
  });
  it("copies native typed-array bytes without invoking caller iterators or understating assembled budgets", async () => {
    const w = fixture(); const canonical = Uint8Array.from(w.png);
    const larger = encodePng({ width:4,height:4,channels:3,data:Uint8Array.from({length:48},(_,index)=>(index*37)%256) });
    expect(larger.byteLength).toBeGreaterThan(canonical.byteLength);
    let iterators = 0; let getters = 0;
    Object.defineProperty(canonical,Symbol.iterator,{value:function*(){iterators++;yield* larger;}});w.files.set(w.blob,canonical);
    const site = await assembleSite(w.input);
    expect(iterators).toBe(0);expect(Buffer.from(required(site.files.find(file=>file.path===w.blob)).bytes)).toEqual(Buffer.from(w.png));
    expect(site.totalBytes).toBe(site.files.reduce((sum,file)=>sum+file.bytes.byteLength,0));
    const assets = { ...w.input.assets, script:Uint8Array.from(script) };
    Object.defineProperty(assets.script,Symbol.iterator,{value:()=>{iterators++;throw new Error(CANARY);}});
    Object.defineProperty(assets.script,"byteLength",{get:()=>{getters++;throw new Error(CANARY);}});
    const native = await assembleSite({...fixture().input,assets});
    expect(iterators).toBe(0);expect(getters).toBe(0);expect(Buffer.from(required(native.files.find(file=>file.path===appScriptPath(assets.release))).bytes)).toEqual(Buffer.from(script));
    const returned = fixture(); const pixels = Uint8Array.from(returned.png);Object.defineProperty(pixels,"byteLength",{get:()=>{getters++;throw new Error(CANARY);}});returned.files.set(returned.blob,pixels);
    expect((await assembleSite(returned.input)).totalBytes).toBe(native.totalBytes);expect(getters).toBe(0);
  });
  it("assembly treats snapshot derived references as unknown and retains every valid derived root", async () => {
    const w = fixture(); const derived=`derived/${hash(w.png).slice(0,2)}/${hash(w.png)}.png`;w.files.set(derived,w.png);refresh(w);
    Object.assign(w.input.snapshot,{derived:new Map([[w.run.runKey,[]]])});
    const site=await assembleSite(w.input);expect(Buffer.from(required(site.files.find(file=>file.path===derived)).bytes)).toEqual(Buffer.from(w.png));expect(site.breakdown.derived).toBe(w.png.byteLength);
    Object.defineProperty(w.input.snapshot,"derived",{get:()=>{throw new Error(CANARY);}});
    expect(await assembleSite(w.input)).toEqual(site);
  });
  it("copies native trusted script bytes without invoking caller iterators or getters", async () => {
    const w=fixture();let touched=0;const assets={...w.input.assets,script:Uint8Array.from(script)};
    Object.defineProperty(assets.script,Symbol.iterator,{value:()=>{touched++;throw new Error(CANARY);}});
    Object.defineProperty(assets.script,"byteLength",{get:()=>{touched++;throw new Error(CANARY);}});
    const site=await assembleSite({...w.input,assets});expect(touched).toBe(0);expect(Buffer.from(required(site.files.find(file=>file.path===appScriptPath(assets.release))).bytes)).toEqual(Buffer.from(script));
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes, parseDocument, type Run } from "@pixelwatch/schemas";
import { addRun, blobPath, encodePng, newStore, pixelHash, runRecordPath } from "@pixelwatch/core";
import { GitBranchStore, LocalDirStore, writeRun, type StoreAdapter, type StoreCandidate, type StoreSnapshot, type GitCheckpoint, type StoreTiming } from "@pixelwatch/store";
import { Scratch } from "../../store/test/helpers.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { Clock, Scheduler, checkpoint } from "../../../tools/simulation/schedule.ts";
import { admitRun } from "../src/admission.ts";
import { PublisherError, type AdmissionDependencies, type PublisherContext } from "../src/types.ts";

const REPOSITORY = "987654321"; const ORIGINAL_TIME = "2000-01-01T00:00:00Z";
// ADR 0015 deterministic-test timeout allowance: fixed fixtures, at most five CAS attempts,
// injected scheduling/timing and each native Git subprocess has its own bounded watchdog.
const scratches: Scratch[] = []; const clients: GitBranchStore[] = []; const raw: string[] = [];
const deadlines: string[][] = [];
afterEach(() => {
  try {assertNoSecrets(raw.splice(0)); for (const events of deadlines.splice(0)) {expect(events.filter((event) => event === "deadline").length).toBeGreaterThan(0); expect(events.filter((event) => event === "deadline").length).toBe(events.filter((event) => event === "disposed").length);}}
  finally {for (const client of clients.splice(0)) client.close(); for (const scratch of scratches.splice(0)) scratch.close();}
});
function context(): PublisherContext {
  return {config: {schemaVersion: 1, source: {workflowIds: ["123456"], events: ["push", "pull_request"]}, providers: [{id: "fixture", shards: 1}], retention: {mainRuns: 2, runsPerPr: 1, prStreams: 1}},
    configCommit: "3".repeat(40), pages: {url: "https://owner.github.io/repo/", host: "owner.github.io"}, repository: {repositoryId: REPOSITORY, owner: "owner", name: "repo"}, assets: {release: "0.1.0-rc.1", releaseCommit: "4".repeat(40), script: new TextEncoder().encode("globalThis.__trustedPixelWatch = true;")} };
}
function input(id: number, captured = false) {
  const parsed = parseDocument("run", readFileSync(new URL(`../../../testdata/schemas/run/valid/${captured ? "initial-commit-no-baseline" : "no-usable-artifact"}.json`, import.meta.url)));
  if (!parsed.ok) throw new Error("admission-fixture-invalid");
  const run: Run = {...parsed.value, runKey: `${String(id)}-a1`, source: {...parsed.value.source, runId: String(id), createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString().replace(".000Z", "Z")}};
  const blobs = new Map<string, Uint8Array>();
  if (captured) {
    const image = {width: 2, height: 2, channels: 3 as const, data: Uint8Array.from([id, 0, 1, id, 1, 2, id, 2, 3, id, 3, 4])}; const hash = pixelHash(image);
    const result = run.results[0]; if (result?.head.state !== "captured") throw new Error("admission-fixture-side-invalid");
    result.head = {state: "captured", pixelHash: hash, width: 2, height: 2}; blobs.set(blobPath(hash), encodePng(image));
  } return {run, blobs};
}
function candidate(values: readonly ReturnType<typeof input>[]): StoreCandidate {
  let store = newStore(REPOSITORY); const files = new Map<string, Uint8Array>(); const runs = new Map<string, Run>();
  for (const value of values) { store = addRun(store, value.run).store; runs.set(value.run.runKey, value.run); files.set(runRecordPath(value.run.runKey), canonicalBytes(value.run)); for (const [path, bytes] of value.blobs) files.set(path, bytes); }
  files.set("store.json", canonicalBytes(store)); return {store, runs, files, metadata: {timestamp: ORIGINAL_TIME}};
}
function dependencies(): AdmissionDependencies & {delays: number[]; clock: Clock} {
  const clock = new Clock(); const delays: number[] = []; const scheduler = new Scheduler(42, 4); let jitter = 0;
  scheduler.add("writer", function* () {yield checkpoint("jitter", () => {jitter = scheduler.seed;});}); scheduler.run();
  return {context: context(), now: ORIGINAL_TIME, metadata: {timestamp: ORIGINAL_TIME}, prStates: new Map(), pins: new Set(), clock, delays,
    delay: (milliseconds) => {delays.push(milliseconds); clock.advance(milliseconds); return Promise.resolve();}, jitter: () => jitter};
}
function fixture(kind: "local" | "git", hook?: (event: GitCheckpoint) => Promise<void>) {
  const scratch = new Scratch(); scratches.push(scratch); const timingEvents: string[] = [];
  if (kind === "git") deadlines.push(timingEvents);
  const timing: StoreTiming = {deadline: (milliseconds) => {expect(milliseconds).toBe(60_000); timingEvents.push("deadline"); return {signal: new AbortController().signal, dispose: () => {timingEvents.push("disposed");}};}};
  const make = () => { if (kind === "local") return new LocalDirStore({directory: join(scratch.root, "local"), repositoryId: REPOSITORY, defaultBranch: "main"});
    const adapter = new GitBranchStore({remote: scratch.remote, repositoryId: REPOSITORY, defaultBranch: "main", testRemote: {root: scratch.root}, timing, ...(hook === undefined ? {} : {checkpoint: hook})}); clients.push(adapter); return adapter; };
  const adapter = make();
  const seed = async (values: readonly ReturnType<typeof input>[]) => {expect((await adapter.cas(null, candidate(values))).status).toBe("accepted");};
  return {adapter, make, scratch, seed, timingEvents};
}
async function files(snapshot: StoreSnapshot): Promise<Map<string, Uint8Array>> {const result = new Map<string, Uint8Array>(); for (const file of snapshot.files) {const bytes = await snapshot.readFile(file.path); assertNoSecrets([bytes]); result.set(file.path, Uint8Array.from(bytes));} return result;}
async function admission(...args: Parameters<typeof admitRun>): ReturnType<typeof admitRun> {const result = await admitRun(...args); const serialized = JSON.stringify(result); raw.push(serialized); assertNoSecrets([serialized]); return result;}
async function failure(operation: Promise<unknown>, code?: string): Promise<void> {
  let caught: unknown; try {await operation;} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(PublisherError); const value = caught as PublisherError; raw.push(`${value.name}: ${value.message}\n${value.stack ?? ""}`); assertNoSecrets(raw);
  if (code !== undefined) expect(value.code).toBe(code); expect(value.cause).toBeUndefined();
}
describe.each(["local", "git"] as const)("controlled admission with actual %s CAS", (kind) => {
  it("admits a retained run with unchanged canonical bytes", async () => {
    const f = fixture(kind); const value = input(3, true); const expected = canonicalBytes(value.run); const result = await admission(f.adapter, value, dependencies()); raw.push(JSON.stringify(result));
    expect(result.status).toBe("stored"); if (result.status !== "stored") throw new Error("expected retained input"); expect(result.added).toBe(true); expect(result.attempts).toBe(1);
    const stored = await f.adapter.read(); expect(stored.tip).toBe(result.tip); expect(await stored.readFile(runRecordPath(value.run.runKey))).toEqual(expected);
    for (const [path, bytes] of value.blobs) expect(Uint8Array.from(await stored.readFile(path))).toEqual(bytes); await files(stored);
  }, 0);
  it("expires a late incoming run only through the production retention plan", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); const before = await f.adapter.read(); const result = await admission(f.adapter, input(1, true), dependencies()); raw.push(JSON.stringify(result));
    expect(result).toMatchObject({status: "expired", runKey: "1-a1", reason: "main-limit", attempts: 1}); const after = await f.adapter.read(); expect(after.tip).toBe(result.tip); expect(after.tip).not.toBe(before.tip);
    expect(after.store.runs.map((run) => run.runKey)).toEqual(["2-a1", "3-a1"]); expect(after.store.txn).toBe(before.store.txn + 2); expect(after.files.map((file) => file.path)).not.toContain(runRecordPath("1-a1")); expect(after.files.some((file) => file.path.startsWith("blobs/"))).toBe(false); await files(after);
  }, 0);
  it("validates malformed incoming and expired indexed data before housekeeping or mutation", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); const before = await f.adapter.read(); let mutations = 0;
    const observed: StoreAdapter = {read: () => f.adapter.read(), cas: (...args) => {mutations++; return f.adapter.cas(...args);}};
    for (const mutate of [(value: ReturnType<typeof input>) => {Object.assign(value.run, {schemaVersion: 2});}, (value: ReturnType<typeof input>) => {value.blobs.set(`blobs/aa/${"a".repeat(64)}.png`, new TextEncoder().encode(`${CANARY_TOKEN} ${SIGNED_URL}`));}, (value: ReturnType<typeof input>) => {value.blobs.set("../evil.js", new TextEncoder().encode(CANARY_TOKEN));}]) {
      const value = input(1); mutate(value); await failure(admission(observed, value, dependencies()));
    }
    const invalid = structuredClone(before.store); Object.assign(invalid, {dataVersion: 2}); const poisoned: StoreAdapter = {read: () => Promise.resolve({...before, store: invalid}), cas: (...args) => observed.cas(...args)}; await failure(admission(poisoned, input(1), dependencies()));
    const badRun = structuredClone(before.runs.get("2-a1")); if (badRun === undefined) throw new Error("missing fixture record"); badRun.source.repositoryId = "1";
    await failure(admission({read: () => Promise.resolve({...before, runs: new Map([...before.runs, ["2-a1", badRun]])}), cas: (...args) => observed.cas(...args)}, input(1), dependencies()));
    expect(mutations).toBe(0); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("refuses an over-budget protected graph without changing the store", async () => {
    const f = fixture(kind); await f.seed([input(2)]); const before = await f.adapter.read(); const deps = dependencies(); Object.assign(deps.context.config, {limits: {softBytes: 1_048_576, hardBytes: 1_048_576}}); Object.assign(deps.context.assets, {script: new Uint8Array(1_048_576).fill(32)});
    await failure(admission(f.adapter, input(3), deps), "admission-budget-refused"); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("keeps strict writeRun rejection of accepted-record omission", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); const before = await f.adapter.read();
    await expect(writeRun(f.adapter, input(1), {metadata: {timestamp: ORIGINAL_TIME}, delay: () => Promise.resolve(), jitter: () => 0, recompute: () => Promise.resolve(candidate([input(2), input(3)]))})).rejects.toThrow("accepted-run-changed"); expect((await f.adapter.read()).tip).toBe(before.tip);
    const extra = {...dependencies(), recompute: () => {throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}, newRunExpired: true}; expect((await admission(f.adapter, input(4), extra)).status).toBe("stored"); await files(await f.adapter.read());
  }, 0);
  it("reuses an existing immutable run key without replacing its record", async () => {
    const f = fixture(kind); const value = input(3); await f.seed([value]); const before = await f.adapter.read(); const different = input(3); different.run.claims = {}; let mutations = 0;
    const observed: StoreAdapter = {read: () => f.adapter.read(), cas: (...args) => {mutations++; return f.adapter.cas(...args);}};
    const result = await admission(observed, different, dependencies()); expect(result.status).toBe("stored"); if (result.status !== "stored") throw new Error("missing stored result"); expect(result.added).toBe(false); expect(canonicalBytes(result.run)).toEqual(canonicalBytes(value.run)); expect(result.tip).toBe(before.tip); expect(mutations).toBe(0); await files(await f.adapter.read());
  }, 0);
  it("freezes accepted input policy and original metadata across retries", async () => {
    const f = fixture(kind); const value = input(3, true); const expected = canonicalBytes(value.run); const blobs = new Map([...value.blobs].map(([path, bytes]) => [path, Uint8Array.from(bytes)])); const deps = dependencies(); let attempts = 0; const timestamps: string[] = [];
    const observed: StoreAdapter = {read: () => {Object.assign(value.run, {claims: {}}); for (const bytes of value.blobs.values()) bytes.fill(1); Object.assign(deps.context.repository, {owner: `../${CANARY_TOKEN}`}); Object.assign(deps.context.assets, {script: new TextEncoder().encode(CANARY_TOKEN)}); Object.assign(deps.context.config.retention ?? {}, {mainRuns: 1}); Object.assign(deps.metadata, {timestamp: "2001-01-01T00:00:00Z"}); return f.adapter.read();}, cas: (tip, tree) => {timestamps.push(tree.metadata.timestamp); if (++attempts === 1) return Promise.resolve({status: "conflict"}); return f.adapter.cas(tip, tree);}};
    const result = await admission(observed, value, deps); expect(result.status).toBe("stored"); expect(timestamps).toEqual([ORIGINAL_TIME, ORIGINAL_TIME]); expect(deps.delays).toEqual([142]); const stored = await f.adapter.read(); expect(await stored.readFile(runRecordPath("3-a1"))).toEqual(expected); for (const [path, bytes] of blobs) expect(Uint8Array.from(await stored.readFile(path))).toEqual(bytes); await files(stored);
  }, 0);
  it("refuses malformed CAS results before reporting admission success", async () => {
    const f = fixture(kind); await f.seed([input(2)]); const before = await f.adapter.read();
    for (const poison of [(reply: object) => {Object.assign(reply, {tip: null});}, (reply: object) => {Reflect.deleteProperty(reply, "tip");}, (reply: object) => {Object.assign(reply, {status: "bogus"});}]) {
      const reply = {status: "accepted" as const, tip: "a".repeat(40)}; poison(reply); let reached = 0;
      await failure(admission({read: () => f.adapter.read(), cas: () => {reached++; return Promise.resolve(reply);}}, input(3), dependencies()), "admission-cas-invalid"); expect(reached).toBe(1);
    }
    const unknown = {status: "unknown" as const, attemptedTip: "a".repeat(40)}; Object.assign(unknown, {attemptedTip: null});
    await failure(admission({read: () => f.adapter.read(), cas: () => Promise.resolve(unknown)}, input(3), dependencies()), "admission-cas-invalid"); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("validates trusted executable bytes before reusing an existing run", async () => {
    const f = fixture(kind); await f.seed([input(3)]); const before = await f.adapter.read(); let reads = 0; let mutations = 0;
    for (const script of [`${CANARY_TOKEN} ${SIGNED_URL}`, null, new Uint8Array()]) {
      const deps = dependencies(); Object.assign(deps.context.assets, {script});
      await failure(admission({read: () => {reads++; return f.adapter.read();}, cas: (...args) => {mutations++; return f.adapter.cas(...args);}}, input(3), deps), "app-invalid");
    }
    expect(reads).toBe(0); expect(mutations).toBe(0); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("captures staged PNG bytes without running typed-array overrides", async () => {
    const f = fixture(kind); const value = input(3, true); const expected = new Map([...value.blobs].map(([path, bytes]) => [path, Uint8Array.from(bytes)])); let executed = 0;
    for (const bytes of value.blobs.values()) {Object.defineProperty(bytes, "byteLength", {get: () => {executed++; return 1;}}); Object.defineProperty(bytes, Symbol.iterator, {value: function* () {executed++; yield 1;}});}
    const result = await admission(f.adapter, value, dependencies()); expect(result.status).toBe("stored"); expect(executed).toBe(0); const stored = await f.adapter.read();
    for (const [path, bytes] of expected) expect(Uint8Array.from(await stored.readFile(path))).toEqual(bytes); await files(stored);
  }, 0);
  it("measures trusted executable bytes without running typed-array overrides", async () => {
    const f = fixture(kind); await f.seed([input(2)]); const before = await f.adapter.read(); const deps = dependencies(); Object.assign(deps.context.config, {limits: {softBytes: 1_048_576, hardBytes: 1_048_576}}); const script = new Uint8Array(1_048_576).fill(32); let executed = 0;
    Object.defineProperty(script, "byteLength", {get: () => {executed++; return 1;}}); Object.defineProperty(script, Symbol.iterator, {value: function* () {executed++; yield 32;}}); Object.assign(deps.context.assets, {script});
    await failure(admission(f.adapter, input(3), deps), "admission-budget-refused"); expect(executed).toBe(0); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("captures stored bytes without running typed-array overrides", async () => {
    const f = fixture(kind); const value = input(2, true); await f.seed([value]); let executed = 0;
    const observed: StoreAdapter = {read: async () => {const snapshot = await f.adapter.read(); return {...snapshot, readFile: async (path) => {
      const original = await snapshot.readFile(path); const returned = Uint8Array.from(original); Object.defineProperty(returned, "byteLength", {get: () => {executed++; return 1;}}); Object.defineProperty(returned, Symbol.iterator, {value: function* () {executed++; yield 1;}}); return returned;
    }};}, cas: (...args) => f.adapter.cas(...args)};
    expect((await admission(observed, input(3), dependencies())).status).toBe("stored"); expect(executed).toBe(0); const stored = await f.adapter.read(); for (const [path, bytes] of value.blobs) expect(Uint8Array.from(await stored.readFile(path))).toEqual(bytes); await files(stored);
  }, 0);
  it("accepts consistent 64-hex context commits and configured executable-byte budgets", async () => {
    const f = fixture(kind); const deps = dependencies(); Object.assign(deps.context, {configCommit: "3".repeat(64)}); Object.assign(deps.context.assets, {releaseCommit: "4".repeat(64), script: new Uint8Array(32 * 1024 * 1024 + 1).fill(32)}); Object.assign(deps.context.config, {limits: {softBytes: 35 * 1024 * 1024, hardBytes: 36 * 1024 * 1024}});
    const result = await admission(f.adapter, input(3), deps); expect(result.status).toBe("stored"); expect(result.attempts).toBe(1); const stored = await f.adapter.read(); expect(stored.tip).toBe(result.tip); expect(stored.runs.has("3-a1")).toBe(true); await files(stored);
  }, 0);
  it("refuses a configured executable-byte hard limit before reusing an existing run", async () => {
    const f = fixture(kind); await f.seed([input(3)]); const before = await f.adapter.read(); let reads = 0; let mutations = 0; const deps = dependencies(); Object.assign(deps.context.config, {limits: {softBytes: 1_048_576, hardBytes: 1_048_576}}); Object.assign(deps.context.assets, {script: new Uint8Array(1_048_577).fill(32)});
    await failure(admission({read: () => {reads++; return f.adapter.read();}, cas: (...args) => {mutations++; return f.adapter.cas(...args);}}, input(3), deps), "site-budget-refused"); expect(reads).toBe(0); expect(mutations).toBe(0); expect((await f.adapter.read()).tip).toBe(before.tip); await files(await f.adapter.read());
  }, 0);
  it("sanitizes poisoned callback diagnostics before exposing admission errors", async () => {
    const f = fixture(kind); await f.seed([input(2)]); const before = await f.adapter.read(); let reached = 0;
    const poison = () => {reached++; const error = new PublisherError("admission-budget-refused"); Object.assign(error, {code: CANARY_TOKEN, message: `${CANARY_TOKEN} ${SIGNED_URL}`, stack: SIGNED_URL, cause: new Error(CANARY_TOKEN)}); return error;};
    await failure(admission({read: () => Promise.reject(poison()), cas: (...args) => f.adapter.cas(...args)}, input(3), dependencies()), "admission-budget-refused");
    for (const point of ["after-read", "after-cas"] as const) {const deps = dependencies(); const observed: AdmissionDependencies = {...deps, checkpoint: (event) => {if (event.point === point) return Promise.reject(poison()); return Promise.resolve();}}; await failure(admission(f.adapter, input(3), observed), "admission-budget-refused");}
    expect(reached).toBe(3); const stored = await f.adapter.read(); expect(stored.tip).not.toBe(before.tip); expect(stored.runs.has("3-a1")).toBe(true); expect(await stored.readFile(runRecordPath("3-a1"))).toEqual(canonicalBytes(input(3).run)); await files(stored);
  }, 0);
  it("recovers an accepted expired admission from its exact native commit receipt", async () => {
    let enabled = false; let reached = 0;
    const f = fixture(kind, (event) => {if (enabled && event.point === "after-push" && event.result === "accepted") {reached++; throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);} return Promise.resolve();});
    await f.seed([input(2), input(3)]); enabled = true; let mutations = 0; let reads = 0; const deps = dependencies();
    const lost: StoreAdapter = {read: () => {reads++; return f.adapter.read();}, cas: async (tip, tree) => {
      mutations++; const result = await f.adapter.cas(tip, tree); raw.push(JSON.stringify(result));
      // Git really pushes, then its injected lost-reply checkpoint produces the native receipt.
      // Local CAS has no transport ambiguity, so wrap its real accepted write with the receipt.
      return kind === "local" && result.status === "accepted" ? {status: "unknown", attemptedTip: result.tip} : result;
    }};
    const result = await admission(lost, input(1), deps); expect(result.status).toBe("expired"); expect(result.attempts).toBe(1); expect(mutations).toBe(1); expect(reads).toBe(2); expect(reached).toBe(kind === "git" ? 1 : 0); expect(deps.delays).toEqual([]); expect((await f.adapter.read()).tip).toBe(result.tip); await files(await f.adapter.read());
  }, 0);
  it("does not infer unknown admission success from an absent run key", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); let mutations = 0; const deps = dependencies(); const before = (await f.adapter.read()).tip;
    const lost: StoreAdapter = {read: () => f.adapter.read(), cas: (tip, tree) => {if (++mutations === 1) return Promise.resolve({status: "unknown"}); return f.adapter.cas(tip, tree);}};
    const result = await admission(lost, input(1), deps); expect(result.status).toBe("expired"); expect(result.attempts).toBe(2); expect(mutations).toBe(2); expect(result.tip).not.toBe(before); expect(deps.delays).toEqual([142]); await files(await f.adapter.read());
  }, 0);
  it("rejects a receipt whose complete candidate bytes do not match", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); let mutations = 0;
    const counterfeit: StoreAdapter = {read: () => f.adapter.read(), cas: async (tip, tree) => {
      if (++mutations !== 1) return f.adapter.cas(tip, tree); const changed = structuredClone(tree.store); changed.txn++; const result = await f.adapter.cas(tip, {...tree, store: changed, files: new Map([...tree.files, ["store.json", canonicalBytes(changed)]])}); return result.status === "accepted" ? {status: "unknown", attemptedTip: result.tip} : result;
    }};
    const result = await admission(counterfeit, input(1), dependencies()); expect(result.status).toBe("expired"); expect(result.attempts).toBe(2); expect(mutations).toBe(2); await files(await f.adapter.read());
  }, 0);
  it("recomputes after a later writer supersedes an unknown expired admission", async () => {
    const f = fixture(kind); await f.seed([input(2), input(3)]); let mutations = 0; let superseded: string | null = null;
    const lost: StoreAdapter = {read: () => f.adapter.read(), cas: async (tip, tree) => {
      const result = await f.adapter.cas(tip, tree); if (++mutations !== 1 || result.status !== "accepted") return result;
      await writeRun(f.make(), input(4), {metadata: {timestamp: ORIGINAL_TIME}, delay: () => Promise.resolve(), jitter: () => 0}); superseded = (await f.adapter.read()).tip; return {status: "unknown", attemptedTip: result.tip};
    }};
    const result = await admission(lost, input(1), dependencies()); expect(result.status).toBe("expired"); expect(result.attempts).toBe(2); expect(result.tip).not.toBe(superseded); expect((await f.adapter.read()).store.runs.map((run) => run.runKey)).toEqual(["3-a1", "4-a1"]); await files(await f.adapter.read());
  }, 0);
  it("recomputes retention disposition after a real stale lease conflict", async () => {
    const f = fixture(kind); await f.seed([input(1), input(3)]); let mutations = 0;
    const race: StoreAdapter = {read: () => f.adapter.read(), cas: async (tip, tree) => {if (++mutations === 1) await writeRun(f.make(), input(4), {metadata: {timestamp: ORIGINAL_TIME}, delay: () => Promise.resolve(), jitter: () => 0}); return f.adapter.cas(tip, tree);}};
    const result = await admission(race, input(2), dependencies()); expect(result.status).toBe("expired"); expect(result.attempts).toBe(2); expect((await f.adapter.read()).store.runs.map((run) => run.runKey)).toEqual(["3-a1", "4-a1"]); await files(await f.adapter.read());
  }, 0);
  it("stops after five attempts without rolling back later writers", async () => {
    for (const outcome of ["conflict", "unknown"] as const) {
      const f = fixture(kind); await f.seed([input(2), input(3)]); const deps = dependencies(); let mutations = 0; const timestamps: string[] = []; const outcomes: string[] = [];
      const churn: StoreAdapter = {read: () => f.adapter.read(), cas: async (tip, tree) => {
        timestamps.push(tree.metadata.timestamp); const later = await writeRun(f.make(), input(10 + ++mutations), {metadata: {timestamp: ORIGINAL_TIME}, delay: () => Promise.resolve(), jitter: () => 0}); expect(later.status).toBe("stored");
        const result = outcome === "conflict" ? await f.adapter.cas(tip, tree) : {status: "unknown" as const}; outcomes.push(result.status); return result;
      }};
      await failure(admission(churn, input(1), deps), "admission-lease-exhausted"); expect(mutations).toBe(5); expect(outcomes).toEqual(Array<string>(5).fill(outcome)); expect(deps.delays).toEqual([142, 242, 442, 842]); expect(timestamps).toEqual(Array<string>(5).fill(ORIGINAL_TIME)); const stored = await f.adapter.read(); expect(stored.runs.has("15-a1")).toBe(true); expect(stored.runs.has("1-a1")).toBe(false); await files(stored);
    }
  }, 0);
});

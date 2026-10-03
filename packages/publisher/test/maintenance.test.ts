/* eslint-disable @typescript-eslint/unbound-method -- Hostile extracted ports are invoked using explicit native Reflect.apply receivers. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { getEventListeners } from "node:events";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { canonicalBytes, parseDocument, type Run } from "@pixelwatch/schemas";
import { addRun, blobPath, encodePng, newStore, pixelHash, runRecordPath } from "@pixelwatch/core";
import { GitBranchStore, LocalDirStore, writeRun, type GitCheckpoint, type StoreAdapter, type StoreCandidate, type StoreSnapshot, type StoreTiming } from "@pixelwatch/store";
import { Scratch } from "../../store/test/helpers.ts";
import { Clock, Scheduler, checkpoint } from "../../../tools/simulation/schedule.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { admitRun } from "../src/admission.ts";
import { maintainStore } from "../src/maintenance.ts";
import { PublisherError, type MaintenanceDependencies, type MaintenanceResult, type PublisherContext } from "../src/types.ts";
const REPOSITORY = "987654321", TIME = "2000-01-01T00:00:00Z";
const scratches: Scratch[] = [], clients: GitBranchStore[] = [], stores: StoreAdapter[] = [];
const raw: (string | Uint8Array)[] = [];
let scannedValues = 0, scannedBytes = 0, scanFailures = 0;
afterEach(async () => {
    try {
        for (const adapter of stores.splice(0)) {
            try {
                const snapshot = await adapter.read();
                for (const file of snapshot.files)
                    raw.push(await snapshot.readFile(file.path));
            }
            catch (error) {
                raw.push(inspect(error, { getters: false, depth: 5 }));
            }
        }
        const values = raw.splice(0);
        scannedValues += values.length;
        for (const value of values)
            scannedBytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
        try {
            assertNoSecrets(values);
        }
        catch (error) {
            scanFailures++;
            throw error;
        }
    }
    finally {
        for (const client of clients.splice(0))
            client.close();
        for (const scratch of scratches.splice(0))
            scratch.close();
    }
});
afterAll(() => {
    const summary = JSON.stringify({ maintenanceRawScan: { values: scannedValues, bytes: scannedBytes, failures: scanFailures } });
    assertNoSecrets([summary]);
    const directory = new URL("../../../.tools/logs/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL("maintenance-raw-scan.json", directory), summary + "\n");
    process.stdout.write(summary + "\n");
});
function present<T>(value: T | undefined): T { if (value === undefined)
    throw new Error("maintenance-fixture-missing"); return value; }
function context(): PublisherContext {
    return { config: { schemaVersion: 1, source: { workflowIds: ["123456"], events: ["push", "pull_request"] }, providers: [{ id: "fixture", shards: 1 }], retention: { mainRuns: 1, runsPerPr: 1, prStreams: 1 } }, configCommit: "3".repeat(40), pages: { url: "https://owner.github.io/repo/", host: "owner.github.io" }, repository: { repositoryId: REPOSITORY, owner: "owner", name: "repo" }, assets: { release: "0.1.0-rc.1", releaseCommit: "4".repeat(40), script: new TextEncoder().encode("globalThis.__trustedPixelWatch=true;") } };
}
function input(id: number, captured = false, pixels = id) {
    const parsed = parseDocument("run", readFileSync(new URL(`../../../testdata/schemas/run/valid/${captured ? "initial-commit-no-baseline" : "no-usable-artifact"}.json`, import.meta.url)));
    if (!parsed.ok)
        throw new Error("maintenance-fixture-invalid");
    const run: Run = { ...parsed.value, runKey: `${String(id)}-a1`, source: { ...parsed.value.source, runId: String(id), createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString().replace(".000Z", "Z") } };
    const blobs = new Map<string, Uint8Array>();
    if (captured) {
        const image = { width: 2, height: 2, channels: 3 as const, data: Uint8Array.from([pixels, 0, 1, pixels, 1, 2, pixels, 2, 3, pixels, 3, 4]) }, hash = pixelHash(image);
        const result = present(run.results[0]);
        result.head = { state: "captured", pixelHash: hash, width: 2, height: 2 };
        blobs.set(blobPath(hash), encodePng(image));
    }
    return { run, blobs };
}
function candidate(values: readonly ReturnType<typeof input>[]): StoreCandidate & {
    files: Map<string, Uint8Array>;
    runs: Map<string, Run>;
} {
    let store = newStore(REPOSITORY);
    const files = new Map<string, Uint8Array>(), runs = new Map<string, Run>();
    for (const value of values) {
        store = addRun(store, value.run).store;
        runs.set(value.run.runKey, value.run);
        files.set(runRecordPath(value.run.runKey), canonicalBytes(value.run));
        for (const [path, bytes] of value.blobs)
            files.set(path, bytes);
    }
    files.set("store.json", canonicalBytes(store));
    return { store, runs, files, metadata: { timestamp: TIME } };
}
function dependencies() {
    const clock = new Clock(), scheduler = new Scheduler(42, 4), delays: number[] = [], controller = new AbortController();
    let jitter = 0, deadlines = 0, disposals = 0;
    scheduler.add("maintenance", function* () { yield checkpoint("jitter", () => { jitter = scheduler.seed; }); });
    scheduler.run();
    const deps: MaintenanceDependencies = { context: context(), now: TIME, metadata: { timestamp: TIME }, prStates: new Map(), pins: new Set(), signal: controller.signal, delay: ms => { delays.push(ms); clock.advance(ms); return Promise.resolve(); }, jitter: () => jitter, timing: { deadline: ms => { expect(ms).toBe(600000); deadlines++; return { signal: controller.signal, dispose: () => { disposals++; } }; } } };
    return { deps, controller, delays, counts: () => ({ deadlines, disposals }) };
}
function fixture(kind: "local" | "git", hook?: (event: GitCheckpoint) => Promise<void>) {
    const scratch = new Scratch();
    scratches.push(scratch);
    let reads = 0, writes = 0;
    const leases: (string | null)[] = [], timing: string[] = [];
    const storeTiming: StoreTiming = { deadline: ms => { expect(ms).toBe(60000); timing.push("deadline"); return { signal: new AbortController().signal, dispose: () => { timing.push("dispose"); } }; } };
    const make = (): StoreAdapter => {
        if (kind === "local")
            return new LocalDirStore({ directory: join(scratch.root, "local"), repositoryId: REPOSITORY, defaultBranch: "main" });
        const adapter = new GitBranchStore({ remote: scratch.remote, repositoryId: REPOSITORY, defaultBranch: "main", testRemote: { root: scratch.root }, timing: storeTiming, ...(hook === undefined ? {} : { checkpoint: hook }) });
        clients.push(adapter);
        return adapter;
    };
    const actual = make();
    stores.push(actual);
    const port: StoreAdapter = { read: () => { reads++; return actual.read(); }, cas: (tip, tree) => { writes++; leases.push(tip); return actual.cas(tip, tree); } };
    const seed = async (values: readonly ReturnType<typeof input>[]) => { expect((await actual.cas(null, candidate(values))).status).toBe("accepted"); };
    const corrupt = async (tree: StoreCandidate) => {
        for (const bytes of tree.files.values())
            raw.push(bytes);
        if (kind === "git")
            scratch.seed(tree.files);
        else {
            const snapshot = await actual.read();
            for (const [path, bytes] of tree.files)
                writeFileSync(join(scratch.root, "local", "versions", present(snapshot.tip ?? undefined), ...path.split("/")), bytes);
        }
    };
    return { scratch, actual, port, make, seed, corrupt, leases, timing, counts: () => ({ reads, writes }) };
}
async function success(adapter: StoreAdapter, deps: MaintenanceDependencies): Promise<MaintenanceResult> {
    try {
        const result = await maintainStore(adapter, deps);
        raw.push(inspect(result, { depth: 10 }), JSON.stringify(result));
        return result;
    } catch (error) {
        raw.push(inspect(error, { getters: false, showHidden: true, depth: 10 }));
        throw error;
    }
}
async function failure(adapter: StoreAdapter, deps: MaintenanceDependencies, code?: string) {
    let caught: unknown;
    try {
        await maintainStore(adapter, deps);
    }
    catch (error) {
        caught = error;
    }
    raw.push(inspect(caught, { getters: false, showHidden: true, depth: 10 }));
    expect(caught).toBeInstanceOf(PublisherError);
    if (code !== undefined)
        expect((caught as PublisherError).code).toBe(code);
    expect(Object.hasOwn(caught as object, "cause")).toBe(false);
}
// ADR0015 permits timeout0 for fixed-step deterministic adapter cases; every native Git process
// retains its watchdog, every writer has <=5 attempts, and all product time/seed ports are injected.
describe.each(["local", "git"] as const)("internal maintenance with actual %s CAS", kind => {
    it("non-string store paths refuse without inspecting path-value properties", async () => {
        const d = dependencies(); let traps = 0, reads = 0, byteReads = 0, writes = 0;
        const path = { get length() { traps++; throw new Error(CANARY_TOKEN + SIGNED_URL); } } as unknown as string;
        await failure({ read: () => { reads++; return Promise.resolve({ tip: "a".repeat(40), store: newStore(REPOSITORY), runs: new Map(), files: [{ path, bytes: 10 }], readFile: () => { byteReads++; return Promise.reject(new Error("unexpected-byte-read")); } }); }, cas: () => { writes++; return Promise.reject(new Error("unexpected-write")); } }, d.deps);
        expect({ traps, reads, byteReads, writes }).toEqual({ traps: 0, reads: 1, byteReads: 0, writes: 0 }); expect(d.counts()).toEqual({ deadlines: 1, disposals: 1 });
    }, 0);
    it("non-string PR-state keys refuse without invoking caller primitive conversion", async () => {
        const d = dependencies(); let traps = 0, reads = 0, writes = 0;
        const key = { [Symbol.toPrimitive]() { traps++; return "1"; } } as unknown as string;
        await failure({ read: () => { reads++; return Promise.reject(new Error("unexpected-maintenance-read")); }, cas: () => { writes++; return Promise.reject(new Error("unexpected-maintenance-write")); } }, { ...d.deps, prStates: new Map([[key, "open"]]) });
        expect({ traps, reads, writes }).toEqual({ traps: 0, reads: 0, writes: 0 });
    }, 0);
    it("a validated PR state snapshot uses the existing store graph count bound", async () => {
        const f = fixture(kind), d = dependencies();
        const prStates = new Map<string, "unknown">();
        for (let id = 1; id <= 1025; id++) prStates.set(String(id), "unknown");
        const result = await success(f.port, { ...d.deps, prStates });
        expect(result.status).toBe("absent"); expect(f.counts()).toEqual({ reads: 1, writes: 0 }); expect(prStates.size).toBe(1025);
    }, 0);
    it("maintenance applies exact real retention and GC without constructing a capture", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1, true), input(2, true)]);
        const before = await f.actual.read(), oldBlob = present(before.files.find(file => file.path === [...input(1, true).blobs.keys()][0]));
        const result = await success(f.port, d.deps), after = await f.actual.read();
        expect(result.status).toBe("updated");
        expect(result.tip).toBe(after.tip);
        expect(result.attempts).toBe(1);
        expect(result.unknownPushes).toBe(0);
        expect(result.removedRuns).toEqual(["1-a1"]);
        expect(result.deleted).toEqual([{ path: oldBlob.path, bytes: oldBlob.bytes }, { path: runRecordPath("1-a1"), bytes: canonicalBytes(input(1, true).run).byteLength }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        expect([...after.runs.keys()]).toEqual(["2-a1"]);
        expect(after.store.txn).toBe(before.store.txn + 1);
        expect(await after.readFile(runRecordPath("2-a1"))).toEqual(canonicalBytes(input(2, true).run));
        expect(f.counts().writes).toBe(1);
        expect(f.leases).toEqual([before.tip]);
        expect(d.counts()).toEqual({ deadlines: 1, disposals: 1 });
    }, 0);
    it("an absent or already clean store performs no CAS", async () => {
        const f = fixture(kind), d = dependencies();
        const absent = await success(f.port, d.deps);
        expect(absent).toEqual({ status: "absent", tip: null, attempts: 1, unknownPushes: 0, deleted: [], removedRuns: [] });
        expect(f.counts().writes).toBe(0);
        await f.seed([input(1)]);
        const before = await f.actual.read(), clean = await success(f.port, dependencies().deps);
        expect(clean).toEqual({ status: "unchanged", tip: before.tip, attempts: 1, unknownPushes: 0, deleted: [], removedRuns: [] });
        expect(f.counts().writes).toBe(0);
    }, 0);
    it("unknown config store and expired run versions refuse before maintenance writes", async () => {
        for (const target of ["config", "store", "expired-run"] as const) {
            const f = fixture(kind), d = dependencies();
            await f.seed([input(1), input(2)]);
            if (target === "config")
                Object.assign(d.deps.context.config, { schemaVersion: 2 });
            else {
                const tree = candidate([input(1), input(2)]);
                if (target === "store")
                    Object.assign(tree.store, { dataVersion: 2 });
                else
                    Object.assign(present(tree.runs.get("1-a1")), { schemaVersion: 2 });
                tree.files.set("store.json", canonicalBytes(tree.store));
                if (target === "expired-run")
                    tree.files.set(runRecordPath("1-a1"), canonicalBytes(present(tree.runs.get("1-a1"))));
                await f.corrupt(tree);
            }
            await failure(f.port, d.deps);
            expect(f.counts().writes).toBe(0);
            expect(f.counts().reads).toBe(target === "config" ? 0 : 1);
        }
    }, 0);
    it("maintenance preserves reused canonical bytes without decode or rehash", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1, true, 7), input(2, true, 7)]);
        const before = await f.actual.read(), path = present([...input(2, true, 7).blobs.keys()][0]), bytes = await before.readFile(path);
        const result = await success(f.port, d.deps), after = await f.actual.read();
        expect(result.status).toBe("updated");
        expect(result.deleted.some(file => file.path === path)).toBe(false);
        expect(await after.readFile(path)).toEqual(bytes);
    }, 0);
    it("a conflicting writer is retained when maintenance recomputes under a fresh lease", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0;
        const result = await success(f.port, { ...d.deps, checkpoint: async (event) => { if (event.point === "before-cas" && event.attempt === 1) {
                reached++;
                await writeRun(f.make(), input(3), { metadata: { timestamp: TIME }, delay: () => Promise.resolve(), jitter: () => 0 });
            } } });
        expect(reached).toBe(1);
        expect(result).toMatchObject({ status: "updated", attempts: 2, unknownPushes: 0, removedRuns: ["1-a1", "2-a1"] });
        expect(f.counts().writes).toBe(2);
        expect(f.leases[0]).not.toBe(f.leases[1]);
        expect([...(await f.actual.read()).runs.keys()]).toEqual(["3-a1"]);
        expect(d.delays).toEqual([142]);
    }, 0);
    it("maintenance recovers only the exact accepted lost-reply candidate", async () => {
        let enabled = false, nativeLost = 0;
        const f = fixture(kind, event => { if (enabled && event.point === "after-push" && event.result === "accepted") {
            nativeLost++;
            throw new Error(CANARY_TOKEN + SIGNED_URL);
        } return Promise.resolve(); }), d = dependencies();
        await f.seed([input(1), input(2)]);
        enabled = true;
        let reached = 0;
        const port: StoreAdapter = { read: () => f.port.read(), cas: async (tip, tree) => { reached++; const reply = await f.port.cas(tip, tree); tree.files.get("store.json")?.fill(0); (tree.files as Map<string, Uint8Array>).clear(); return kind === "local" && reply.status === "accepted" ? { status: "unknown", attemptedTip: reply.tip } : reply; } };
        const result = await success(port, d.deps);
        expect(result).toMatchObject({ status: "recovered", attempts: 1, unknownPushes: 1, removedRuns: ["1-a1"] });
        expect(reached).toBe(1);
        expect(nativeLost).toBe(kind === "git" ? 1 : 0);
        expect(f.counts().writes).toBe(1);
        expect(d.delays).toEqual([]);
        expect((await f.actual.read()).tip).toBe(result.tip);
    }, 0);
    it("a superseding writer cannot prove an uncertain maintenance transaction", async () => {
        for (const clean of [false, true]) {
            const f = fixture(kind), d = dependencies();
            await f.seed([input(1), input(2)]);
            let reached = 0;
            const port: StoreAdapter = { read: () => f.port.read(), cas: async (tip, tree) => { const reply = await f.port.cas(tip, tree); if (reply.status === "accepted" && ++reached === 1) {
                    const writer = f.make();
                    if (clean)
                        await admitRun(writer, input(3), d.deps);
                    else
                        await writeRun(writer, input(3), { metadata: { timestamp: TIME }, delay: () => Promise.resolve(), jitter: () => 0 });
                    return { status: "unknown", attemptedTip: reply.tip };
                } return reply; } };
            const result = await success(port, d.deps);
            expect(reached).toBe(clean ? 1 : 2);
            expect(result).toMatchObject({ status: clean ? "unchanged" : "updated", attempts: 2, unknownPushes: 1 });
            expect(result.removedRuns).toEqual(clean ? [] : ["2-a1"]);
            expect([...(await f.actual.read()).runs.keys()]).toEqual(["3-a1"]);
            expect(f.counts().writes).toBe(clean ? 1 : 2);
        }
    }, 0);
    it("five maintenance conflicts exhaust without a blind force or sixth write", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0;
        await failure(f.port, { ...d.deps, checkpoint: async (event) => { if (event.point === "before-cas") {
                reached++;
                await writeRun(f.make(), input(100 + event.attempt), { metadata: { timestamp: TIME }, delay: () => Promise.resolve(), jitter: () => 0 });
            } } }, "maintenance-lease-exhausted");
        expect(reached).toBe(5);
        expect(f.counts().writes).toBe(5);
        expect(f.leases.every(tip => tip !== null)).toBe(true);
        expect(d.delays).toEqual([142, 242, 442, 842]);
        const after = await f.actual.read();
        expect(after.runs.has("1-a1")).toBe(true);
        expect(after.runs.has("2-a1")).toBe(true);
        expect(after.runs.has("105-a1")).toBe(true);
    }, 0);
    it("maintenance cancellation prevents new CAS and preserves a proven sent push", async () => {
        for (const outcome of ["before", "accepted", "unknown"] as const) {
            const f = fixture(kind), d = dependencies();
            await f.seed([input(1), input(2)]);
            let reached = 0;
            const deps = { ...d.deps, checkpoint: (event: Parameters<NonNullable<MaintenanceDependencies["checkpoint"]>>[0]) => { if (outcome === "before" && event.point === "before-cas") {
                    reached++;
                    d.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
                } return Promise.resolve(); } };
            const port: StoreAdapter = { read: () => f.port.read(), cas: async (...args) => { const reply = await f.port.cas(...args); if (reply.status === "accepted") {
                    reached++;
                    d.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
                    return outcome === "unknown" ? { status: "unknown", attemptedTip: reply.tip } : reply;
                } return reply; } };
            if (outcome === "before") {
                await failure(port, deps, "maintenance-cancelled");
                expect(f.counts().writes).toBe(0);
            }
            else {
                const result = await success(port, deps);
                expect(result.status).toBe(outcome === "unknown" ? "recovered" : "updated");
                expect(f.counts().writes).toBe(1);
                expect((await f.actual.read()).tip).toBe(result.tip);
            }
            expect(reached).toBe(1);
        }
    }, 0);
    it("post CAS checkpoint and teardown failure cannot conceal confirmed maintenance", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0, disposed = 0;
        const result = await success(f.port, { ...d.deps, checkpoint: event => { if (event.point === "after-cas") {
                reached++;
                throw new Error(CANARY_TOKEN + SIGNED_URL);
            } return Promise.resolve(); }, timing: { deadline: () => ({ signal: d.controller.signal, dispose: () => { disposed++; throw new Error(CANARY_TOKEN + SIGNED_URL); } }) } });
        expect(result).toMatchObject({ status: "updated", warnings: ["checkpoint-failed", "timing-disposal-failed"] });
        expect({ reached, disposed }).toEqual({ reached: 1, disposed: 1 });
        expect((await f.actual.read()).tip).toBe(result.tip);
    }, 0);
    it("hostile metadata methods byte aliases and rejected prototypes remain bounded and secret-free", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let binds = 0, iterator = 0, traps = 0, reached = 0;
        const read = f.port.read, cas = f.port.cas;
        for (const method of [read, cas, d.deps.delay, d.deps.jitter])
            Object.defineProperty(method, "bind", { get() { binds++; throw new Error(CANARY_TOKEN); } });
        Object.defineProperty(d.deps.context.assets.script, Symbol.iterator, { value() { iterator++; throw new Error(CANARY_TOKEN); } });
        const result = await success(f.port, { ...d.deps, checkpoint: event => { if (event.point === "before-cas") {
                reached++;
                Object.assign(present(d.deps.context.config.retention), { mainRuns: 100 });
                Object.assign(d.deps.metadata, { timestamp: "2001-01-01T00:00:00Z" });
                d.deps.context.assets.script.fill(0);
            } return Promise.resolve(); } });
        expect(result.status).toBe("updated");
        expect([...(await f.actual.read()).runs.keys()]).toEqual(["2-a1"]);
        expect({ binds, iterator, reached }).toEqual({ binds: 0, iterator: 0, reached: 1 });
        const other = fixture(kind), next = dependencies();
        await other.seed([input(1), input(2)]);
        const hostile = new Proxy(new Error("hostile"), { getPrototypeOf() { traps++; throw new Error(CANARY_TOKEN + SIGNED_URL); } });
        await failure({ read: () => other.port.read(), cas: () => Promise.reject(hostile) }, next.deps, "maintenance-operation-failed");
        expect(traps).toBe(0);
        expect(next.counts()).toEqual({ deadlines: 1, disposals: 1 });
    }, 0);
    it("partial timing acquisition and listener cleanup cannot strand maintenance", async () => {
        for (const variant of ["early", "signal-getter", "listener", "read-abort"] as const) {
            const f = fixture(kind), d = dependencies();
            let acquired = 0, disposed = 0, reached = 0;
            const hook = present(Object.getOwnPropertySymbols(EventTarget.prototype).find(key => key.description === "kNewListener"));
            const deps: MaintenanceDependencies = { ...d.deps, timing: { deadline: () => { acquired++; return { get signal() { if (variant === "signal-getter")
                            throw new Error(CANARY_TOKEN + SIGNED_URL); return d.controller.signal; }, dispose: () => { disposed++; } }; } } };
            if (variant === "early")
                Object.defineProperty(deps, "timing", { get() { reached++; throw new Error(CANARY_TOKEN + SIGNED_URL); } });
            if (variant === "listener") {
                d.controller.signal.addEventListener("abort", () => { });
                Object.defineProperty(d.controller.signal, hook, { value() { reached++; throw new Error(CANARY_TOKEN); } });
            }
            const port = variant === "read-abort" ? { read: () => { reached++; d.controller.abort(); return new Promise<StoreSnapshot>(() => { }); }, cas: (...args: Parameters<StoreAdapter["cas"]>) => f.port.cas(...args) } : f.port;
            let settled = false;
            const pending = failure(port, deps).then(() => { settled = true; });
            for (let step = 0; step < 100; step++)
                await Promise.resolve();
            expect(settled).toBe(true);
            await pending;
            expect(f.counts().writes).toBe(0);
            expect(acquired).toBe(variant === "early" ? 0 : 1);
            expect(disposed).toBe(variant === "early" ? 0 : 1);
            expect(reached).toBe(variant === "signal-getter" ? 0 : 1);
            if (variant === "listener")
                expect(getEventListeners(d.controller.signal, "abort")).toHaveLength(1);
        }
    }, 0);
    it("an ignored post CAS checkpoint expires without hiding committed maintenance", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0, settled = false;
        let release = () => { };
        const ignored = new Promise<void>(resolve => { release = resolve; });
        let arrive = () => { };
        const arrived = new Promise<void>(resolve => { arrive = resolve; });
        const pending = success(f.port, { ...d.deps, checkpoint: event => { if (event.point === "after-cas") {
                reached++;
                d.controller.abort();
                arrive();
                return ignored;
            } return Promise.resolve(); } }).then(result => { settled = true; return result; });
        try {
            // Native CAS has already completed when the checkpoint aborts. Observe its completion
            // using the same injected checkpoint, then drain a fixed number of promise turns.
            await arrived;
            for (let step = 0; step < 100; step++)
                await Promise.resolve();
            expect(settled).toBe(true);
        }
        finally {
            release();
        }
        const result = await pending;
        expect(result.status).toBe("updated");
        expect(result.warnings).toEqual(["checkpoint-failed"]);
        expect(reached).toBe(1);
        expect(d.counts().disposals).toBe(1);
        expect((await f.actual.read()).tip).toBe(result.tip);
    }, 0);
    it("a failed unproven post CAS checkpoint refetches once and never retries", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0;
        await failure({ read: () => f.port.read(), cas: () => { reached++; return Promise.resolve({ status: "conflict" }); } }, { ...d.deps, checkpoint: event => { if (event.point === "after-cas")
                throw new Error(CANARY_TOKEN + SIGNED_URL); return Promise.resolve(); } }, "maintenance-checkpoint-failed");
        expect(reached).toBe(1);
        expect(f.counts().reads).toBe(2);
        expect(d.delays).toEqual([]);
        expect([...(await f.actual.read()).runs.keys()]).toEqual(["1-a1", "2-a1"]);
    }, 0);
    it("a missing receipt never recovers merely because the final tree is clean", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0;
        const result = await success({ read: () => f.port.read(), cas: async (...args) => { reached++; expect((await f.port.cas(...args)).status).toBe("accepted"); return { status: "unknown" }; } }, d.deps);
        expect(result).toEqual({ status: "unchanged", tip: (await f.actual.read()).tip, attempts: 2, unknownPushes: 1, deleted: [], removedRuns: [] });
        expect(reached).toBe(1);
        expect(d.delays).toEqual([142]);
    }, 0);
    it("a matching receipt still requires every private candidate path and byte", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let reached = 0, receipt: string | undefined;
        const port: StoreAdapter = { read: async () => { const snapshot = await f.port.read(); return receipt === undefined ? snapshot : { ...snapshot, tip: receipt }; }, cas: async (...args) => { reached++; const reply = await f.port.cas(...args); if (reply.status === "accepted" && receipt === undefined) {
                receipt = reply.tip;
                await admitRun(f.make(), input(3), d.deps);
                return { status: "unknown", attemptedTip: receipt };
            } return reply; } };
        const result = await success(port, d.deps);
        expect(result.status).toBe("unchanged");
        expect(result.unknownPushes).toBe(1);
        expect(result.deleted).toEqual([]);
        expect(reached).toBe(1);
        expect([...(await f.actual.read()).runs.keys()]).toEqual(["3-a1"]);
    }, 0);
    it("an absent or unchanged observation refuses a failed deadline disposal", async () => {
        for (const existing of [false, true]) {
            const f = fixture(kind), d = dependencies();
            if (existing)
                await f.seed([input(1)]);
            let disposed = 0;
            await failure(f.port, { ...d.deps, timing: { deadline: () => ({ signal: d.controller.signal, dispose: () => { disposed++; throw new Error(CANARY_TOKEN + SIGNED_URL); } }) } }, "maintenance-timing-invalid");
            expect(disposed).toBe(1);
            expect(f.counts().writes).toBe(0);
        }
    }, 0);
    it("intrinsically aborted signals and proxy shapes cannot authorize a maintenance write", async () => {
        for (const shape of ["native", "proxy"] as const) {
            const f = fixture(kind), d = dependencies();
            let getters = 0, traps = 0;
            d.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
            Object.defineProperty(d.controller.signal, "aborted", { get() { getters++; return false; } });
            const signal = shape === "native" ? d.controller.signal : new Proxy(d.controller.signal, { getPrototypeOf() { traps++; throw new Error(CANARY_TOKEN); } });
            await failure(f.port, { ...d.deps, signal });
            expect(f.counts()).toEqual({ reads: 0, writes: 0 });
            expect({ getters, traps }).toEqual({ getters: 0, traps: 0 });
        }
    }, 0);
    it("snapshot collections and ports are privately captured without caller iteration or rebinding", async () => {
        const f = fixture(kind), d = dependencies();
        await f.seed([input(1), input(2)]);
        let iterators = 0, maps = 0, binds = 0, mutations = 0, reads = 0, cases = 0;
        const port: StoreAdapter = { read: () => {
                const pending = f.port.read().then(snapshot => {
                    const reader = snapshot.readFile;
                    Object.defineProperty(reader, "bind", { get() { binds++; throw new Error(CANARY_TOKEN); } });
                    Object.defineProperty(snapshot.runs, Symbol.iterator, { value() { iterators++; throw new Error(CANARY_TOKEN + SIGNED_URL); } });
                    Object.defineProperty(snapshot.files, "map", { value() { maps++; throw new Error(CANARY_TOKEN); } });
                    const returned: StoreSnapshot = { ...snapshot, readFile(path) { expect(this).toBe(returned); reads++; return Reflect.apply(reader, snapshot, [path]); } };
                    Object.defineProperty(returned.readFile, "bind", { get() { binds++; throw new Error(CANARY_TOKEN); } });
                    return returned;
                });
                void pending.then(value => { queueMicrotask(() => { mutations++; value.store.runs.length = 0; (value.runs as Map<string, Run>).clear(); }); });
                return pending;
            }, cas: (tip, tree) => { cases++; return f.port.cas(tip, tree); } };
        const result = await success(port, d.deps);
        expect(result.status).toBe("updated");
        expect({ iterators, maps, binds, mutations, cases }).toEqual({ iterators: 0, maps: 0, binds: 0, mutations: 1, cases: 1 });
        expect(reads).toBe(3);
        expect([...(await f.actual.read()).runs.keys()]).toEqual(["2-a1"]);
    }, 0);
});

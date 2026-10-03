import childProcess, { type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { getEventListeners } from "node:events";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitBranchStore, type GitCheckpoint, type GitPackCheckpoint, type PackResponse, type PackTransport, type StoreDeadline } from "../src/index.ts";
import { assertNoSecrets, CANARY_TOKEN, SIGNED_URL } from "../../../tools/simulation/capture.ts";
import { candidate, REPOSITORY_ID, Scratch } from "./helpers.ts";

const scratches: Scratch[] = [];
const adapters: GitBranchStore[] = [];
const FAULT = `FAKE_STORE_LIFETIME_CANARY ${CANARY_TOKEN} ${SIGNED_URL}`;
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); for (const scratch of scratches.splice(0)) scratch.close(); });
function fixture(extra = {}) {
  const scratch = new Scratch(); scratches.push(scratch);
  const adapter = new GitBranchStore({ remote: scratch.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main", testRemote: { root: scratch.root }, ...extra }); adapters.push(adapter);
  return { scratch, adapter };
}
function gate() { let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); return { pending, release }; }
function settle<T>(pending: Promise<T>) { return pending.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error })); }
function cleanError(error: unknown) { const raw = inspect(error, { showHidden: true, depth: 8 }); assertNoSecrets([raw]); expect(raw).not.toContain("FAKE_STORE_LIFETIME_CANARY"); return raw; }

describe("Git store terminal lifetime", () => {
  it("closing an unused adapter is idempotent and refuses every later read or CAS", async () => {
    const { adapter, scratch } = fixture();
    const first = adapter.close(); const repeated = adapter.close(); expect(repeated).toBe(first); await expect(first).resolves.toBeUndefined();
    await expect(adapter.read()).rejects.toThrow("git-not-initialized"); await expect(adapter.cas(null, candidate())).rejects.toThrow("git-not-initialized");
    expect(scratch.git(["for-each-ref", "--format=%(refname)"])).toBe("");
  });
  it.each(["child-started", "before-index"] as const)("close cancels a held %s read and joins native resources before removing scratch", async (point) => {
    const entered = gate(); const held = gate(); let pid: number | undefined; let disposed = 0;
    const { adapter, scratch } = fixture({ timing: { deadline: () => ({ signal: new AbortController().signal, dispose: () => { disposed++; } }) }, packCheckpoint: (event: GitPackCheckpoint) => {
      if (event.pid !== undefined) pid = event.pid;
      if (event.point === point) { entered.release(); return held.pending; } return Promise.resolve();
    } });
    const old = scratch.seed(candidate().files); const pending = settle(adapter.read());
    try {
      await entered.pending;
      if (point === "child-started") { expect(pid).toBeDefined(); expect(() => process.kill(pid ?? 0, 0)).not.toThrow(); }
      const closing = adapter.close(); expect(adapter.close()).toBe(closing); await expect(closing).resolves.toBeUndefined();
      const result = await pending; expect(result.value).toBeUndefined(); expect(cleanError(result.error)).toContain("git-not-initialized");
      expect(disposed).toBe(1); const stoppedPid = pid; if (stoppedPid !== undefined) expect(() => process.kill(stoppedPid, 0)).toThrow();
      expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
      await expect(adapter.read()).rejects.toThrow("git-not-initialized");
    } finally { held.release(); await pending; }
  });
  it("close cancels an ignored pre-push checkpoint without sending a late write", async () => {
    const entered = gate(); const held = gate(); let before = 0; let after = 0;
    const { adapter, scratch } = fixture({ checkpoint: (event: GitCheckpoint) => {
      if (event.point === "before-push") { before++; entered.release(); return held.pending; } after++; return Promise.resolve();
    } });
    const pending = settle(adapter.cas(null, candidate()));
    try {
      await entered.pending; await expect(adapter.close()).resolves.toBeUndefined(); const result = await pending;
      expect(cleanError(result.error)).toContain("git-not-initialized"); expect(before).toBe(1); expect(after).toBe(0);
      held.release(); await Promise.resolve(); expect(scratch.git(["for-each-ref", "--format=%(refname)"])).toBe("");
    } finally { held.release(); await pending; }
  });
  it("close preserves an already sent accepted push as an uncertain reply with its exact attempted tip", async () => {
    const entered = gate(); const held = gate(); let attempts = 0;
    const { adapter, scratch } = fixture({ checkpoint: (event: GitCheckpoint) => {
      if (event.point === "after-push") { attempts++; entered.release(); return held.pending; } return Promise.resolve();
    } });
    const pending = settle(adapter.cas(null, candidate()));
    try {
      await entered.pending; const current = scratch.git(["rev-parse", "refs/heads/pixelwatch-data"]); await expect(adapter.close()).resolves.toBeUndefined(); const result = await pending;
      expect(result.error).toBeUndefined(); expect(result.value).toEqual({ status: "unknown", attemptedTip: current }); expect(attempts).toBe(1);
      assertNoSecrets([JSON.stringify(result.value)]); expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(current);
    } finally { held.release(); await pending; }
  });
  it("a retained snapshot refuses file access after close without recreating a client", async () => {
    const { adapter, scratch } = fixture(); scratch.seed(candidate().files); const snapshot = await adapter.read(); await adapter.close();
    await expect(snapshot.readFile("store.json")).rejects.toThrow("git-not-initialized");
    expect(snapshot.tip).not.toBeNull(); expect(snapshot.files.map((file) => file.path)).toEqual(["store.json"]);
  });
  it("an injected pack deadline interrupts an ignored before-index checkpoint and closes its pack", async () => {
    const entered = gate(); const held = gate(); const controller = new AbortController(); let disposed = 0; let settled = false;
    const { adapter, scratch } = fixture({ timing: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) }, packCheckpoint: (event: GitPackCheckpoint) => {
      if (event.point === "before-index") { entered.release(); return held.pending; } return Promise.resolve();
    } });
    const old = scratch.seed(candidate().files); const pending = settle(adapter.read()).then((result) => { settled = true; return result; });
    try {
      await entered.pending; controller.abort(FAULT);
      for (let step = 0; step < 32; step++) await Promise.resolve(); expect(settled).toBe(true);
      const result = await pending; expect(cleanError(result.error)).toContain("git-pack-deadline"); expect(disposed).toBe(1);
      expect(scratch.git(["rev-parse", "refs/heads/pixelwatch-data"])).toBe(old);
    } finally { held.release(); await pending; }
  });
  it.each([["close", "request"], ["close", "body"], ["deadline", "request"], ["deadline", "body"]] as const)("%s interrupts an ignored production pack %s and removes the open pack before late callback rejection", async (cancellation, point) => {
    const scratch = new Scratch(); scratches.push(scratch); const old = scratch.seed(candidate().files);
    const nativeSpawn = childProcess.spawnSync; let root: string | undefined; let indexes = 0; let disposed = 0; let signal: AbortSignal | undefined;
    const entered = gate(); const held = gate(); const controller = new AbortController(); let cancelled = 0; let repeated: Promise<void> | undefined;
    const response: PackResponse = { status: 200, contentType: "application/x-git-upload-pack-result", body: { [Symbol.asyncIterator]: () => ({
      next: () => { entered.release(); return held.pending.then(() => { throw new Error(FAULT); }); },
      return: () => { cancelled++; return Promise.resolve({ done: true, value: undefined }); },
    }) } };
    const packTransport: PackTransport = { request: (request) => { signal = request.signal;
      signal.addEventListener("abort", () => { if (cancellation === "close") repeated = adapter.close(); }, { once: true });
      if (point === "request") { entered.release(); return held.pending.then(() => { throw new Error(FAULT); }); }
      return Promise.resolve(response);
    } };
    childProcess.spawnSync = ((command: string, args: readonly string[] = [], options?: SpawnSyncOptionsWithBufferEncoding) => {
      if (command !== "git") throw new Error("unexpected fixture subprocess");
      if (args.includes("init") && typeof options?.cwd === "string") root = options.cwd;
      if (args.includes("index-pack")) indexes++;
      if (args.includes("ls-remote")) return { pid: 1, output: [null, Buffer.from(`${old}\trefs/heads/pixelwatch-data\n`), Buffer.alloc(0)], stdout: Buffer.from(`${old}\trefs/heads/pixelwatch-data\n`), stderr: Buffer.alloc(0), status: 0, signal: null };
      if (args.some((arg) => arg.startsWith("https://"))) throw new Error("external Git forbidden in fixture"); return nativeSpawn(command, args, options);
    }) as typeof childProcess.spawnSync; syncBuiltinESMExports();
    const adapter = new GitBranchStore({ remote: "https://github.com/fixture/review.git", repositoryId: REPOSITORY_ID, defaultBranch: "main", packTransport,
      timing: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) } }); adapters.push(adapter);
    const pending = settle(adapter.read());
    try {
      await entered.pending;
      if (cancellation === "close") { const closing = adapter.close(); expect(repeated).toBe(closing); await expect(closing).resolves.toBeUndefined(); }
      else controller.abort(FAULT);
      const result = await pending; expect(cleanError(result.error)).toContain(cancellation === "close" ? "git-not-initialized" : "git-pack-deadline");
      expect(disposed).toBe(1); expect(signal?.aborted).toBe(true); expect(indexes).toBe(0); await adapter.close();
      expect(root).toBeDefined(); expect(existsSync(root ?? "")).toBe(false); expect(cancelled).toBe(point === "body" ? 1 : 0);
      held.release(); await Promise.resolve(); await Promise.resolve(); expect(indexes).toBe(0);
    } finally { held.release(); await pending; childProcess.spawnSync = nativeSpawn; syncBuiltinESMExports(); }
  });
  it.each(["acquire", "signal", "dispose", "listeners"] as const)("%s deadline setup or cleanup attempts every acquired native pack release without inspecting public signal hooks", async (stage) => {
    let opened: number | undefined; let closed = 0; let root: string | undefined; let disposed = 0; let hooks = 0; let pid: number | undefined;
    const nativeOpen = fs.openSync; const nativeClose = fs.closeSync;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { const descriptor = nativeOpen(...args);
      if (typeof args[0] === "string" && args[0].endsWith("incoming.pack")) { opened = descriptor; root = dirname(dirname(dirname(dirname(args[0])))); } return descriptor;
    });
    fs.closeSync = ((descriptor: number) => { if (descriptor === opened) closed++; nativeClose(descriptor); }); syncBuiltinESMExports();
    const { adapter, scratch } = fixture({ timing: { deadline: (): StoreDeadline => {
      if (stage === "acquire") throw new Error(FAULT);
      const controller = new AbortController(); const value = { signal: controller.signal, dispose: () => { disposed++; if (stage === "dispose") throw new Error(FAULT); } };
      if (stage === "signal") Object.defineProperty(value, "signal", { get: () => { throw new Error(FAULT); } });
      if (stage === "listeners") for (const name of ["addEventListener", "removeEventListener", "aborted"]) Object.defineProperty(value.signal, name, { get: () => { hooks++; throw new Error(FAULT); } });
      return value;
    } }, packCheckpoint: (event: GitPackCheckpoint) => { if (event.pid !== undefined) pid = event.pid; return Promise.resolve(); } });
    scratch.seed(candidate().files);
    try {
      const result = await settle(adapter.read());
      if (stage === "listeners") expect(result.error).toBeUndefined(); else expect(cleanError(result.error)).toContain("store-operation-failed");
      expect(opened).toBeDefined(); expect(closed).toBe(1); expect(disposed).toBe(stage === "acquire" ? 0 : 1); expect(hooks).toBe(0);
      const stoppedPid = pid; if (stoppedPid !== undefined) expect(() => process.kill(stoppedPid, 0)).toThrow();
      await adapter.close(); expect(root).toBeDefined(); expect(existsSync(root ?? "")).toBe(false);
    } finally { await adapter.close(); fs.openSync = nativeOpen; fs.closeSync = nativeClose; syncBuiltinESMExports(); }
  });
  it.each(["reject", "abort"] as const)("a throwing native listener-removal hook during %s settles fixed read and close outcomes with every acquired pack released", async (point) => {
    let object: object | null = AbortSignal.prototype; let hook: symbol | undefined;
    while (object !== null && hook === undefined) { hook = Object.getOwnPropertySymbols(object).find((key) => key.description === "kRemoveListener"); object = Object.getPrototypeOf(object) as object | null; }
    if (hook === undefined) throw new Error("native removal-hook fixture unavailable");
    const removedHook = hook; const entered = gate(); const held = gate(); let signal: AbortSignal | undefined; let removed = 0; let unhandled = 0;
    const observe = () => { unhandled++; }; process.on("unhandledRejection", observe);
    const nativeSpawn = childProcess.spawnSync; let root: string | undefined; let disposed = 0;
    childProcess.spawnSync = ((command: string, args: readonly string[] = [], options?: SpawnSyncOptionsWithBufferEncoding) => {
      if (command !== "git") throw new Error("unexpected fixture subprocess");
      if (args.includes("init") && typeof options?.cwd === "string") { root = options.cwd; fs.mkdirSync(`${String(args.at(-1))}/objects/pack`, { recursive: true }); }
      else if (!args.includes("ls-remote")) throw new Error("unexpected native-free fixture command");
      const stdout = Buffer.from(args.includes("ls-remote") ? `${"1".repeat(40)}\trefs/heads/pixelwatch-data\n` : "");
      return { pid: 1, output: [null, stdout, Buffer.alloc(0)], stdout, stderr: Buffer.alloc(0), status: 0, signal: null };
    }) as typeof childProcess.spawnSync; syncBuiltinESMExports();
    const adapter = new GitBranchStore({ remote: "https://github.com/fixture/review.git", repositoryId: REPOSITORY_ID, defaultBranch: "main",
      timing: { deadline: () => ({ signal: new AbortController().signal, dispose: () => { disposed++; } }) }, packTransport: { request: (request) => {
        signal = request.signal; Object.defineProperty(signal, removedHook, { configurable: true, value: () => { removed++; throw new Error(FAULT); } }); entered.release();
        return point === "reject" ? Promise.reject(new Error("fixed-input-rejection")) : held.pending.then(() => { throw new Error(FAULT); });
      } } }); adapters.push(adapter);
    let readSettled = false; const pending = settle(adapter.read()).then((result) => { readSettled = true; return result; });
    try {
      await entered.pending; if (point === "abort") await adapter.close();
      for (let step = 0; step < 64; step++) await Promise.resolve(); expect(readSettled).toBe(true);
      const result = await pending; expect(cleanError(result.error)).toContain("store-operation-failed"); expect(removed).toBe(1); expect(unhandled).toBe(0);
      await adapter.close(); expect(disposed).toBe(1); expect(getEventListeners(signal ?? new AbortController().signal, "abort")).toHaveLength(0);
      expect(root).toBeDefined(); expect(existsSync(root ?? "")).toBe(false);
    } finally { held.release(); if (signal !== undefined) Reflect.deleteProperty(signal, removedHook); await adapter.close(); childProcess.spawnSync = nativeSpawn; syncBuiltinESMExports(); process.removeListener("unhandledRejection", observe); }
  });
});

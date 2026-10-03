import childProcess, { spawn, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpPackTransport, terminateChildTree } from "../src/transport.ts";
import { GitBranchStore } from "../src/index.ts";
import { candidate, REPOSITORY_ID, Scratch } from "./helpers.ts";

afterEach(() => { vi.unstubAllGlobals(); });
describe("bounded Git pack transport (M2.2)", () => {
  it("uses one manual redirect POST and streams response bytes without exposing native credentials", async () => {
    const seen: { url: unknown; options: unknown }[] = []; const controller = new AbortController(); const canary = "fake-canary-token";
    vi.stubGlobal("fetch", (url: unknown, options: unknown) => { seen.push({ url, options }); return Promise.resolve(new Response(Uint8Array.of(1, 2), { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } })); });
    const result = await httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: { Authorization: canary }, signal: controller.signal });
    expect(result.status).toBe(200); expect(seen).toHaveLength(1); expect(seen[0]?.options).toMatchObject({ method: "POST", redirect: "manual", signal: controller.signal });
    const chunks: number[] = []; for await (const chunk of result.body) chunks.push(...chunk); expect(chunks).toEqual([1, 2]); expect(JSON.stringify(result)).not.toContain(canary);
  });
  it("terminates the isolated subprocess and its live descendant on Windows or a Unix process group", async () => {
    const scratch = new Scratch(); const socket = process.platform === "win32" ? `\\\\.\\pipe\\${basename(scratch.root)}-child` : join(scratch.root, "child.sock");
    const grandchild = "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready\\n'));";
    const parent = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{windowsHide:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>process.stdout.write(JSON.stringify({parent:process.pid,descendant:c.pid})+'\\n'));process.stdin.resume();`;
    const child = spawn(process.execPath, ["-e", parent, socket], { env: scratch.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close"); let pid: number | undefined;
    try {
      const ready = await new Promise<{ parent: number; descendant: number }>((resolve, reject) => { child.once("error", reject); child.stdout.once("data", (bytes: Buffer) => { resolve(JSON.parse(bytes.toString("utf8")) as { parent: number; descendant: number }); }); });
      pid = ready.parent; expect(ready.parent).toBe(child.pid); expect(() => process.kill(ready.descendant, 0)).not.toThrow();
      terminateChildTree(ready.parent, scratch.env); await closed; expect(() => process.kill(ready.parent, 0)).toThrow();
      expect(() => process.kill(ready.descendant, 0)).toThrow();
    } finally { if (pid !== undefined && child.exitCode === null && child.signalCode === null) terminateChildTree(pid, scratch.env); child.stdin.destroy(); child.stdout.destroy(); scratch.close(); }
  });
  it("cancels rejected Git pack response bodies before disposing the transfer deadline", async () => {
    for (const response of [{ status: 302, contentType: "application/x-git-upload-pack-result" }, { status: 200, contentType: "text/plain" }]) {
      const scratch = new Scratch(); const want = scratch.seed(candidate().files); const controller = new AbortController(); const observations: string[] = []; let reads = 0; let requests = 0;
      const nativeSpawn = childProcess.spawnSync;
      childProcess.spawnSync = ((command: string, args: readonly string[] = [], options?: SpawnSyncOptionsWithBufferEncoding) => {
        if (command !== "git") throw new Error("unexpected fixture subprocess");
        if (args.includes("ls-remote")) return { pid: 1, output: [null, Buffer.from(`${want}\trefs/heads/pixelwatch-data\n`), Buffer.alloc(0)], stdout: Buffer.from(`${want}\trefs/heads/pixelwatch-data\n`), stderr: Buffer.alloc(0), status: 0, signal: null };
        if (args.some((arg) => arg.startsWith("https://"))) throw new Error("external Git forbidden in fixture"); return nativeSpawn(command, args, options);
      }) as typeof childProcess.spawnSync; syncBuiltinESMExports();
      vi.stubGlobal("fetch", (_url: unknown, options: RequestInit) => {
        requests++; expect(options.redirect).toBe("manual");
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(Uint8Array.of(1)); }, pull: () => { reads++; }, cancel: () => { observations.push("body-cancelled"); } }), { status: response.status, headers: { "content-type": response.contentType, location: "https://signed.invalid/?token=fake-canary-token" } }));
      });
      const adapter = new GitBranchStore({ remote: "https://github.com/fixture/review.git", repositoryId: REPOSITORY_ID, defaultBranch: "main", token: "fake_canary_token", timing: { deadline: (milliseconds) => {
        expect(milliseconds).toBe(60_000); return { signal: controller.signal, dispose: () => { observations.push("deadline-disposed"); } };
      } } });
      try {
        await expect(adapter.read()).rejects.toThrow("git-pack-response-invalid"); expect(observations).toEqual(["body-cancelled", "deadline-disposed"]); expect(reads).toBe(0); expect(requests).toBe(1); expect(controller.signal.aborted).toBe(false);
      } finally { childProcess.spawnSync = nativeSpawn; syncBuiltinESMExports(); vi.unstubAllGlobals(); await adapter.close(); scratch.close(); }
    }
  });
  it("bounds rejected-body cleanup by the injected deadline and refuses a null pack body", async () => {
    const controller = new AbortController(); let cancelled = 0;
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(Uint8Array.of(1)); }, cancel: () => {
      cancelled++; queueMicrotask(() => { controller.abort("fake-canary-token https://signed.invalid/?token=fake-canary-token"); }); return new Promise<void>(() => {});
    } }), { status: 302, headers: { "content-type": "application/x-git-upload-pack-result" } })));
    await expect(httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: {}, signal: controller.signal })).rejects.toThrow("git-pack-response-invalid");
    expect(cancelled).toBe(1); expect(controller.signal.aborted).toBe(true);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null, { status: 200, headers: { "content-type": "application/x-git-upload-pack-result" } })));
    await expect(httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: {}, signal: new AbortController().signal })).rejects.toThrow("git-pack-response-invalid");
  });
  it("keeps the deadline active when rejected-body cancellation fails and sanitizes native fetch errors", async () => {
    const controller = new AbortController(); let finish: (() => void) | undefined; let failed = false; let settled = false;
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(Uint8Array.of(1)); }, cancel: () => {
      return new Promise<void>((_resolve, reject) => { finish = () => { failed = true; reject(new Error("fake-canary-token https://signed.invalid/?token=fake-canary-token")); }; });
    } }), { status: 302, headers: { "content-type": "application/x-git-upload-pack-result" } })));
    const result = httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: {}, signal: controller.signal }).then(() => "unexpected success", (error: unknown) => { settled = true; return (error as Error).message; });
    // Explicit microtask steps exercise the rejected cancel independently from the injected abort.
    for (let step = 0; step < 10 && finish === undefined; step++) await Promise.resolve();
    expect(finish).toBeDefined(); finish?.(); for (let step = 0; step < 10; step++) await Promise.resolve();
    expect(failed).toBe(true); expect(settled).toBe(false); controller.abort(); expect(await result).toBe("pixelwatch-store: git-pack-response-invalid");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("fake-canary-token https://signed.invalid/?token=fake-canary-token")));
    await expect(httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: {}, signal: new AbortController().signal })).rejects.toThrow("pixelwatch-store: store-operation-failed");
  });
});

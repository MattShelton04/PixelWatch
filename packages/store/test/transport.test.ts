import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpPackTransport, terminateChildTree } from "../src/transport.ts";
import { Scratch } from "./helpers.ts";

afterEach(() => { vi.unstubAllGlobals(); });
describe("bounded Git pack transport (M2.2)", () => {
  it("uses one manual redirect POST and streams response bytes without exposing native credentials", async () => {
    const seen: { url: unknown; options: unknown }[] = []; const controller = new AbortController(); const canary = "fake-canary-token";
    vi.stubGlobal("fetch", (url: unknown, options: unknown) => { seen.push({ url, options }); return Promise.resolve(new Response(Uint8Array.of(1, 2), { status: 302, headers: { location: "https://signed.invalid/?token=fake-canary-token", "content-type": "application/x-git-upload-pack-result" } })); });
    const result = await httpPackTransport.request({ url: "https://github.com/o/r.git/git-upload-pack", body: Uint8Array.of(0), headers: { Authorization: canary }, signal: controller.signal });
    expect(result.status).toBe(302); expect(seen).toHaveLength(1); expect(seen[0]?.options).toMatchObject({ method: "POST", redirect: "manual", signal: controller.signal });
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
});

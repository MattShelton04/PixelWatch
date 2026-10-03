import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { refuse } from "./types.ts";

export interface PackRequest { readonly url: string; readonly body: Uint8Array; readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }
export interface PackResponse { readonly status: number; readonly contentType: string; readonly body: AsyncIterable<Uint8Array> }
export interface PackTransport { request(request: PackRequest): Promise<PackResponse> }
export interface StoreDeadline { readonly signal: AbortSignal; dispose(): void }
export interface StoreTiming { deadline(milliseconds: number): StoreDeadline }
export const defaultTiming: StoreTiming = { deadline: (milliseconds) => {
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, milliseconds);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); } };
} };
export const httpPackTransport: PackTransport = { request: async (request) => {
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: Uint8Array.from(request.body), redirect: "manual", signal: request.signal });
  const body = async function* (): AsyncGenerator<Uint8Array> {
    if (response.body === null) refuse("git-pack-response-invalid");
    const reader = response.body.getReader();
    try { for (;;) { const result = await reader.read(); if (result.done) return; yield result.value; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", body: body() };
} };
/** Only a directly spawned, isolated Git group's PID is passed here. No shell or caller-supplied command. */
export function terminateChildTree(pid: number, environment: NodeJS.ProcessEnv): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) refuse("git-child-stop-failed");
  if (process.platform === "win32") {
    const system = environment["SystemRoot"] ?? environment["SYSTEMROOT"] ?? environment["WINDIR"]; if (system === undefined) refuse("git-child-stop-failed");
    const result = spawnSync(join(system, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { env: environment, windowsHide: true, timeout: 10_000, maxBuffer: 8192 });
    if (result.status === 0 && result.error === undefined) return;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; } refuse("git-child-stop-failed");
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") refuse("git-child-stop-failed"); }
}

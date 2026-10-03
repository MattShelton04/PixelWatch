import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { guarded, refuse } from "./types.ts";

export interface PackRequest { readonly url: string; readonly body: Uint8Array; readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }
export interface PackResponse { readonly status: number; readonly contentType: string; readonly body: AsyncIterable<Uint8Array> }
export interface PackTransport { request(request: PackRequest): Promise<PackResponse> }
export interface StoreDeadline { readonly signal: AbortSignal; dispose(): void }
export interface StoreTiming { deadline(milliseconds: number): StoreDeadline }
export const defaultTiming: StoreTiming = { deadline: (milliseconds) => {
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, milliseconds);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); } };
} };
/** The caller's transfer deadline stays live while cleanup runs; native diagnostics stay private. */
async function cancelUntilDeadline(cancel: () => Promise<void>, signal: AbortSignal): Promise<void> {
  let aborted: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => { aborted = () => { resolve(); }; if (signal.aborted) resolve(); else signal.addEventListener("abort", aborted, { once: true }); });
  try {
    // A failed cancel cannot prove the native transfer closed. Keep its deadline until abort.
    let cancelled: Promise<void>; try { cancelled = cancel().catch(() => deadline); } catch { await deadline; return; }
    await Promise.race([cancelled, deadline]);
  } finally { if (aborted !== undefined) signal.removeEventListener("abort", aborted); }
}
export const httpPackTransport: PackTransport = { request: (request) => guarded(async () => {
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: Uint8Array.from(request.body), redirect: "manual", signal: request.signal });
  const contentType = response.headers.get("content-type") ?? ""; const stream = response.body;
  if (response.status !== 200 || contentType !== "application/x-git-upload-pack-result" || stream === null || request.signal.aborted) {
    if (stream !== null) await cancelUntilDeadline(() => stream.cancel(), request.signal);
    refuse("git-pack-response-invalid");
  }
  const body = async function* (): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try { for (;;) { const result = await reader.read(); if (result.done) return; yield result.value; } }
    finally { await cancelUntilDeadline(() => reader.cancel(), request.signal); reader.releaseLock(); }
  };
  return { status: response.status, contentType, body: body() };
}) };
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

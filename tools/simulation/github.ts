import { canonicalJson } from "../../packages/schemas/src/index.ts";
import { Capture, CANARY_TOKEN, SIGNED_URL } from "./capture.ts";
import type { GitHubBody } from "./github-shapes.ts";
import { Clock } from "./schedule.ts";
export { CANARY_TOKEN, SIGNED_URL };
export const API = "https://api.simulation.invalid";
export const BLOB = "https://blob.simulation.invalid";
export interface Request { method: "GET" | "POST" | "PATCH"; url: string; headers?: Readonly<Record<string, string>>; body?: unknown }
export interface Reply { status: number; headers?: Readonly<Record<string, string>>; body?: GitHubBody }
export type ScriptedReply = Reply | (() => Reply);
function headers(input: Readonly<Record<string, string>> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (result[key] !== undefined) throw new Error("fixture-ambiguous-header");
    result[key] = value;
  }
  return result;
}
function key(request: Request): string {
  const url = new URL(request.url);
  if (![API, BLOB].includes(url.origin) || url.username || url.password || url.hash || request.method === "GET" && request.body !== undefined) throw new Error("fixture-invalid-request");
  return `${request.method} ${url.href} ${request.body === undefined ? "" : canonicalJson(request.body)}`;
}
export class FakeGitHub {
  readonly calls: { route: number; authorized: boolean; method: string }[] = [];
  #routes = new Map<string, { id: number; replies: ScriptedReply[] }>();
  route(request: Request, replies: readonly ScriptedReply[]): void {
    const k = key(request);
    if (this.#routes.has(k)) throw new Error("fixture-ambiguous-request");
    if (replies.length === 0) throw new Error("fixture-empty-request");
    for (const reply of replies) {
      if (typeof reply === "function") continue;
      if (!Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599) throw new Error("fixture-invalid-status");
      headers(reply.headers);
    }
    this.#routes.set(k, { id: this.#routes.size, replies: replies.map((r) => typeof r === "function" ? r : structuredClone(r)) });
  }
  request(request: Request): Reply {
    const h = headers(request.headers);
    const route = this.#routes.get(key(request));
    if (route === undefined) throw new Error("fixture-unknown-request");
    const reply = route.replies.shift();
    if (reply === undefined) throw new Error("fixture-exhausted-request");
    this.calls.push({ route: route.id, authorized: h["authorization"] !== undefined, method: request.method });
    // Callbacks can mutate fake state then throw a fixed unknown-outcome error. They never run I/O.
    const response = typeof reply === "function" ? reply() : reply;
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error("fixture-invalid-status");
    headers(response.headers);
    return structuredClone(response);
  }
  assertConsumed(): void {
    if ([...this.#routes.values()].some((r) => r.replies.length !== 0)) throw new Error("fixture-unconsumed-request");
  }
}
export type Download = { kind: "downloaded"; bytes: Uint8Array } | { kind: "missing"; reason: "expired" | "unavailable" | "retry-exhausted" | "redirect-refused" | "too-large" };
// Harness transport probe, deliberately not the M2.1 authenticated artifact downloader.
export function download(fake: FakeGitHub, input: string, clock: Clock, capture: Capture): Download {
  const start = new URL(input);
  if (start.origin !== API || !/^\/repos\/sim\/upstream\/actions\/artifacts\/[1-9]\d*\/zip$/.test(start.pathname) || start.search || start.username || start.password || start.hash) throw new Error("fixture-invalid-artifact-endpoint");
  let url = input;
  let authorization: string | undefined = `Bearer ${CANARY_TOKEN}`;
  let redirects = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (;;) {
      const response = fake.request({ method: "GET", url, headers: authorization === undefined ? {} : { authorization } });
      const h = headers(response.headers);
      capture.log(`download status=${String(response.status)}`);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (++redirects > 3 || h["location"] === undefined) return { kind: "missing", reason: "redirect-refused" };
        let next: URL;
        try { next = new URL(h["location"], url); } catch { return { kind: "missing", reason: "redirect-refused" }; }
        if (![API, BLOB].includes(next.origin) || next.username || next.password || next.hash) return { kind: "missing", reason: "redirect-refused" };
        if (next.origin !== new URL(url).origin) authorization = undefined;
        url = next.href;
        continue;
      }
      if (response.status === 200) {
        if (!(response.body instanceof Uint8Array)) throw new Error("fixture-expected-bytes");
        if (response.body.byteLength > 128 * 1024 * 1024) return { kind: "missing", reason: "too-large" };
        return { kind: "downloaded", bytes: response.body };
      }
      if (response.status === 410) return { kind: "missing", reason: "expired" };
      if (response.status === 429 || response.status === 403 && h["retry-after"] !== undefined || response.status >= 500) {
        if (attempt < 2) {
          const delay = h["retry-after"] ?? "1";
          if (!/^\d{1,3}$/.test(delay) || Number(delay) > 60) throw new Error("fixture-invalid-retry-after");
          clock.advance(Number(delay) * 1000);
        }
        break;
      }
      return { kind: "missing", reason: "unavailable" };
    }
  }
  return { kind: "missing", reason: "retry-exhausted" };
}

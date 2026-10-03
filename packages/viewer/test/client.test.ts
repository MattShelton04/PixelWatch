import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalBytes, parseDocument, type Changes, type Site } from "@pixelwatch/schemas";
import { imageUrl, loadViewerModel, readBootstrap, type ViewerClock } from "../src/client.ts";

const RELEASE = "0.1.0";
const BASE = "https://owner.github.io/repo/pixelwatch/";
const CANARY = "FAKE_VIEWER_CANARY";
const markers = () => ({ pwSite: BASE, pwRelease: RELEASE, pwRepositoryId: "987654321", pwOwner: "owner", pwRepo: "repo", pwRunKey: "10-a1" });
const bootstrap = (href = `${BASE}runs/10-a1/`) => readBootstrap(markers(), href, RELEASE);
const clock: ViewerClock = { deadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }) };
function fixture<K extends "site" | "changes">(kind: K): K extends "site" ? Site : Changes {
  const path = kind === "site" ? "site.json" : "api/v1/runs/10-a1/changes.json";
  const parsed = parseDocument(kind, readFileSync(new URL(`../../../testdata/projection/site/${path}`, import.meta.url)));
  if (!parsed.ok) throw new Error("invalid committed browser fixture");
  return parsed.value as K extends "site" ? Site : Changes;
}
const site = () => ({ ...fixture("site"), versions: { release: RELEASE, data: 1 as const, api: 1 as const } });
const response = (value: unknown) => new Response(Uint8Array.from(canonicalBytes(value)), { status: 200 });
class Requests {
  readonly calls: { url: string; init: RequestInit | undefined }[] = [];
  readonly replies: ((url: string, init?: RequestInit) => Promise<Response>)[] = [];
  add(value: Response | ((url: string, init?: RequestInit) => Promise<Response>)): this {
    this.replies.push(typeof value === "function" ? value : () => Promise.resolve(value)); return this;
  }
  readonly fetch: typeof fetch = (value, init) => {
    const url = typeof value === "string" ? value : value instanceof URL ? value.href : value.url; this.calls.push({ url, init }); const next = this.replies.shift();
    if (next === undefined) throw new Error(`unregistered fake response ${CANARY}`);
    return next(url, init);
  };
}
async function safeFailure(operation: Promise<unknown>): Promise<void> {
  let error: unknown; try { await operation; } catch (value) { error = value; }
  expect(error).toBeInstanceOf(Error); const raw = String(error) + JSON.stringify(error) + ((error as Error).stack ?? "");
  expect(raw).not.toContain(CANARY); expect(raw).not.toContain("signed.invalid"); expect((error as Error).cause).toBeUndefined();
}

describe("minimal final viewer client boundaries", () => {
  it("validates every generated bootstrap marker and the compiled release before transport", () => {
    const value = bootstrap(); expect(value.canonicalBase).toBe(BASE); expect(value.observedBase).toBe(BASE); expect(value.runKey).toBe("10-a1");
    const invalid = [{ pwSite: "javascript:alert(1)" }, { pwSite: `${BASE}../foreign/` }, { pwSite: `${BASE}?token=${CANARY}` }, { pwRelease: "0.2.0" }, { pwRelease: "../app" }, { pwOwner: "../owner" }, { pwRepo: "../repo" }, { pwRepositoryId: "0" }, { pwRepositoryId: "42e0" }, { pwRunKey: `../${CANARY}` }];
    for (const part of invalid) expect(() => readBootstrap({ ...markers(), ...part }, `${BASE}runs/10-a1/`, RELEASE)).toThrow();
    for (const key of ["pwSite", "pwRelease", "pwRepositoryId", "pwOwner", "pwRepo"] as const) {
      const missing: Record<string, string | undefined> = { ...markers(), [key]: undefined }; expect(() => readBootstrap(missing, BASE, RELEASE)).toThrow();
    }
    expect(() => readBootstrap(markers(), `${BASE}runs/11-a1/`, RELEASE)).toThrow();
  });

  it("requires the exact HTTPS production root while only literal HTTP loopback origins can remap it", () => {
    for (const href of ["http://127.0.0.1:1234/pixelwatch/runs/10-a1/", "http://localhost:1234/pixelwatch/runs/10-a1/", "http://[::1]:1234/pixelwatch/runs/10-a1/"]) expect(bootstrap(href).observedBase).toBe(new URL("../../", href).href);
    for (const href of ["https://other.invalid/pixelwatch/runs/10-a1/", "https://owner.github.io/other/pixelwatch/runs/10-a1/", "http://owner.github.io/repo/pixelwatch/runs/10-a1/", "http://127.0.0.2:1234/pixelwatch/runs/10-a1/", "http://localhost.evil.invalid:1234/pixelwatch/runs/10-a1/", "http://user:password@localhost:1234/pixelwatch/runs/10-a1/", "file:///tmp/pixelwatch/runs/10-a1/index.html"]) expect(() => bootstrap(href)).toThrow();
    expect(bootstrap("http://127.0.0.1:1234/runs/10-a1/").observedBase).toBe("http://127.0.0.1:1234/");
    expect(() => readBootstrap({ ...markers(), pwSite: "https://owner.github.io/" }, "https://owner.github.io/runs/10-a1/", RELEASE)).toThrow();
  });

  it("loads exactly one validated site and run through bounded credential-free fixed GET routes", async () => {
    const requests = new Requests().add(response(site())).add(response(fixture("changes"))); const value = bootstrap();
    const result = await loadViewerModel(value, { fetch: requests.fetch, clock }); expect(result.changes?.runKey).toBe("10-a1");
    expect(requests.calls.map((call) => call.url)).toEqual([`${BASE}site.json`, `${BASE}api/v1/runs/10-a1/changes.json`]);
    for (const call of requests.calls) { expect(call.init?.method).toBe("GET"); expect(call.init?.credentials).toBe("omit"); expect(call.init?.redirect).toBe("manual"); expect(call.init?.cache).toBe("no-cache"); expect(call.init?.signal).toBeInstanceOf(AbortSignal); }
  });

  it("maps the same fixed generated JSON paths to loopback without requesting remote Pages", async () => {
    const requests = new Requests().add(response(site())).add(response(fixture("changes")));
    const result = await loadViewerModel(bootstrap("http://127.0.0.1:1234/local/runs/10-a1/index.html"), { fetch: requests.fetch, clock }); expect(result.changes?.runKey).toBe("10-a1");
    expect(requests.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:1234/local/site.json", "http://127.0.0.1:1234/local/api/v1/runs/10-a1/changes.json"]);
  });

  it("copies validated bootstrap values before asynchronous loading can mutate caller inputs", async () => {
    const value = bootstrap(); const requests = new Requests().add(() => { Object.assign(value, { runKey: `99-${CANARY}`, observedBase: `https://signed.invalid/?token=${CANARY}` }); return Promise.resolve(response(site())); }).add(response(fixture("changes")));
    expect((await loadViewerModel(value, { fetch: requests.fetch, clock })).changes?.runKey).toBe("10-a1");
    expect(requests.calls[1]?.url).toBe(`${BASE}api/v1/runs/10-a1/changes.json`);
  });

  it("refuses unknown site versions release or repository mismatches before any run request", async () => {
    for (const value of [{ ...site(), schemaVersion: 2 }, { ...site(), repositoryId: "1" }, { ...site(), versions: { release: "0.2.0", data: 1, api: 1 } }, { ...site(), basePath: "other" }, { ...site(), appUrl: `https://signed.invalid/?token=${CANARY}` }]) {
      const requests = new Requests().add(response(value)); await safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock })); expect(requests.calls).toHaveLength(1);
    }
  });

  it("refuses unknown malformed duplicate-key and mismatched run JSON before image display", async () => {
    const changes = fixture("changes");
    const values = [{ ...changes, schemaVersion: 2 }, { ...changes, source: { ...changes.source, repositoryId: "1" } }, { ...changes, runKey: "11-a1", source: { ...changes.source, runId: "11" } }, { ...changes, appUrl: `https://signed.invalid/?token=${CANARY}` }];
    for (const value of values) { const requests = new Requests().add(response(site())).add(response(value)); await safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock })); expect(requests.calls).toHaveLength(2); }
    for (const bytes of ['{"schemaVersion":1,"schemaVersion":1}', `{"__proto__":{"token":"${CANARY}"}}`, "{bad}"]) {
      const requests = new Requests().add(response(site())).add(new Response(bytes, { status: 200 })); await safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock }));
    }
  });

  it("cancels non-200 response bodies before disposing their bounded request deadline", async () => {
    for (const status of [302, 404, 503]) {
      const events: string[] = []; const controller = new AbortController(); const deadline: ViewerClock = { deadline: () => ({ signal: controller.signal, dispose: () => { events.push("disposed"); } }) };
      const body = new ReadableStream<Uint8Array>({ cancel: () => { events.push("cancelled"); } });
      const requests = new Requests().add(new Response(body, { status, headers: { location: `https://signed.invalid/?token=${CANARY}` } }));
      await safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock: deadline })); expect(events).toEqual(["cancelled", "disposed"]); expect(requests.calls).toHaveLength(1);
    }
  });

  it("bounds streamed JSON to one MiB and cancels the reader before accepting excess bytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(Uint8Array.of(32)); }, cancel: () => { cancelled = true; } });
    const requests = new Requests().add(new Response(stream, { status: 200 })); await safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock })); expect(cancelled).toBe(true); expect(requests.calls).toHaveLength(1);
    const exact = new TextDecoder().decode(canonicalBytes(site())).padEnd(1024 * 1024, " ");
    const bounded = new Requests().add(new Response(exact, { status: 200 })).add(response(fixture("changes")));
    expect((await loadViewerModel(bootstrap(), { fetch: bounded.fetch, clock })).changes?.runKey).toBe("10-a1");
  });

  it("an injected request deadline fails even when fake transport ignores abort without echoing its reason", async () => {
    const controller = new AbortController(); let reached: (() => void) | undefined; const requestReached = new Promise<void>((resolve) => { reached = resolve; }); let disposed = 0;
    const requests = new Requests().add(() => { reached?.(); return new Promise<Response>(() => {}); });
    const pending = loadViewerModel(bootstrap(), { fetch: requests.fetch, clock: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) } });
    await requestReached; controller.abort(`${CANARY} https://signed.invalid/?token=${CANARY}`); await safeFailure(pending); expect(disposed).toBe(1);
  });

  it("an injected deadline also bounds a refused body whose cancellation never resolves", async () => {
    const controller = new AbortController(); let reached: (() => void) | undefined; const cancellationReached = new Promise<void>((resolve) => { reached = resolve; }); let disposed = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel: () => { reached?.(); return new Promise<void>(() => {}); } });
    const requests = new Requests().add(new Response(stream, { status: 302 }));
    const pending = loadViewerModel(bootstrap(), { fetch: requests.fetch, clock: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) } });
    await cancellationReached; controller.abort(CANARY); await safeFailure(pending); expect(disposed).toBe(1);
  });

  it("keeps the request deadline active when native body cancellation rejects", async () => {
    const controller = new AbortController(); let cancelled = 0; let disposed = 0; let settled = false;
    const body = new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(Uint8Array.of(1)); }, cancel: () => { cancelled++; return Promise.reject(new Error(`${CANARY} https://signed.invalid/?token=${CANARY}`)); } });
    const requests = new Requests().add(new Response(body, { status: 302 }));
    const pending = safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) } })).then(() => { settled = true; });
    for (let step = 0; step < 50; step++) await Promise.resolve();
    const beforeAbort = { cancelled, disposed, settled, aborted: controller.signal.aborted };
    controller.abort(CANARY); await pending;
    expect(beforeAbort).toEqual({ cancelled: 1, disposed: 0, settled: false, aborted: false }); expect(disposed).toBe(1); expect(requests.calls).toHaveLength(1);
  });

  it("cancels a transport response arriving after the request deadline without parsing or echoing it", async () => {
    const controller = new AbortController(); let deliver: ((response: Response) => void) | undefined; let reached: (() => void) | undefined;
    const requestReached = new Promise<void>((resolve) => { reached = resolve; }); let cancelled = 0; let disposed = 0;
    const requests = new Requests().add(() => { reached?.(); return new Promise<Response>((resolve) => { deliver = resolve; }); });
    const pending = safeFailure(loadViewerModel(bootstrap(), { fetch: requests.fetch, clock: { deadline: () => ({ signal: controller.signal, dispose: () => { disposed++; } }) } }));
    await requestReached; controller.abort(CANARY); await pending;
    if (deliver === undefined) throw new Error("fake request delivery not reached");
    deliver(new Response(new ReadableStream<Uint8Array>({ start: (stream) => { stream.enqueue(new TextEncoder().encode(CANARY)); }, cancel: () => { cancelled++; return Promise.reject(new Error(`${CANARY} https://signed.invalid/?token=${CANARY}`)); } }), { status: 200 }));
    for (let step = 0; step < 50; step++) await Promise.resolve();
    expect(cancelled).toBe(1); expect(disposed).toBe(1); expect(requests.calls).toHaveLength(1);
  });

  it("image mapping requires the exact captured-side pixel hash pool fanout and canonical site namespace", () => {
    const value = bootstrap("http://127.0.0.1:1234/local/runs/10-a1/"); const hash = "a".repeat(64); const side = { state: "captured" as const, pixelHash: hash, width: 4, height: 4 };
    expect(imageUrl(value, side, `${BASE}blobs/aa/${hash}.png`)).toBe(`http://127.0.0.1:1234/local/blobs/aa/${hash}.png`);
    expect(imageUrl(value, side, undefined)).toBeUndefined();
    for (const url of [`${BASE}blobs/bb/${hash}.png`, `${BASE}blobs/aa/${"b".repeat(64)}.png`, `${BASE}derived/aa/${hash}.png`, `https://owner.github.io/other/blobs/aa/${hash}.png`, `https://evil.invalid/blobs/aa/${hash}.png`, `${BASE}blobs/aa/${hash}.png?token=${CANARY}`, `${BASE}blobs/aa/${hash}.png#fragment`, `${BASE}blobs/aa/../${hash}.png`, "javascript:alert(1)"]) expect(() => imageUrl(value, side, url)).toThrow();
  });
});

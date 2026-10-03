import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addRun, blobPath, encodePng, newStore, prPointerPath, runRecordPath, siteLocation, siteUrls } from "@pixelwatch/core";
import { canonicalBytes, parseDocument, type Run } from "@pixelwatch/schemas";
import { ForgeError, type HttpRequest, type HttpResponse, type HttpTransport, type Timing } from "@pixelwatch/forge-github";
import type { StoreSnapshot } from "@pixelwatch/store";
import { buildViewerAssets } from "../../../tools/viewer/build.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { assembleSite } from "../src/assemble.ts";
import { waitForReadiness } from "../src/readiness.ts";
import { MAX_ASSEMBLED_FILES } from "../src/readiness-input.ts";
import { PublisherError, type PublisherContext, type ReadinessDependencies, type ReadinessInput, type ReadinessPoll, type ReadinessResult } from "../src/types.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const raw: (string | Uint8Array)[] = [];
let script: Uint8Array;
beforeAll(async () => {script = (await buildViewerAssets("0.1.0-rc.1")).script;});
afterEach(() => {try {assertNoSecrets(raw.splice(0));} finally {vi.restoreAllMocks();}});
function required<T>(value: T | undefined): T {if (value === undefined) throw new Error("readiness-fixture-missing"); return value;}
async function fixture(count = 2, pagesUrl = "https://owner.github.io/repo/", prefix = "pixelwatch") {
  const parsed = parseDocument("run", readFileSync(new URL("../../../testdata/schemas/run/valid/all-eight-statuses.json", import.meta.url)));
  if (!parsed.ok) throw new Error("readiness-fixture-invalid");
  let store = newStore(parsed.value.source.repositoryId); const runs = new Map<string, Run>(); const files = new Map<string, Uint8Array>();
  const png = encodePng({width: 4, height: 4, channels: 3, data: new Uint8Array(48).fill(125)});
  const targets: ReadinessInput["targets"][number][] = [];
  for (let index = 0; index < count; index++) {
    const run = structuredClone(parsed.value); const id = String(36405830015 + index);
    run.runKey = id + "-a2"; run.source.runId = id;
    run.source.association = {status: "corroborated", prNumber: String(7 + index)};
    store = addRun(store, run).store; runs.set(run.runKey, run); files.set(runRecordPath(run.runKey), canonicalBytes(run));
    // Existing publisher-owned pixel blobs are structurally validated and reused, never decoded
    // or rehashed (ADR0010). These synthetic readiness fixtures do not claim live capture parity.
    for (const result of run.results) for (const side of [result.base, result.head]) if (side.state === "captured") files.set(blobPath(side.pixelHash), png);
    targets.push({prNumber: String(7 + index), runKey: run.runKey, headSha: required(run.source.commits.head)});
  }
  files.set("store.json", canonicalBytes(store));
  const snapshot: StoreSnapshot = {tip: "5".repeat(40), store, runs, files: [...files].map(([path, bytes]) => ({path, bytes: bytes.byteLength})), readFile: (path) => Promise.resolve(required(files.get(path)))};
  const context: PublisherContext = {config: {schemaVersion: 1, source: {workflowIds: ["123456"], events: ["push", "pull_request"]}, providers: [{id: "fixture", shards: 1}], store: {prefix}}, configCommit: "3".repeat(40), pages: {url: pagesUrl, host: "owner.github.io"}, repository: {repositoryId: store.repositoryId, owner: "owner", name: "repo"}, assets: {release: "0.1.0-rc.1", releaseCommit: "4".repeat(40), script}};
  const site = await assembleSite({...context, snapshot}); raw.push(...site.files.map(file => file.bytes));
  return {input: {context, site, targets} satisfies ReadinessInput, files};
}
class VirtualTiming implements Timing {
  now = 0; started: number[] = []; disposed: number[] = []; delays: number[] = [];
  #handles = new Map<number, {due: number; controller: AbortController}>(); #next = 0;
  delayHook?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const handle of this.#handles.values()) if (this.now >= handle.due) handle.controller.abort();
  }
  deadline(milliseconds: number) {
    const id = this.#next++; const controller = new AbortController(); this.started.push(milliseconds);
    this.#handles.set(id, {due: this.now + milliseconds, controller});
    return {signal: controller.signal, dispose: () => {expect(this.#handles.delete(id)).toBe(true); this.disposed.push(milliseconds);}};
  }
  delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    this.delays.push(milliseconds);
    if (this.delayHook !== undefined) return this.delayHook(milliseconds, signal);
    this.advance(milliseconds); return Promise.resolve();
  }
  clean(): void {expect(this.#handles.size).toBe(0); expect(this.disposed.length).toBe(this.started.length);}
}
class ScriptTransport implements HttpTransport {
  readonly expected: Map<string, Uint8Array>; calls: {method: string; url: string; headers: Record<string, string>; maxBytes: number}[] = []; poll = 0;
  reply?: (request: HttpRequest, poll: number) => HttpResponse | Promise<HttpResponse>;
  constructor(input: ReadinessInput) {
    const urls = siteUrls(siteLocation(input.context.config, input.context.pages));
    this.expected = new Map(input.site.files.filter(file => file.path === "site.json" || input.targets.some(target => file.path === prPointerPath(target.prNumber))).map(file => [urls.url(file.path), new Uint8Array(file.bytes)]));
  }
  request(request: HttpRequest): Promise<HttpResponse> {
    if (request.url.endsWith("/site.json")) this.poll++;
    this.calls.push({method: request.method, url: request.url, headers: {...request.headers}, maxBytes: request.maxBytes});
    const reply = this.reply?.(request, this.poll) ?? this.match(request);
    return Promise.resolve(reply);
  }
  match(request: HttpRequest): HttpResponse {return {status: 200, headers: {}, body: new Uint8Array(required(this.expected.get(request.url)))};}
}
function setup(input: ReadinessInput) {
  const timing = new VirtualTiming(); const transport = new ScriptTransport(input); const observed: ReadinessPoll[] = [];
  const dependencies = {transport, timing, now: () => timing.now, checkpoint: (poll: ReadinessPoll) => {observed.push({...poll}); return Promise.resolve();}} satisfies ReadinessDependencies;
  return {timing, transport, dependencies, observed};
}
async function run(input: ReadinessInput, dependencies: ReadinessDependencies): Promise<ReadinessResult> {
  const result = await waitForReadiness(input, dependencies); raw.push(JSON.stringify(result)); assertNoSecrets(raw); return result;
}
async function refuses(input: ReadinessInput, deps: ReadinessDependencies, code?: string) {
  let caught: unknown; try {await run(input, deps);} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(PublisherError); const error = caught as PublisherError;
  if (code !== undefined) expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined(); const text = [String(error), JSON.stringify(error), error.stack ?? ""].join("\n"); raw.push(text); assertNoSecrets(raw);
}
function replace(input: ReadinessInput, path: string, mutate: (bytes: Uint8Array) => Uint8Array): ReadinessInput {
  return {...input, site: {...input.site, files: input.site.files.map(file => file.path === path ? {...file, bytes: mutate(file.bytes)} : file)}};
}
function jsonBody(response: HttpResponse, change: (value: Record<string, unknown>) => void): HttpResponse {
  const value = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>; change(value);
  return {...response, body: canonicalBytes(value)};
}
function brokenListeners(signal: AbortSignal): void {
  const key = required(Object.getOwnPropertySymbols(signal).find(key => String(key) === "Symbol(kEvents)"));
  Object.defineProperty(signal, key, {value: null});
}
describe("observed served readiness", () => {
  it("requires three complete matching site and PR pointer polls at least ten seconds apart", async () => {
    const w = await fixture(); const s = setup(w.input); const result = await run(w.input, s.dependencies);
    expect(result).toMatchObject({status: "served", reason: "ready", generation: w.input.site.generation, pollCount: 3, consecutivePasses: 3, elapsedMilliseconds: 20_000});
    expect(result.polls.map(p => p.startedMilliseconds)).toEqual([0, 10_000, 20_000]);
    expect(result.polls.every(p => p.passed && p.code === "matched")).toBe(true); expect(s.transport.calls.length).toBe(9);
    expect(s.timing.delays).toEqual([10_000, 10_000]); expect(s.timing.started[0]).toBe(600_000); expect(s.timing.started.slice(1)).toEqual(new Array(9).fill(60_000)); s.timing.clean();
  });
  it("resets readiness after stale generation mixed pointer wrong digest and cached 404", async () => {
    const w = await fixture(); const s = setup(w.input); const reached = {old: 0, mixed: 0, digest: 0, missing: 0, regressed: 0};
    s.transport.reply = (request, poll) => {
      const response = s.transport.match(request);
      if (poll === 1 && request.url.endsWith("/site.json")) {reached.old++; return jsonBody(response, v => {v["generation"] = "a".repeat(64);});}
      if (poll === 2 && request.url.endsWith("/7/latest.json")) {reached.mixed++; return jsonBody(response, v => {v["runKey"] = "1-a1";});}
      if (poll === 3 && request.url.endsWith("/site.json")) {reached.digest++; return {...response, body: new TextEncoder().encode(new TextDecoder().decode(response.body) + "\n")};}
      if (poll === 4 && request.url.endsWith("/site.json")) {reached.missing++; return {...response, status: 404};}
      if (poll === 6 && request.url.endsWith("/8/latest.json")) {reached.regressed++; return jsonBody(response, v => {v["generation"] = "b".repeat(64);});}
      return response;
    };
    const result = await run(w.input, s.dependencies);
    expect(result.status).toBe("served"); expect(result.pollCount).toBe(9);
    expect(result.polls.map(p => p.passed)).toEqual([false, false, false, false, true, false, true, true, true]);
    expect(result.polls.map(p => p.code)).toEqual(["generation-mismatch", "pointer-mismatch", "digest-mismatch", "http-status", "matched", "generation-mismatch", "matched", "matched", "matched"]);
    expect(reached).toEqual({old: 1, mixed: 1, digest: 1, missing: 1, regressed: 1}); s.timing.clean();
  });
  it("authenticates every selected PR pointer against exact assembled bytes", async () => {
    const w = await fixture(3); const s = setup(w.input); let last = 0;
    s.transport.reply = (request, poll) => {const response = s.transport.match(request); if (request.url.endsWith("/9/latest.json") && poll === 1) {last++; return jsonBody(response, v => {v["headSha"] = "a".repeat(40);});} return response;};
    const result = await run(w.input, s.dependencies);
    expect(result.pollCount).toBe(4); expect(result.polls[0]?.code).toBe("pointer-mismatch"); expect(last).toBe(1);
    for (const target of w.input.targets) expect(s.transport.calls.filter(call => call.url.endsWith("/" + target.prNumber + "/latest.json")).length).toBe(4); s.timing.clean();
  });
  it("derives readiness URLs only from captured trusted Pages context", async () => {
    for (const [pages, prefix] of [["https://owner.github.io/", "pixelwatch"], ["https://owner.github.io/repo/", "pixelwatch"], ["https://owner.github.io/repo/", "reports/nested/visual"]] as const) {
      const w = await fixture(1, pages, prefix); const s = setup(w.input); let methods = 0;
      Object.defineProperty(w.input.site, "urls", {get() {methods++; throw new Error(SIGNED_URL);}});
      expect((await run(w.input, s.dependencies)).status).toBe("served"); expect(methods).toBe(0);
      expect(s.transport.calls.map(call => call.url)).toEqual(new Array(3).fill([pages + prefix + "/site.json", pages + prefix + "/api/v1/pr/7/latest.json"]).flat());
      for (const call of s.transport.calls) {expect(call.method).toBe("GET"); expect(call.maxBytes).toBe(1_048_576); expect(Object.keys(call.headers).map(key => key.toLowerCase())).not.toContain("authorization"); expect(Object.keys(call.headers).map(key => key.toLowerCase())).not.toContain("cookie"); expect(call.url).not.toContain("?");}
      s.timing.clean();
    }
  });
  it("captures assembled bytes targets transport and timing once before asynchronous polling", async () => {
    const w = await fixture(); const s = setup(w.input); const counts = {context: 0, site: 0, targets: 0, files: 0, map: 0, iterator: 0, request: 0, deadline: 0, delay: 0, now: 0, bind: 0};
    const sourceFiles = w.input.site.files;
    const listing = new Proxy(sourceFiles, {get(target, key, receiver) {if (key === "map") {counts.map++; throw new Error(CANARY_TOKEN);} if (key === Symbol.iterator) {counts.iterator++; throw new Error(CANARY_TOKEN);} const value: unknown = Reflect.get(target, key, receiver); return value;}});
    const sourceSite = {...w.input.site, get files() {counts.files++; return listing;}};
    const input = {get context() {counts.context++; return w.input.context;}, get site() {counts.site++; return sourceSite;}, get targets() {counts.targets++; return w.input.targets;}};
    const request = (value: HttpRequest) => {if (s.transport.calls.length === 0) {for (const file of sourceFiles) if (file.path === "site.json") file.bytes.fill(32); Object.assign(w.input.targets[0] ?? {}, {runKey: "1-a1"}); Object.assign(w.input.context.pages, {url: SIGNED_URL});} return s.transport.request(value);};
    const deadline = (ms: number) => s.timing.deadline(ms); const delay = (ms: number, signal?: AbortSignal) => s.timing.delay(ms, signal); const now = () => s.timing.now;
    for (const fn of [request, deadline, delay, now]) Object.defineProperty(fn, "bind", {get() {counts.bind++; throw new Error(CANARY_TOKEN);}});
    const deps: ReadinessDependencies = {transport: {get request() {counts.request++; return request;}}, timing: {get deadline() {counts.deadline++; return deadline;}, get delay() {counts.delay++; return delay;}}, get now() {counts.now++; return now;}};
    expect((await run(input, deps)).status).toBe("served"); expect(counts).toEqual({context: 1, site: 1, targets: 1, files: 1, map: 0, iterator: 0, request: 1, deadline: 1, delay: 1, now: 1, bind: 0}); s.timing.clean();
  });
  it("refuses unknown expected document versions and mismatched generation identity before requests", async () => {
    const original = await fixture();
    const variants: ReadinessInput[] = [];
    for (const path of ["site.json", prPointerPath("7")]) {
      const changed = replace(original.input, path, bytes => jsonBody({status: 200, headers: {}, body: bytes}, value => {value["schemaVersion"] = 2;}).body);
      variants.push({...changed, site: {...changed.site, files: changed.site.files.map(file => file.path === path ? {...file, sha256: hash(file.bytes)} : file)}});
    }
    variants.push({...original.input, site: {...original.input.site, generation: "a".repeat(64)}});
    variants.push({...original.input, site: {...original.input.site, storeTip: "not-a-tip"}});
    variants.push({...original.input, context: {...original.input.context, repository: {...original.input.context.repository, repositoryId: "1"}}});
    variants.push({...original.input, targets: [{...required(original.input.targets[0]), runKey: "1-a1"}]});
    for (const input of variants) {const s = setup(original.input); await refuses(input, s.dependencies, "readiness-input-invalid"); expect(s.transport.calls).toEqual([]); expect(s.timing.started).toEqual([]);}
  });
  it("bounded request and overall deadlines settle ignored transport and delay signals", async () => {
    const w = await fixture(); const s = setup(w.input); let requestFault = 0;
    s.transport.reply = request => {if (requestFault === 0) {requestFault++; s.timing.advance(60_000); return new Promise<HttpResponse>(() => undefined);} return s.transport.match(request);};
    const recovered = await run(w.input, s.dependencies); expect(recovered.status).toBe("served"); expect(recovered.polls[0]?.code).toBe("request-timeout"); expect(requestFault).toBe(1); s.timing.clean();
    const d = setup(w.input); let delayFault = 0; d.transport.reply = request => ({...d.transport.match(request), status: 404});
    d.timing.delayHook = () => {delayFault++; d.timing.advance(600_000 - d.timing.now); return new Promise<void>(() => undefined);};
    const timedOut = await run(w.input, d.dependencies); expect(timedOut).toMatchObject({status: "pending", reason: "timeout", pollCount: 1, elapsedMilliseconds: 600_000}); expect(delayFault).toBe(1); d.timing.clean();
  });
  it("a pass completing at the deadline cannot claim served", async () => {
    const w = await fixture(); const s = setup(w.input); let replies = 0; let offset = 0;
    s.transport.reply = request => {replies++; s.timing.advance(59_999); return s.transport.match(request);};
    s.dependencies.checkpoint = poll => {if (poll.poll === 1) {offset++; s.timing.advance(40_009);} return Promise.resolve();};
    const result = await run(w.input, s.dependencies);
    expect(result).toMatchObject({status: "pending", reason: "timeout", elapsedMilliseconds: 600_000}); expect(replies).toBe(9); expect(offset).toBe(1); expect(result.polls.map(p => p.passed)).toEqual([true, true, false]); s.timing.clean();
  });
  it("caller cancellation leaves deployment and comment pending without claiming served", async () => {
    const w = await fixture(); const s = setup(w.input); const controller = new AbortController(); let reached = 0;
    s.transport.reply = request => {if (request.url.endsWith("/7/latest.json")) {reached++; controller.abort(new Error(SIGNED_URL)); return new Promise<HttpResponse>(() => undefined);} return s.transport.match(request);};
    const result = await run({...w.input, signal: controller.signal}, s.dependencies);
    expect(result).toMatchObject({status: "pending", reason: "cancelled", pollCount: 1, consecutivePasses: 0}); expect(reached).toBe(1); expect(s.transport.calls.length).toBe(2); s.timing.clean();
    const before = setup(w.input); const stopped = new AbortController(); stopped.abort(new Error(CANARY_TOKEN));
    expect((await run({...w.input, signal: stopped.signal}, before.dependencies)).reason).toBe("cancelled"); expect(before.transport.calls).toEqual([]); before.timing.clean();
  });
  it("a ready result sampled at the overall deadline remains pending", async () => {
    const w = await fixture(); const s = setup(w.input); let armed = false; let sampled = 0; let reached = 0;
    const deps = {...s.dependencies, now: () => {if (armed && ++sampled === 2) {reached++; s.timing.advance(1);} return s.timing.now;},
      checkpoint: (poll: ReadinessPoll) => {if (poll.poll === 3) {s.timing.advance(599_999 - s.timing.now); armed = true;} return Promise.resolve();}};
    const result = await run(w.input, deps);
    expect(result).toMatchObject({status: "pending", reason: "timeout", elapsedMilliseconds: 600_000, pollCount: 3, consecutivePasses: 3});
    expect({sampled, reached}).toEqual({sampled: 2, reached: 1}); expect(s.transport.calls).toHaveLength(9); s.timing.clean();
  });
  it("final readiness reconstruction rechecks caller cancellation and overall signal state", async () => {
    const w = await fixture();
    for (const kind of ["caller", "overall"] as const) {
      const s = setup(w.input); const controller = new AbortController(); let armed = false; let sampled = 0; let reached = 0;
      const timing = {deadline: (milliseconds: number) => {const handle = s.timing.deadline(milliseconds);
        return kind === "overall" && milliseconds === 600_000 ? {...handle, signal: controller.signal} : handle;}, delay: (milliseconds: number, signal?: AbortSignal) => s.timing.delay(milliseconds, signal)};
      const deps = {...s.dependencies, timing, now: () => {if (armed && ++sampled === 2) {reached++; controller.abort(new Error(CANARY_TOKEN + " " + SIGNED_URL));} return s.timing.now;},
        checkpoint: (poll: ReadinessPoll) => {if (poll.poll === 3) armed = true; return Promise.resolve();}};
      const result = await run({...w.input, ...(kind === "caller" ? {signal: controller.signal} : {})}, deps);
      expect(result).toMatchObject({status: "pending", reason: kind === "caller" ? "cancelled" : "timeout", elapsedMilliseconds: 20_000, pollCount: 3, consecutivePasses: 3});
      expect({sampled, reached}).toEqual({sampled: 2, reached: 1}); expect(s.transport.calls).toHaveLength(9); s.timing.clean();
    }
  });
  it("failed and cancelled deployments can be served only when observed bytes pass", async () => {
    const w = await fixture();
    for (const outcome of ["failed", "cancelled"] as const) {
      const input = {...w.input, deploymentOutcome: outcome}; const s = setup(input);
      expect((await run(input, s.dependencies)).status).toBe("served"); s.timing.clean();
      const stale = setup(input); stale.transport.reply = request => jsonBody(stale.transport.match(request), value => {value["generation"] = "a".repeat(64);});
      expect(await run(input, stale.dependencies)).toMatchObject({status: "pending", reason: "timeout", consecutivePasses: 0}); stale.timing.clean();
    }
  });
  it("fixed readiness diagnostics never expose hostile bodies signed redirects or fake credentials", async () => {
    const w = await fixture();
    const attacks: {code: string; reply: (response: HttpResponse) => HttpResponse | Promise<HttpResponse>}[] = [
      {code: "redirect-refused", reply: response => ({...response, status: 302, headers: {location: SIGNED_URL}})},
      {code: "json-invalid", reply: response => ({...response, body: new TextEncoder().encode('{"schemaVersion":1,"schemaVersion":1,"token":"' + CANARY_TOKEN + '"}')})},
      {code: "unsupported-version", reply: response => jsonBody(response, value => {value["schemaVersion"] = 2;})},
      {code: "body-limit", reply: response => ({...response, body: new Uint8Array(1_048_577)})},
      {code: "transport-failed", reply: () => Promise.reject(new Error(CANARY_TOKEN + " " + SIGNED_URL))},
    ];
    for (const attack of attacks) {const s = setup(w.input); let reached = 0; s.transport.reply = request => {if (s.transport.poll === 1) {reached++; return attack.reply(s.transport.match(request));} return s.transport.match(request);};
      const result = await run(w.input, s.dependencies); expect(result.polls[0]?.code).toBe(attack.code); expect(result.status).toBe("served"); expect(reached).toBe(1); expect(s.transport.calls.every(call => !call.url.includes("?"))).toBe(true); raw.push(JSON.stringify(s.transport.calls)); s.timing.clean();}
  });
  it("rejects nonmonotonic clocks and reaches every named injected readiness failure", async () => {
    const w = await fixture(); const reached = {invalid: 0, backwards: 0, stalled: 0};
    for (const invalid of [NaN, Infinity, -1]) {const s = setup(w.input); const deps = {...s.dependencies, now: () => {reached.invalid++; return invalid;}}; await refuses(w.input, deps, "readiness-timing-invalid"); expect(s.transport.calls).toEqual([]);}
    const back = setup(w.input); back.timing.delayHook = () => {reached.backwards++; back.timing.now = -1; return Promise.resolve();}; await refuses(w.input, back.dependencies, "readiness-timing-invalid"); back.timing.clean();
    const stopped = setup(w.input); stopped.timing.delayHook = () => {reached.stalled++; return Promise.resolve();}; await refuses(w.input, stopped.dependencies, "readiness-timing-invalid"); stopped.timing.clean();
    expect(reached).toEqual({invalid: 3, backwards: 1, stalled: 1});
    const valid = setup(w.input); vi.spyOn(Date, "now").mockImplementation(() => {throw new Error("ambient-clock");}); vi.spyOn(Math, "random").mockImplementation(() => {throw new Error("ambient-random");});
    expect((await run(w.input, valid.dependencies)).status).toBe("served"); valid.timing.clean();
  });
  it("bounds expected inventories and targets before accessing indexed bodies", async () => {
    const w = await fixture(); let fileIndices = 0; let maps = 0; let targetIndices = 0;
    const files = new Proxy(w.input.site.files, {get(target, key, receiver) {if (key === "length") return 302_019; if (key === "map" || key === Symbol.iterator) maps++; if (typeof key === "string" && /^[0-9]+$/.test(key)) fileIndices++; const value: unknown = Reflect.get(target, key, receiver); return value;}});
    const s = setup(w.input); await refuses({...w.input, site: {...w.input.site, files}}, s.dependencies, "readiness-input-invalid"); expect({fileIndices, maps}).toEqual({fileIndices: 0, maps: 0});
    const targets = new Proxy(w.input.targets, {get(target, key, receiver) {if (key === "length") return 1001; if (typeof key === "string" && /^[0-9]+$/.test(key)) targetIndices++; const value: unknown = Reflect.get(target, key, receiver); return value;}});
    await refuses({...w.input, targets}, s.dependencies, "readiness-input-invalid"); expect(targetIndices).toBe(0); expect(s.transport.calls).toEqual([]);
  });
  it("copies selected native bytes without invoking byteLength or iterator claims", async () => {
    const w = await fixture(); const s = setup(w.input); let claims = 0;
    for (const file of w.input.site.files) if (file.path === "site.json" || file.path === prPointerPath("7")) {
      const bytes = file.bytes; for (const key of ["byteLength", Symbol.iterator]) Object.defineProperty(bytes, key, {get() {claims++; throw new Error(CANARY_TOKEN);}});
    }
    expect((await run(w.input, s.dependencies)).status).toBe("served"); expect(claims).toBe(0); s.timing.clean();
  });
  it("refuses missing duplicate unsafe or mismatched expected targets without HTTP", async () => {
    const w = await fixture(); const bad: ReadinessInput[] = [
      {...w.input, targets: [required(w.input.targets[0]), required(w.input.targets[0])]},
      {...w.input, targets: [{...required(w.input.targets[0]), prNumber: "../7"}]},
      {...w.input, targets: [{...required(w.input.targets[0]), headSha: CANARY_TOKEN}]},
      {...w.input, site: {...w.input.site, files: w.input.site.files.filter(file => file.path !== prPointerPath("7"))}},
      {...w.input, site: {...w.input.site, files: [...w.input.site.files, required(w.input.site.files[0])]}},
      {...w.input, site: {...w.input.site, files: [...w.input.site.files, {...required(w.input.site.files[0]), path: "../evil.js"}]}},
      {...w.input, site: {...w.input.site, files: w.input.site.files.map(file => file.path === "site.json" ? {...file, sha256: "a".repeat(64)} : file)}},
    ];
    for (const input of bad) {const s = setup(w.input); await refuses(input, s.dependencies, "readiness-input-invalid"); expect(s.transport.calls).toEqual([]); expect(s.timing.started).toEqual([]);}
  });
  it("bounded frozen checkpoint records cannot rewrite readiness or stall its deadline", async () => {
    const w = await fixture(); const s = setup(w.input); let callbacks = 0;
    s.dependencies.checkpoint = poll => {callbacks++; expect(Object.isFrozen(poll)).toBe(true); expect(Reflect.set(poll, "passed", false)).toBe(false); return Promise.resolve();};
    expect((await run(w.input, s.dependencies)).polls.every(p => p.passed)).toBe(true); expect(callbacks).toBe(3); s.timing.clean();
    const stalled = setup(w.input); let reached = 0; stalled.dependencies.checkpoint = () => {reached++; stalled.timing.advance(600_000); return new Promise<void>(() => undefined);};
    expect(await run(w.input, stalled.dependencies)).toMatchObject({status: "pending", reason: "timeout"}); expect(reached).toBe(1); stalled.timing.clean();
  });
  it("a marked empty assembled home is ready without inventing PR targets", async () => {
    const w = await fixture(0); const s = setup(w.input); expect((await run(w.input, s.dependencies)).status).toBe("served"); expect(s.transport.calls.length).toBe(3); expect(s.transport.calls.every(call => call.url.endsWith("/site.json"))).toBe(true); s.timing.clean();
  });
  it("disposes a created deadline when its signal getter or native signal validation fails", async () => {
    const w = await fixture(); const reached = {getter: 0, invalid: 0, disposed: 0};
    for (const fault of ["getter", "invalid"] as const) {
      const s = setup(w.input); const timing: Timing = {delay: (ms, signal) => s.timing.delay(ms, signal), deadline: ms => {
        const handle = s.timing.deadline(ms);
        return {get signal() {reached[fault]++; if (fault === "getter") throw new Error(CANARY_TOKEN + " " + SIGNED_URL); return {} as AbortSignal;}, dispose: () => {reached.disposed++; handle.dispose();}};
      }};
      await refuses(w.input, {...s.dependencies, timing}, "readiness-operation-failed"); expect(s.transport.calls).toEqual([]); s.timing.clean();
    }
    expect(reached).toEqual({getter: 1, invalid: 1, disposed: 2});
  });
  it("ignores late response getters after caller cancellation has settled", async () => {
    const w = await fixture(); const s = setup(w.input); const controller = new AbortController(); let resolveLate: ((response: HttpResponse) => void) | undefined; let properties = 0; let injected = 0;
    s.transport.reply = () => new Promise<HttpResponse>(resolve => {resolveLate = resolve; injected++; controller.abort();});
    expect((await run({...w.input, signal: controller.signal}, s.dependencies)).reason).toBe("cancelled");
    required(resolveLate)({get status(): number {properties++; throw new Error(CANARY_TOKEN);}, headers: {}, get body(): Uint8Array {properties++; throw new Error(SIGNED_URL);}});
    await Promise.resolve(); await Promise.resolve(); expect({properties, injected}).toEqual({properties: 0, injected: 1}); s.timing.clean();
  });
  it("transport limits and forged callback diagnostics use private fixed error provenance", async () => {
    const w = await fixture();
    for (const kind of ["constructed", "forged"] as const) {
      const s = setup(w.input); let properties = 0; let reached = 0;
      const error: Error = kind === "constructed" ? new ForgeError("response-too-large") : Object.create(ForgeError.prototype) as Error;
      for (const field of ["name", "message", "code", "stack", "cause"]) Object.defineProperty(error, field, {get() {properties++; throw new Error(CANARY_TOKEN + " " + SIGNED_URL);}});
      s.transport.reply = request => {if (s.transport.poll === 1) {reached++; return Promise.reject(error);} return s.transport.match(request);};
      const result = await run(w.input, s.dependencies);
      expect(result.polls[0]?.code).toBe(kind === "constructed" ? "body-limit" : "transport-failed"); expect({properties, reached}).toEqual({properties: 0, reached: 1}); expect(result.status).toBe("served"); s.timing.clean();
    }
  });
  it("caps selected expected bytes by the existing configured site hard budget", async () => {
    const w = await fixture(); Object.assign(w.input.context.config, {limits: {softBytes: 1_048_576, hardBytes: 1_048_576}});
    const padded = new Uint8Array(1_048_576).fill(32); const original = required(w.input.site.files.find(file => file.path === prPointerPath("7"))); padded.set(original.bytes);
    const input = {...w.input, site: {...w.input.site, files: w.input.site.files.map(file => file.path === original.path ? {...file, bytes: padded, sha256: hash(padded)} : file)}};
    const s = setup(input); await refuses(input, s.dependencies, "readiness-input-invalid"); expect(s.transport.calls).toEqual([]); expect(s.timing.started).toEqual([]);
  });
  it("checks accepted inventory length boundary without invoking a supplied iterator", async () => {
    const w = await fixture(); const s = setup(w.input); let counts = 0; let indices = 0; let methods = 0; const first = required(w.input.site.files[0]);
    const listing = new Proxy(w.input.site.files, {get(target, key, receiver) {if (key === "length") {counts++; return MAX_ASSEMBLED_FILES;} if (key === "map" || key === Symbol.iterator) {methods++; throw new Error(CANARY_TOKEN);} if (typeof key === "string" && /^[0-9]+$/.test(key)) {indices++; return first;} const value: unknown = Reflect.get(target, key, receiver); return value;}});
    await refuses({...w.input, site: {...w.input.site, files: listing}}, s.dependencies, "readiness-input-invalid");
    expect({counts, indices, methods}).toEqual({counts: 1, indices: 2, methods: 0}); expect(s.transport.calls).toEqual([]);
  });
  it("reentrant body cancellation cannot turn an aborted response into a matching poll", async () => {
    const w = await fixture(); const s = setup(w.input); const controller = new AbortController(); let reached = 0;
    s.transport.reply = request => {const matched = s.transport.match(request); return {...matched, get body() {reached++; controller.abort(new Error(SIGNED_URL)); return matched.body;}};};
    const result = await run({...w.input, signal: controller.signal}, s.dependencies);
    expect(result).toMatchObject({status: "pending", reason: "cancelled", consecutivePasses: 0}); expect(result.polls[0]?.passed).toBe(false); expect(reached).toBe(1); s.timing.clean();
  });
  it("sanitizes failures from timing creation disposal delay and checkpoint", async () => {
    const w = await fixture(); const reached = {setup: 0, disposal: 0, delay: 0, checkpoint: 0};
    for (const fault of ["setup", "disposal", "delay", "checkpoint"] as const) {
      const s = setup(w.input); const timing: Timing = {deadline: ms => {
        if (fault === "setup") {reached.setup++; throw new Error(CANARY_TOKEN + " " + SIGNED_URL);}
        const handle = s.timing.deadline(ms);
        return {signal: handle.signal, dispose: () => {handle.dispose(); if (fault === "disposal" && ms <= 60_000) {reached.disposal++; throw new Error(CANARY_TOKEN + " " + SIGNED_URL);}}};
      }, delay: (ms, signal) => {if (fault === "delay") {reached.delay++; return Promise.reject(new Error(CANARY_TOKEN + " " + SIGNED_URL));} return s.timing.delay(ms, signal);}};
      const deps = {...s.dependencies, timing, checkpoint: (poll: ReadinessPoll) => {if (fault === "checkpoint") {reached.checkpoint++; return Promise.reject(new Error(CANARY_TOKEN + " " + SIGNED_URL));} return s.dependencies.checkpoint(poll);}};
      await refuses(w.input, deps, "readiness-operation-failed"); s.timing.clean();
    }
    expect(reached).toEqual({setup: 1, disposal: 1, delay: 1, checkpoint: 1});
  });
  it.each([["caller", "proxy"], ["caller", "plain"], ["deadline", "proxy"], ["deadline", "plain"]] as const)(
    "rejects %s %s signals without traps HTTP or leaked deadline handles", async (port, kind) => {
      const w = await fixture(); const s = setup(w.input); let traps = 0; let reached = 0;
      const malformed = (): AbortSignal => {
        reached++; const controller = new AbortController(); if (kind === "proxy") controller.abort(new Error(CANARY_TOKEN));
        return kind === "plain" ? Object.assign({}, controller.signal) : new Proxy(controller.signal, {get(target, key) {
          traps++; return typeof key === "symbol" && String(key) === "Symbol(kAborted)" ? false : Reflect.get(target, key, target) as unknown;
        }, getPrototypeOf() {traps++; throw new Error(SIGNED_URL);}});
      };
      const input = {...w.input, ...(port === "caller" ? {signal: malformed()} : {})};
      const timing = {deadline: (milliseconds: number) => {const handle = s.timing.deadline(milliseconds); return {...handle, signal: malformed()};}, delay: (milliseconds: number, signal?: AbortSignal) => s.timing.delay(milliseconds, signal)};
      await refuses(input, {...s.dependencies, ...(port === "deadline" ? {timing} : {})}, port === "caller" ? "readiness-input-invalid" : "readiness-operation-failed");
      expect({traps, reached, requests: s.transport.calls.length, created: s.timing.started.length, disposed: s.timing.disposed.length})
        .toEqual({traps: 0, reached: 1, requests: 0, created: port === "caller" ? 0 : 1, disposed: port === "caller" ? 0 : 1}); s.timing.clean();
    });
  it.each(["caller", "overall", "request"] as const)("closes all created deadlines and partial listeners when %s scope registration fails", async (port) => {
    const w = await fixture(); const s = setup(w.input); const OriginalController = AbortController; const controllers: AbortController[] = []; const broken = new Set<AbortSignal>(); let reached = 0;
    class TrackingController extends OriginalController {constructor() {super(); controllers.push(this);}}
    vi.stubGlobal("AbortController", TrackingController);
    try {
      const caller = new AbortController();
      if (port === "caller") {brokenListeners(caller.signal); broken.add(caller.signal); reached++;}
      const timing = {deadline: (milliseconds: number) => {const handle = s.timing.deadline(milliseconds);
        if ((port === "overall" && milliseconds === 600_000) || (port === "request" && milliseconds !== 600_000)) {brokenListeners(handle.signal); broken.add(handle.signal); reached++;}
        return handle;}, delay: (milliseconds: number, signal?: AbortSignal) => s.timing.delay(milliseconds, signal)};
      await refuses({...w.input, ...(port === "caller" ? {signal: caller.signal} : {})}, {...s.dependencies, timing}, "readiness-operation-failed");
      expect(reached).toBe(1); expect(s.transport.calls).toEqual([]); s.timing.clean();
      for (const controller of controllers) if (!broken.has(controller.signal)) expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {vi.unstubAllGlobals();}
  });
  it.each([["caller", 0], ["caller", null], ["caller", "false"], ["caller", 1], ["deadline", 0], ["deadline", null], ["deadline", "false"], ["deadline", 1]] as const)(
    "rejects %s signal nonboolean native state %s before HTTP and closes created deadlines", async (port, value) => {
      const w = await fixture(); const s = setup(w.input); let reached = 0;
      const malformed = (): AbortSignal => {reached++; const signal = new AbortController().signal;
        const key = required(Object.getOwnPropertySymbols(signal).find(key => String(key) === "Symbol(kAborted)"));
        Object.defineProperty(signal, key, {value}); return signal;};
      const timing = {deadline: (milliseconds: number) => {const handle = s.timing.deadline(milliseconds); return {...handle, signal: malformed()};}, delay: (milliseconds: number, signal?: AbortSignal) => s.timing.delay(milliseconds, signal)};
      await refuses({...w.input, ...(port === "caller" ? {signal: malformed()} : {})}, {...s.dependencies, ...(port === "deadline" ? {timing} : {})}, port === "caller" ? "readiness-input-invalid" : "readiness-operation-failed");
      expect({reached, requests: s.transport.calls.length, created: s.timing.started.length, disposed: s.timing.disposed.length})
        .toEqual({reached: 1, requests: 0, created: port === "caller" ? 0 : 1, disposed: port === "caller" ? 0 : 1}); s.timing.clean();
    });
  it.each(["overall", "request"] as const)("disposes the %s deadline even when its listener remover fails", async (port) => {
    const w = await fixture(); const s = setup(w.input); const caller = new AbortController(); const handles: {signal: AbortSignal; milliseconds: number}[] = []; let reached = 0;
    const timing = {deadline: (milliseconds: number) => {const handle = s.timing.deadline(milliseconds); handles.push({signal: handle.signal, milliseconds}); return handle;}, delay: (milliseconds: number, signal?: AbortSignal) => s.timing.delay(milliseconds, signal)};
    if (port === "request") s.transport.reply = request => {if (reached === 0) {reached++; brokenListeners(required(handles.at(-1)).signal);} return s.transport.match(request);};
    const deps = {...s.dependencies, timing, checkpoint: (poll: ReadinessPoll) => {if (port === "overall" && poll.poll === 3) {reached++; brokenListeners(caller.signal);} return Promise.resolve();}};
    await refuses({...w.input, ...(port === "overall" ? {signal: caller.signal} : {})}, deps, "readiness-operation-failed");
    expect(reached).toBe(1); expect(s.transport.calls).toHaveLength(port === "overall" ? 9 : 1); s.timing.clean();
    for (const handle of handles) if (port === "overall" || handle.milliseconds === 600_000) expect(getEventListeners(handle.signal, "abort")).toHaveLength(0);
  });
  it("removes an abort listener when native registration throws after inserting it", async () => {
    const w = await fixture(); const s = setup(w.input); const controller = new AbortController(); const prior = () => undefined; let reached = 0;
    controller.signal.addEventListener("abort", prior);
    const key = required(Object.getOwnPropertySymbols(AbortSignal.prototype).find(key => String(key) === "Symbol(kNewListener)"));
    Object.defineProperty(controller.signal, key, {value: () => {reached++; throw new Error(CANARY_TOKEN + " " + SIGNED_URL);}});
    await refuses({...w.input, signal: controller.signal}, s.dependencies, "readiness-operation-failed");
    expect({reached, requests: s.transport.calls.length}).toEqual({reached: 1, requests: 0}); s.timing.clean();
    expect(getEventListeners(controller.signal, "abort")).toEqual([prior]);
  });
  it("a throwing race listener remover still settles polling and disposes its deadline", async () => {
    const w = await fixture(); const s = setup(w.input); let reached = 0; let removed = 0;
    const key = required(Object.getOwnPropertySymbols(AbortSignal.prototype).find(key => String(key) === "Symbol(kRemoveListener)"));
    s.transport.reply = request => {if (reached === 0) {reached++; Object.defineProperty(required(request.signal), key, {value: () => {removed++; throw new Error(CANARY_TOKEN + " " + SIGNED_URL);}});} return s.transport.match(request);};
    let settled: ReadinessResult | undefined;
    const pending = run(w.input, s.dependencies).then(result => {settled = result;});
    // Every port returns a resolved promise; a finite microtask drain exposes a stalled race
    // without an ambient timer, real sleep or wall-clock decision.
    for (let step = 0; step < 100; step++) await Promise.resolve();
    expect(settled).toBeDefined(); await pending;
    expect(settled?.status).toBe("served"); expect(settled?.polls[0]?.code).toBe("transport-failed");
    expect({reached, removed, requests: s.transport.calls.length}).toEqual({reached: 1, removed: 1, requests: 10}); s.timing.clean();
  });
});

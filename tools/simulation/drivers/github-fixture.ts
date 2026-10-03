// Synthetic official API subsets and independent archive writers; no publisher decisions here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalBytes, formatArtifactName, unitFileName, validateDocument, type Bundle } from "../../../packages/schemas/src/index.ts";
import { encodePng, pixelHash, type RawPixels } from "../../../packages/core/src/index.ts";
import type { HttpRequest, HttpResponse, Timing } from "../../../packages/forge-github/src/index.ts";
import type { SourceJobInput } from "../../../packages/publisher/src/index.ts";
import { buildPng } from "../../png-corpus/png-builder.ts";
import { buildZip } from "../../zip-corpus/zip-builder.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../capture.ts";
import { Clock, Scheduler, checkpoint } from "../schedule.ts";
import type { Faults } from "../faults.ts";
import { REPOSITORY_ID } from "./store-fixture.ts";

export const CASE_KEY = "sim-github-faults/expiry-rate-limit-redirect-and-server-errors";
export const HEAD = "1".repeat(40), CONFIG_SHA = "2".repeat(40), RELEASE_SHA = "3".repeat(40);
export const TIMESTAMP = "2000-01-01T00:00:00Z";
const PREFIX = "https://api.github.com/repos/sim/upstream";
export const VARIANTS = ["expired", "gone", "secondary", "rate", "server500", "server502", "server503", "redirect"] as const;
export type Variant = typeof VARIANTS[number];
export interface ObservedCall { readonly route: string; readonly status: number; readonly authorized: boolean }

/** Every simulated deadline owns a native controller; only injected clock advances expire it. */
export class VirtualTiming implements Timing {
  readonly clock = new Clock();
  readonly delays: {milliseconds: number; now: number}[] = [];
  readonly #deadlines: {due: number; controller: AbortController; disposed: boolean}[] = [];
  #fired = 0;
  deadline(milliseconds: number): {signal: AbortSignal; dispose(): void} {
    assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 600000);
    const entry = {due: this.clock.now + milliseconds, controller: new AbortController(), disposed: false};
    this.#deadlines.push(entry);
    return {signal: entry.controller.signal, dispose: () => {assert.equal(entry.disposed, false); entry.disposed = true;}};
  }
  advance(milliseconds: number): void {
    this.clock.advance(milliseconds);
    for (const entry of this.#deadlines) if (!entry.disposed && !entry.controller.signal.aborted && entry.due <= this.clock.now) {
      this.#fired++; entry.controller.abort();
    }
  }
  delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    assert.notEqual(signal?.aborted, true); this.advance(milliseconds);
    this.delays.push({milliseconds, now: this.clock.now});
    assert.notEqual(signal?.aborted, true); return Promise.resolve();
  }
  evidence(): {created: number; disposed: number; fired: number} {
    const disposed = this.#deadlines.filter(entry => entry.disposed).length;
    assert.equal(disposed, this.#deadlines.length);
    return {created: this.#deadlines.length, disposed, fired: this.#fired};
  }
}

interface Route {readonly name: string; readonly authorized: boolean; readonly replies: (() => HttpResponse)[]}
/** Exact fixed production URLs; unregistered, exhausted or unconsumed calls fail closed. */
export class GitHubFixture {
  readonly calls: ObservedCall[] = [];
  readonly requestCounts: Record<string, number> = Object.fromEntries([...VARIANTS, "signed"].map(name => [name, 0]));
  readonly schedule: readonly string[];
  readonly #routes = new Map<string, Route>();
  constructor(seed: number, faults: Faults, zip: Uint8Array) {
    const repository = {id: Number(REPOSITORY_ID), name: "upstream", full_name: "sim/upstream", default_branch: "main"};
    const run = {id: 101, workflow_id: 123456, run_attempt: 1, event: "push", status: "completed", conclusion: "success",
      created_at: TIMESTAMP, head_sha: HEAD, head_branch: "main", path: ".github/workflows/capture.yml",
      repository, head_repository: repository, head_commit: {id: HEAD}, pull_requests: []};
    for (const [path, body] of [["", repository], ["/actions/runs/101", run], ["/actions/runs/101/attempts/1", run],
      ["/actions/workflows/123456", {id: 123456, path: run.path}], [`/commits/${HEAD}`, {sha: HEAD, parents: []}]] as const)
      this.#route(PREFIX + path, path === "" ? "repository" : path, true, [() => this.#json(200, body)]);
    const schedule = new Scheduler(seed); schedule.barrier("listing", ["a", "b", "c", "d", "e", "f", "g", "h"]);
    const metadata: {id: number; name: string; size_in_bytes: number; expired: boolean}[] = [];
    for (const [index, variant] of VARIANTS.entries()) schedule.add(String.fromCharCode(97 + index), function* () {
      yield checkpoint("register-artifact", () => metadata.push({id: 201 + index,
        name: formatArtifactName({attempt: "1", revision: "head", providerId: "p", shard: {index: index + 1, count: 8}}),
        size_in_bytes: zip.byteLength, expired: variant === "expired"}), "listing");
    });
    schedule.run(); this.schedule = schedule.trace;
    assert.equal(metadata.length, 8);
    for (const page of [1, 2]) this.#route(`${PREFIX}/actions/runs/101/artifacts?per_page=100&page=${String(page)}`,
      `listing-${String(page)}`, true, [() => this.#json(200, {total_count: 8, artifacts: metadata.slice((page - 1) * 4, page * 4)})]);
    for (const [index, variant] of VARIANTS.entries()) {
      if (variant === "expired") continue; // No route: any attempt to fetch the expired artifact fails.
      const endpoint = `${PREFIX}/actions/artifacts/${String(201 + index)}/zip`;
      if (variant === "redirect") {
        this.#route(endpoint, variant, true, [() => {
          // First hop fails to supply artifact bytes; production follows this injected manual redirect.
          assert.equal(faults.hit("a", "github-redirect"), "fail-before");
          return {status: 302, headers: {location: SIGNED_URL}, body: new Uint8Array()};
        }]);
      } else {
        const status = variant === "gone" ? 410 : variant === "secondary" ? 403 : variant === "rate" ? 429
          : variant === "server500" ? 500 : variant === "server502" ? 502 : 503;
        this.#route(endpoint, variant, true, Array.from({length: status === 410 ? 1 : 3}, () => () =>
          this.#json(status, {message: `${CANARY_TOKEN} ${SIGNED_URL}`}, status === 403 || status === 429 ? {"retry-after": "2"} : {})));
      }
    }
    this.#route(SIGNED_URL, "signed", false, [() => ({status: 200, headers: {}, body: zip})]);
    this.event = canonicalBytes({action: "completed", repository, workflow_run: run});
  }
  readonly event: Uint8Array;
  #json(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): HttpResponse {
    return {status, headers, body: canonicalBytes(value)};
  }
  #route(url: string, name: string, authorized: boolean, replies: (() => HttpResponse)[]): void {
    assert.equal(this.#routes.has(url), false); assert.ok(replies.length > 0);
    this.#routes.set(url, {name, authorized, replies});
  }
  request(request: HttpRequest): Promise<HttpResponse> {
    assert.equal(request.method, "GET"); assert.equal(request.body, undefined); assert.notEqual(request.signal?.aborted, true);
    const route = this.#routes.get(request.url); assert.ok(route, "github-simulation-unregistered-route");
    const authorization = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === "authorization");
    assert.equal(authorization.length, route.authorized ? 1 : 0);
    if (route.authorized) assert.equal(authorization[0]?.[1], `Bearer ${CANARY_TOKEN}`);
    const response = route.replies.shift(); assert.ok(response, "github-simulation-exhausted-route");
    const value = response(); assert.ok(value.body.byteLength <= request.maxBytes);
    const call = {route: route.name, status: value.status, authorized: authorization.length === 1};
    assertNoSecrets([JSON.stringify(call)]); this.calls.push(call);
    if (Object.hasOwn(this.requestCounts, route.name)) this.requestCounts[route.name] = (this.requestCounts[route.name] ?? 0) + 1;
    return Promise.resolve({...value, headers: {...value.headers}, body: Uint8Array.from(value.body)});
  }
  assertConsumed(): void {assert.ok([...this.#routes.values()].every(route => route.replies.length === 0), "github-simulation-unconsumed-route");}
}

const BUILD_BYTES = 1024 * 1024;
// This fixed trusted compiler entry imports only checked-in release tooling. No fixture,
// adopter or artifact code becomes an executable path. Stop the esbuild service on both
// normal and refused builds before emitting the owned body or fixed failure diagnostic.
const BUILD_ENTRY = `await import(process.argv[2]);
const {stop}=await import("esbuild");
let bytes;
try {const {buildViewerAssets}=await import(process.argv[1]); const assets=await buildViewerAssets("0.1.0-rc.1");
if(assets.release!=="0.1.0-rc.1"||assets.script.byteLength===0||assets.script.byteLength>1048576)throw new Error("build-refused");
bytes=Buffer.from(assets.script);}catch{process.exitCode=1;}finally{stop();}
if(bytes!==undefined)process.stdout.write(bytes);`;
/** Compiler subprocess gets a fixed environment, never inherited credential/cache options. */
export function trustedViewerAssets(): Promise<{release:string;script:Uint8Array}> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {
    const value = process.env[key]; if (value !== undefined) environment[key] = value;
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", BUILD_ENTRY, new URL("../../viewer/build.ts", import.meta.url).href,new URL("../../lib/no-network.ts",import.meta.url).href],
    {cwd:fileURLToPath(new URL("../../../",import.meta.url)), env:environment, windowsHide:true, timeout:60000, maxBuffer:BUILD_BYTES});
  const stdout=Buffer.isBuffer(result.stdout)?result.stdout:new Uint8Array();
  const stderr=Buffer.isBuffer(result.stderr)?result.stderr:new Uint8Array();
  assertNoSecrets([stdout,stderr,result.error?.message??""]);
  if(result.status!==0||result.signal!==null||result.error!==undefined||stderr.byteLength!==0||stdout.byteLength===0||stdout.byteLength>BUILD_BYTES)
    return Promise.reject(new Error("github-simulation-trusted-build-failed"));
  return Promise.resolve({release:"0.1.0-rc.1",script:new Uint8Array(stdout)});
}
export async function githubInput(seed: number, faults: Faults): Promise<{input: SourceJobInput; fixture: GitHubFixture; image: RawPixels; expectedPng: Uint8Array; expectedHash: string}> {
  const image: RawPixels = {width: 2, height: 2, channels: 3, data: Uint8Array.from({length: 12}, (_, index) => (47 * 37 + index * 11) & 255)};
  const uploaded = buildPng(image.width, image.height, image.channels, image.data);
  const unit = {viewId: "redirect", variantId: "desktop", state: "captured" as const};
  const bundle: Bundle = {schemaVersion: 1, revision: "head", providerId: "p", attempt: "1", shard: {index: 8, count: 8},
    producer: {name: "simulation", version: "1"}, claims: {revisionSha: "f".repeat(40)}, units: [unit]};
  assert.ok(validateDocument("bundle", bundle).ok);
  const zip = buildZip({entries: [{name: "bundle.json", data: canonicalBytes(bundle)}, {name: unitFileName(unit), data: uploaded}]});
  const fixture = new GitHubFixture(seed, faults, zip); const assets = await trustedViewerAssets();
  const input: SourceJobInput = {config: {schemaVersion: 1, source: {workflowIds: ["123456"], events: ["push"]}, providers: [{id: "p", shards: 8}]},
    configCommit: CONFIG_SHA, pages: {url: "https://sim.github.io/upstream/", host: "sim.github.io"},
    repository: {repositoryId: REPOSITORY_ID, owner: "sim", name: "upstream"}, assets: {...assets, releaseCommit: RELEASE_SHA}, event: fixture.event};
  assert.ok(validateDocument("config", input.config).ok);
  return {input, fixture, image, expectedPng: encodePng(image), expectedHash: pixelHash(image)};
}

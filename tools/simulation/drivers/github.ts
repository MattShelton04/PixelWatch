import "../../lib/no-network.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { canonicalBytes, parseDocument } from "../../../packages/schemas/src/index.ts";
import { blobPath, compareImages, decodePng, encodePng, newStore, runRecordPath } from "../../../packages/core/src/index.ts";
import { GitHubClient } from "../../../packages/forge-github/src/index.ts";
import { GitBranchStore } from "../../../packages/store/src/index.ts";
import { ingestJob } from "../../../packages/publisher/src/index.ts";
import { Capture, CANARY_TOKEN, assertNoSecrets } from "../capture.ts";
import { Faults } from "../faults.ts";
import scenario from "../scenarios/sim-github-faults.sim.test.ts";
import type { Evidence } from "../scenarios/spec.ts";
import type { Observation } from "../scenarios/spec.ts";
import { CASE_KEY, CONFIG_SHA, HEAD, RELEASE_SHA, TIMESTAMP, VirtualTiming, githubInput } from "./github-fixture.ts";
import { REPOSITORY_ID, StoreRemote } from "./store-fixture.ts";

export type GitHubCaseKey = "sim-github-faults/expiry-rate-limit-redirect-and-server-errors";
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
class RawCapture {
  readonly capture = new Capture(); readonly #raw: (string | Uint8Array)[] = [];
  get count(): number {return this.#raw.length;}
  scan(value: string | Uint8Array): void {assertNoSecrets([value]); this.#raw.push(value);}
  log(value: unknown): void {const text = JSON.stringify(value); this.scan(text); this.capture.log(text);}
  summary(value: string): void {this.scan(value); this.capture.summary(value);}
  error(value: unknown): void {
    // Complete public diagnostics are scanned before Capture can redact them.
    this.scan(inspect(value, {showHidden: true, depth: 20})); this.capture.error(value);
  }
  clean(): void {assertNoSecrets(this.#raw); this.capture.assertClean();}
}

/** Full case calls actual authenticated ingestion; fixture ports only supply external effects. */
export async function runGitHubCase(caseKey: GitHubCaseKey, seed: number): Promise<{evidence: Evidence; normalized: string}> {
  const raw = new RawCapture(); let remote: StoreRemote | undefined;
  const adapters: GitBranchStore[] = [];
  try {
    assert.equal(caseKey, CASE_KEY);
    const definition = scenario.cases[0]; assert.ok(definition);
    const faults = new Faults(definition.faults); const timing = new VirtualTiming();
    const {input, fixture, expectedPng, expectedHash} = await githubInput(seed, faults);
    const metadata = {timestamp: TIMESTAMP}; remote = new StoreRemote();
    const observer = new GitBranchStore({remote: remote.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main",
      testRemote: {root: remote.root}, timing}); adapters.push(observer);
    const initial = newStore(REPOSITORY_ID);
    assert.equal((await observer.cas(null, {store: initial, runs: new Map(), files: new Map([["store.json", canonicalBytes(initial)]]), metadata})).status, "accepted");
    const beforeTip = remote.tip();
    const events: Observation[] = [], workerTrace: string[] = [];
    const counts = {decodes: 0, encodes: 0, compares: 0, closes: 0, actualPushes: 0};
    let nativeLease = false, closedBeforePush = false;
    const adapter = new GitBranchStore({remote: remote.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main",
      testRemote: {root: remote.root}, timing, checkpoint: event => {
        raw.log(event);
        if (event.point === "before-push") {
          nativeLease = event.expectedTip === beforeTip && /^[a-f0-9]{40}$/.test(event.expectedTip);
          assert.ok(nativeLease); closedBeforePush = counts.closes === 1; assert.ok(closedBeforePush);
          workerTrace.push("push");
        } else {
          assert.equal(event.result, "accepted"); counts.actualPushes++;
          events.push({kind: "push", actor: "a", ...(event.expectedTip === null ? {} : {expected: event.expectedTip}), tip: event.newTip});
        }
        return Promise.resolve();
      }}); adapters.push(adapter);
    const forge = new GitHubClient({owner: "sim", repo: "upstream", repositoryId: REPOSITORY_ID,
      token: CANARY_TOKEN, timing, transport: fixture});
    const result = await ingestJob(input, {forge, store: {
      read: async () => {const snapshot = await adapter.read(); events.push({kind: "fetch", actor: "a", ...(snapshot.tip === null ? {} : {tip: snapshot.tip})}); return snapshot;},
      cas: (tip, candidate) => adapter.cas(tip, candidate),
    }, admission: {now: TIMESTAMP, metadata, prStates: new Map(),
      delay: milliseconds => timing.delay(milliseconds), jitter: attempt => (seed + attempt) % 1001}, timing,
    worker: {
      decode: bytes => {counts.decodes++; workerTrace.push("decode"); return decodePng(bytes);},
      encode: pixels => {counts.encodes++; workerTrace.push("encode"); return Promise.resolve(encodePng(pixels));},
      compare: (base, head, policy) => {counts.compares++; workerTrace.push("compare"); return Promise.resolve(compareImages(base, head, policy));},
      close: () => {counts.closes++; workerTrace.push("close"); return Promise.resolve();},
    }});
    raw.log(result); assert.equal(result.admission.status, "stored"); assert.equal(result.projection, "pending");
    const snapshot = await observer.read(); const stored: {path: string; sha256: string}[] = [];
    assert.ok(snapshot.tip); assert.notEqual(snapshot.tip, beforeTip); assert.equal(remote.tip(), snapshot.tip);
    for (const file of snapshot.files) {const bytes = await snapshot.readFile(file.path); raw.scan(file.path); raw.scan(bytes); stored.push({path: file.path, sha256: digest(bytes)});}
    stored.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const canonicalRun = await snapshot.readFile(runRecordPath("101-a1")); raw.scan(canonicalRun);
    const parsed = parseDocument("run", canonicalRun); assert.ok(parsed.ok);
    const run = parsed.value;
    assert.deepEqual(Buffer.from(canonicalRun), Buffer.from(canonicalBytes(result.admission.run)));
    assert.equal(run.coverage.status, "incomplete"); assert.equal(run.coverage.missingParts.length, 7);
    assert.equal(run.coverage.declaredUnits, 1); assert.equal(run.coverage.accountedUnits, 1);
    const unknownMissingCounts = run.coverage.missingParts.every(part => part.reason === "not-received" && !Object.hasOwn(part, "unitCount"));
    assert.ok(unknownMissingCounts); assert.equal(run.parts.length, 1); assert.equal(run.parts[0]?.artifactId, "208");
    const sourceProvenance = run.source.repositoryId === REPOSITORY_ID && run.source.workflowId === "123456" && run.source.runId === "101"
      && run.source.attempt === "1" && run.source.event === "push" && run.source.commits.head === HEAD
      && run.source.configSha === CONFIG_SHA && run.source.releaseSha === RELEASE_SHA && run.claims.head?.revisionSha === "f".repeat(40);
    assert.ok(sourceProvenance);
    const png = await snapshot.readFile(blobPath(expectedHash)); raw.scan(png);
    const pngUnchanged = Buffer.from(png).equals(Buffer.from(expectedPng)); assert.ok(pngUnchanged);
    const authorization = fixture.calls.filter(call => call.route === "redirect" || call.route === "signed").map(call => call.authorized);
    assert.deepEqual(authorization, [true, false]); fixture.assertConsumed(); faults.assertReached();
    raw.log(fixture.calls); raw.log(timing.delays); raw.log(workerTrace); raw.log(events); raw.log(faults.trace);
    // The summary is the actual returned durable/pending state, never an invented publisher status.
    const summary = JSON.stringify({admission: result.admission.status, projection: result.projection,
      coverage: run.coverage.status, missingParts: run.coverage.missingParts.length}); raw.summary(summary);
    const evidence: Evidence = {events, runs: snapshot.store.runs.map(entry => entry.runKey), attempts: [result.admission.attempts],
      beforeTip, afterTip: snapshot.tip, summary, authorization, coverage: run.coverage.status, logs: raw.capture.logs};
    definition.verify(evidence); remote.assertCleanFiles(); raw.clean();
    const normalized = JSON.stringify({caseKey, seed, evidence, schedule: fixture.schedule, faults: faults.trace,
      calls: fixture.calls, delays: timing.delays, stored, run, canonicalRunSha256: digest(canonicalRun), now: timing.clock.now,
      deadlines: timing.evidence(), facts: {requestCounts: fixture.requestCounts, missing: result.diagnostics.missing,
        receivedParts: run.parts.length, missingParts: run.coverage.missingParts.length, unknownMissingCounts,
        ...counts, closedBeforePush, nativeLease, pngUnchanged, sourceProvenance, rawScans: raw.count + 1}});
    raw.scan(normalized); return {evidence, normalized};
  } catch (error) {
    try {raw.error(error); raw.clean();} catch {raw.capture.error(new Error("simulation-secret-leak"));}
    // eslint-disable-next-line preserve-caught-error -- Complete raw diagnostics are checked above; public output exposes only replay coordinates.
    throw new Error(`github-simulation-failed seed=${String(seed)} case=${CASE_KEY}`);
  } finally {for (const adapter of adapters) await adapter.close(); remote?.close();}
}

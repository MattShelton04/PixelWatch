import "../../lib/no-network.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalBytes } from "../../../packages/schemas/src/index.ts";
import { newStore, runRecordPath } from "../../../packages/core/src/index.ts";
import { GitBranchStore, writeRun, type CommitMetadata, type StoreSnapshot, type StoreTiming, type WriteRunResult, type WriterCheckpoint } from "../../../packages/store/src/index.ts";
import { Capture, CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../capture.ts";
import { Faults } from "../faults.ts";
import { Clock, Scheduler, checkpoint } from "../schedule.ts";
import ingest from "../scenarios/sim-ingest-cas-race.sim.test.ts";
import unknown from "../scenarios/sim-push-outcome-unknown.sim.test.ts";
import type { Evidence, Observation } from "../scenarios/spec.ts";
import { fixtureRun, gate, REPOSITORY_ID, StoreRemote, type Gate } from "./store-fixture.ts";

export type StoreCaseKey = "sim-ingest-cas-race/four-writers" | "sim-push-outcome-unknown/accepted-push";
const ACTORS = ["a", "b", "c", "d"] as const;
type Actor = typeof ACTORS[number];
interface Push { actor: string; expected: string; tip: string; status: string }
function clockMetadata(clock: Clock): CommitMetadata { assert.equal(clock.now, 946684800000); return { timestamp: "2000-01-01T00:00:00Z" }; }
function digest(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function virtualTiming(clock: Clock) {
  let started = 0; let disposed = 0;
  const timing: StoreTiming = { deadline: (milliseconds) => {
    assert.equal(milliseconds, 60_000); const due = clock.now + milliseconds; const controller = new AbortController(); started++; let closed = false;
    return { signal: controller.signal, dispose: () => { assert.ok(!closed && !controller.signal.aborted); assert.ok(clock.now < due); closed = true; disposed++; } };
  } };
  return { timing, evidence: () => { assert.ok(started > 0); assert.equal(started, disposed); return { started, disposed }; } };
}
/** Plans concrete async checkpoint releases; OS completion order never selects a push or drain. */
function planRace(seed: number) {
  const schedule = new Scheduler(seed); const reads: Actor[] = []; const pushes: Actor[] = []; const drains: Actor[] = [];
  schedule.barrier("fetched", ACTORS); schedule.barrier("advanced", ACTORS); schedule.barrier("pushed", ACTORS);
  for (const actor of ACTORS) schedule.add(actor, function* () {
    yield checkpoint("ingest-same-tip", () => { reads.push(actor); }, "fetched");
    // a's declared conflict needs a real earlier ref advance; b supplies that advance.
    if (actor === "b") yield checkpoint("push", () => { pushes.push(actor); });
    yield checkpoint("advanced", undefined, "advanced");
    if (actor !== "b") yield checkpoint("push", () => { pushes.push(actor); });
    yield checkpoint("pushed", undefined, "pushed");
    yield checkpoint("drain", () => { drains.push(actor); });
  }); schedule.run(); return { schedule, reads, pushes, drains };
}
class RawCapture {
  readonly capture = new Capture(); readonly raw: (string | Uint8Array)[] = [];
  log(value: unknown): void { const text = JSON.stringify(value); assertNoSecrets([text]); this.raw.push(text); this.capture.log(text); }
  summary(text: string): void { assertNoSecrets([text]); this.raw.push(text); this.capture.summary(text); }
  error(error: unknown): void { const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown-error"; assertNoSecrets([text]); this.raw.push(text); this.capture.error(error); }
  async stored(snapshot: StoreSnapshot): Promise<{ path: string; sha256: string }[]> {
    const files: { path: string; sha256: string }[] = [];
    for (const [index, file] of snapshot.files.entries()) { const bytes = await snapshot.readFile(file.path); assertNoSecrets([file.path, bytes]); this.raw.push(bytes); this.capture.store(`file-${String(index)}.json`, Buffer.from(bytes).toString("utf8")); files.push({ path: file.path, sha256: digest(bytes) }); } return files;
  }
  clean(): void { assertNoSecrets(this.raw); this.capture.assertClean(); }
}
async function marked(remote: StoreRemote, metadata: CommitMetadata, timing: StoreTiming, adapters: GitBranchStore[]): Promise<GitBranchStore> {
  const adapter = new GitBranchStore({ remote: remote.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main", testRemote: { root: remote.root }, timing }); adapters.push(adapter);
  const store = newStore(REPOSITORY_ID); assert.equal((await adapter.cas(null, { store, runs: new Map(), files: new Map([["store.json", canonicalBytes(store)]]), metadata })).status, "accepted"); return adapter;
}
async function race(seed: number): Promise<{ evidence: Evidence; normalized: string }> {
  const plan = planRace(seed); const definition = ingest.cases[0]; assert.ok(definition);
  const faults = new Faults(definition.faults); const clock = new Clock(); const timing = virtualTiming(clock); const metadata = clockMetadata(clock); const remote = new StoreRemote(); const adapters: GitBranchStore[] = []; const raw = new RawCapture();
  const tasks = new Map<Actor, Promise<WriteRunResult>>(); const gates = new Map<Actor, { read: Gate; resume: Gate; prepared: Gate; push: Gate; pushed: Gate; drain: Gate }>();
  const events: Observation[] = []; const pushes: Push[] = []; const writerTrace: { actor: Actor; event: WriterCheckpoint }[] = []; const delays: { actor: Actor; milliseconds: number; now: number }[] = [];
  let initialTip = ""; let draining: Actor | undefined;
  try {
    const observer = await marked(remote, metadata, timing.timing, adapters); initialTip = remote.tip();
    for (const actor of ACTORS) gates.set(actor, { read: gate(), resume: gate(), prepared: gate(), push: gate(), pushed: gate(), drain: gate() });
    for (const actor of plan.reads) {
      const windows = gates.get(actor); assert.ok(windows); let first = true;
      const adapter = new GitBranchStore({ remote: remote.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main", testRemote: { root: remote.root }, timing: timing.timing, checkpoint: async (event) => {
        if (event.point === "before-push") {
          if (first) { assert.equal(event.expectedTip, initialTip); windows.prepared.release(); await windows.push.promise; }
          else assert.equal(draining, actor);
          if (actor === "a" && first) { assert.notEqual(remote.tip(), initialTip); assert.equal(faults.hit(actor, "ingest-same-tip"), "conflict"); }
        } else {
          assert.ok(event.expectedTip); const push = { actor, expected: event.expectedTip, tip: event.newTip, status: event.result ?? "missing" }; pushes.push(push); raw.log(push);
          events.push({ kind: "push", actor, expected: event.expectedTip, tip: event.newTip });
          if (first) { if (actor === "a") assert.equal(event.result, "conflict"); first = false; windows.pushed.release(); await windows.drain.promise; }
        }
      } }); adapters.push(adapter);
      const task = writeRun(adapter, { run: fixtureRun(String(101 + ACTORS.indexOf(actor))), blobs: new Map() }, { metadata, jitter: (attempt) => (seed + attempt + actor.charCodeAt(0)) % 1001,
        delay: (milliseconds) => { clock.advance(milliseconds); const delay = { actor, milliseconds, now: clock.now }; delays.push(delay); raw.log(delay); return Promise.resolve(); }, checkpoint: async (event) => {
          writerTrace.push({ actor, event }); raw.log({ actor, event });
          if (event.point === "after-read") { assert.ok(event.tip); events.push({ kind: "fetch", actor, tip: event.tip }); if (event.attempt === 1) { windows.read.release(); await windows.resume.promise; } }
        } }); tasks.set(actor, task);
      await Promise.race([windows.read.promise, task.then(() => { throw new Error("store-simulation-read-checkpoint-missing"); })]);
    }
    // Actual production readers have arrived sequentially in scheduler order; release all before any push.
    assert.equal(events.length, 4); assert.equal(new Set(events.map((event) => event.tip)).size, 1);
    for (const actor of ACTORS) gates.get(actor)?.resume.release();
    await Promise.race([Promise.all([...gates.values()].map((value) => value.prepared.promise)), Promise.race([...tasks.values()]).then(() => { throw new Error("store-simulation-push-checkpoint-missing"); })]);
    for (const actor of plan.pushes) { const windows = gates.get(actor); const task = tasks.get(actor); assert.ok(windows && task); windows.push.release(); await Promise.race([windows.pushed.promise, task.then(() => { throw new Error("store-simulation-push-observation-missing"); })]); }
    assert.equal(pushes.length, 4); assert.equal(pushes[0]?.status, "accepted"); assert.equal(pushes.filter((push) => push.status === "conflict").length, 3);
    const results = new Map<Actor, WriteRunResult>();
    for (const actor of plan.drains) { draining = actor; const windows = gates.get(actor); const task = tasks.get(actor); assert.ok(windows && task); windows.drain.release(); results.set(actor, await task); }
    const snapshot = await observer.read(); const stored = await raw.stored(snapshot); const runs = snapshot.store.runs.map((run) => run.runKey); const attempts = ACTORS.map((actor) => { const result = results.get(actor); assert.ok(result); raw.log(result); return result.attempts; });
    const summary = "four production runs stored after three actual stale lease refusals"; raw.summary(summary); faults.assertReached(); remote.assertCleanFiles(); raw.clean();
    const evidence: Evidence = { events, runs, attempts, summary, logs: raw.capture.logs }; definition.verify(evidence);
    const normalized = JSON.stringify({ caseKey: "sim-ingest-cas-race/four-writers", seed, evidence, schedule: plan.schedule.trace, faults: faults.trace, pushes, writerTrace, delays, now: clock.now, stored, deadlines: timing.evidence(),
      facts: { sameTipBeforePush: events.slice(0, 4).every((event) => event.tip === initialTip), rejectedLeases: pushes.filter((push) => push.status === "conflict").length, unknownReturned: false, mutatedInput: false, canonicalRunUnchanged: false, retryDelays: delays.length } });
    assertNoSecrets([normalized]); return { evidence, normalized };
  } catch (error) {
    raw.error(error);
    // eslint-disable-next-line preserve-caught-error -- raw diagnostics are checked/captured; the public boundary has only a fixed case and seed.
    throw new Error(`store-simulation-failed seed=${String(seed)} case=sim-ingest-cas-race/four-writers`);
  } finally { for (const windows of gates.values()) { windows.resume.release(); windows.push.release(); windows.drain.release(); } await Promise.allSettled(tasks.values()); for (const adapter of adapters) adapter.close(); remote.close(); }
}
async function lostReply(seed: number): Promise<{ evidence: Evidence; normalized: string }> {
  const schedule = new Scheduler(seed); schedule.add("a", function* () { yield checkpoint("fetch"); yield checkpoint("push-accepted"); yield checkpoint("recover"); }); schedule.run();
  const definition = unknown.cases[0]; assert.ok(definition); const faults = new Faults(definition.faults); const clock = new Clock(); const timing = virtualTiming(clock); const metadata = clockMetadata(clock); const remote = new StoreRemote(); const adapters: GitBranchStore[] = []; const raw = new RawCapture();
  const events: Observation[] = []; const pushes: Push[] = []; const input = { run: fixtureRun("101"), blobs: new Map<string, Uint8Array>() }; const acceptedBytes = canonicalBytes(input.run); let acceptedTip = ""; let unknownReturned = false; let mutatedInput = false; let delays = 0; let jitters = 0;
  const observed = () => ({ unknownReturned, mutatedInput });
  try {
    const observer = await marked(remote, metadata, timing.timing, adapters); const initialTip = remote.tip();
    const adapter = new GitBranchStore({ remote: remote.remote, repositoryId: REPOSITORY_ID, defaultBranch: "main", testRemote: { root: remote.root }, timing: timing.timing, checkpoint: (event) => {
      if (event.point === "after-push") {
        assert.equal(event.result, "accepted"); assert.ok(event.expectedTip); assert.equal(event.expectedTip, initialTip); assert.equal(remote.tip(), event.newTip); assert.notEqual(event.newTip, initialTip); acceptedTip = event.newTip;
        const push = { actor: "a", expected: event.expectedTip, tip: event.newTip, status: event.result }; pushes.push(push); raw.log(push); events.push({ kind: "push", actor: "a", expected: event.expectedTip, tip: event.newTip });
        assert.equal(faults.hit("a", "push-accepted"), "accepted-timeout");
        // This secret-bearing injected reply is private to the product. Its public unknown result is scanned below.
        throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);
      } return Promise.resolve();
    } }); adapters.push(adapter);
    const result = await writeRun(adapter, input, { metadata, jitter: (attempt) => { jitters++; return (seed + attempt) % 1001; }, delay: (milliseconds) => { delays++; clock.advance(milliseconds); return Promise.resolve(); }, checkpoint: (event) => {
      raw.log(event);
      if (event.point === "after-read" || event.point === "after-unknown-read") { assert.ok(event.tip); events.push({ kind: "fetch", actor: "a", tip: event.tip }); }
      if (event.point === "after-cas" && event.result === "unknown") { unknownReturned = true; input.run.claims = {}; input.run.source.createdAt = "2001-01-01T00:00:00Z"; input.blobs.set("../../../untrusted.txt", Buffer.from(`${CANARY_TOKEN} ${SIGNED_URL}`)); mutatedInput = true; }
      return Promise.resolve();
    } }); raw.log(result);
    const snapshot = await observer.read(); const stored = await raw.stored(snapshot); const storedRun = await snapshot.readFile(runRecordPath("101-a1")); const canonicalRunUnchanged = Buffer.from(storedRun).equals(Buffer.from(acceptedBytes));
    assert.ok(observed().unknownReturned && observed().mutatedInput && canonicalRunUnchanged); assert.ok(Buffer.from(canonicalBytes(result.run)).equals(Buffer.from(acceptedBytes))); assert.equal(result.attempts, 1); assert.equal(result.added, false); assert.equal(delays, 0); assert.equal(jitters, 0); assert.equal(result.tip, acceptedTip); assert.equal(snapshot.tip, acceptedTip); assert.equal(remote.tip(), acceptedTip);
    const summary = "accepted production push rediscovered without retry or changed canonical run"; raw.summary(summary); faults.assertReached(); remote.assertCleanFiles(); raw.clean();
    const evidence: Evidence = { events, runs: snapshot.store.runs.map((run) => run.runKey), attempts: [result.attempts], beforeTip: acceptedTip, afterTip: snapshot.tip, summary, logs: raw.capture.logs }; definition.verify(evidence);
    const normalized = JSON.stringify({ caseKey: "sim-push-outcome-unknown/accepted-push", seed, evidence, schedule: schedule.trace, faults: faults.trace, pushes, stored, acceptedRunSha256: digest(acceptedBytes), now: clock.now, deadlines: timing.evidence(),
      facts: { sameTipBeforePush: true, rejectedLeases: 0, unknownReturned, mutatedInput, canonicalRunUnchanged, retryDelays: delays } }); assertNoSecrets([normalized]); return { evidence, normalized };
  } catch (error) {
    raw.error(error);
    // eslint-disable-next-line preserve-caught-error -- raw diagnostics are checked/captured; the public boundary has only a fixed case and seed.
    throw new Error(`store-simulation-failed seed=${String(seed)} case=sim-push-outcome-unknown/accepted-push`);
  } finally { for (const adapter of adapters) adapter.close(); remote.close(); }
}
export async function runStoreCase(caseKey: StoreCaseKey, seed: number): Promise<{ evidence: Evidence; normalized: string }> {
  try {
    switch (caseKey) {
      case "sim-ingest-cas-race/four-writers": return await race(seed);
      case "sim-push-outcome-unknown/accepted-push": return await lostReply(seed);
      default: throw new Error("store-simulation-case-unknown");
    }
  } catch (error) {
    const capture = new Capture(); try { const message = error instanceof Error ? error.message : "unknown-error"; assertNoSecrets([message]); capture.error(error); } catch { capture.error(new Error("simulation-secret-leak")); }
    // eslint-disable-next-line preserve-caught-error -- all public failures include replay seed/case; an unsafe cause is never exposed.
    throw new Error(`store-simulation-failed seed=${String(seed)} case=${caseKey}: ${capture.errors.at(-1) ?? "unknown-error"}`);
  }
}

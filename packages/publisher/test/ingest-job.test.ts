/* eslint-disable @typescript-eslint/unbound-method -- Tests intentionally extract hostile methods and call them with explicit Reflect.apply receivers. */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { getEventListeners } from "node:events";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes } from "@pixelwatch/schemas";
import { compareImages, decodePng, encodePng, normalizeRgba, PngError } from "@pixelwatch/core";
import { GitHubClient, type ArtifactDescriptor, type HttpResponse, type Timing } from "@pixelwatch/forge-github";
import { GitBranchStore, LocalDirStore, type GitCheckpoint, type StoreAdapter, type StoreTiming } from "@pixelwatch/store";
import { Scratch } from "../../store/test/helpers.ts";
import { artifact, tinyPng } from "../../core/test/ingest-fixtures.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { ingestJob } from "../src/ingest-job.ts";
import { PublisherError, type SourceJobDependencies, type SourceJobInput } from "../src/types.ts";
const roots: string[] = [];
const scratches: Scratch[] = [];
const clients: GitBranchStore[] = [];
const raw: (string | Uint8Array)[] = [];
let scannedValues = 0, scannedBytes = 0, scanFailures = 0;
afterEach(() => {
  let failure: Error | undefined;
  try {
    const values = raw.splice(0);
    scannedValues += values.length;
    for (const value of values)
      scannedBytes += typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    assertNoSecrets(values);
  }
  catch (error) {
    scanFailures++;
    failure = error instanceof Error ? error : new Error("secret scan failed");
  }
  try {
    for (const client of clients.splice(0))
      client.close();
    for (const scratch of scratches.splice(0))
      scratch.close();
    for (const root of roots.splice(0)) {
      const target = resolve(root), rel = relative(resolve(tmpdir()), target);
      if (isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith("pixelwatch-store-ingress-"))
        throw new Error("unsafe cleanup");
      rmSync(target, { recursive: true, force: true });
    }
  }
  catch (error) {
    failure ??= error instanceof Error ? error : new Error("fixture cleanup failed");
  }
  if (failure !== undefined)
    throw failure;
});
afterAll(() => {
  console.info(JSON.stringify({ sourceJobRawScan: {
      values: scannedValues, bytes: scannedBytes, failures: scanFailures
    } }));
});
function present<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined)
    throw new Error("missing fixture");
  return value;
}
/** Register the producer reaction before the source job's fulfillment handler. */
function mutateAfterFulfillment<T>(pending: Promise<T>, mutation: (value: T) => void): Promise<T> {
  void pending.then(value => {
    queueMicrotask(() => {
      mutation(value);
    });
  }, () => {
  });
  return pending;
}
const head = "a".repeat(40), base = "b".repeat(40), time = "2026-10-03T00:00:00Z", repo = {
  id: 42, full_name: "owner/repo", default_branch: "main"
};
const json = (value: unknown): HttpResponse => ({
  status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value))
});
const part = (revision: "base" | "head" = "head", index = 1, count = 1, id = "1", seed = 1) => artifact({
  attempt: "7", revision, providerId: "p", shard: [index, count], units: [{
      viewId: `v${String(index)}`, state: "captured", png: tinyPng(seed)
    }]
}, { id });
function fixture(kind: "local" | "git" = "local", baseline = false, parts = [part()], checkpoint?: (event: GitCheckpoint) => Promise<void>, suppliedStore?: StoreAdapter) {
  const trace: string[] = [];
  const controller = new AbortController();
  const sourceRun = {
    id: 99, workflow_id: 101, run_attempt: 7, event: "push", status: "completed", created_at: time, head_sha: head, head_branch: "main", path: ".github/workflows/capture.yml", repository: repo, head_repository: repo, head_commit: { id: head }, pull_requests: []
  };
  const input: SourceJobInput = {
    config: {
      schemaVersion: 1, source: { workflowIds: ["101"], events: ["push"] }, providers: [{ id: "p", shards: 1 }]
    }, configCommit: "3".repeat(40), pages: { url: "https://owner.github.io/repo/", host: "owner.github.io" }, repository: {
      repositoryId: "42", owner: "owner", name: "repo"
    }, assets: {
      release: "0.1.0-rc.1", releaseCommit: "4".repeat(40), script: new TextEncoder().encode("globalThis.pixelwatch = true;")
    }, event: new TextEncoder().encode(JSON.stringify({
      action: "completed", repository: repo, workflow_run: sourceRun
    }))
  };
  const responses = new Map<string, HttpResponse>();
  const api = "https://api.github.com/repos/owner/repo";
  for (const [path, value] of [["", repo], ["/actions/runs/99", sourceRun], ["/actions/runs/99/attempts/7", sourceRun], ["/actions/workflows/101", { id: 101, path: sourceRun.path }], [`/commits/${head}`, { sha: head, parents: baseline ? [{ sha: base }] : [] }]] as const)
    responses.set(api + path, json(value));
  const metadata = parts.map(value => ({
    id: Number(value.artifactId), name: value.artifactName, size_in_bytes: value.zip.byteLength, expired: false
  }));
  const list = () => responses.set(`${api}/actions/runs/99/artifacts?per_page=100&page=1`, json({ total_count: metadata.length, artifacts: metadata }));
  list();
  for (const value of parts)
    responses.set(`${api}/actions/artifacts/${value.artifactId}/zip`, {
      status: 200, headers: {}, body: value.zip
    });
  const timing: Timing = { deadline: () => ({ signal: new AbortController().signal, dispose: () => {
      } }), delay: () => Promise.resolve() };
  const forge = new GitHubClient({
    owner: "owner", repo: "repo", repositoryId: "42", token: CANARY_TOKEN, timing, transport: { request: call => {
        trace.push(`api:${new URL(call.url).pathname}`);
        const response = responses.get(call.url);
        if (response === undefined)
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        return Promise.resolve(response);
      } }
  });
  let store: StoreAdapter;
  if (suppliedStore !== undefined)
    store = suppliedStore;
  else if (kind === "git") {
    const scratch = new Scratch();
    scratches.push(scratch);
    const storeTiming: StoreTiming = { deadline: () => {
        trace.push("git-deadline");
        return { signal: new AbortController().signal, dispose: () => trace.push("git-dispose") };
      } };
    const git = new GitBranchStore({
      remote: scratch.remote, repositoryId: "42", defaultBranch: "main", testRemote: { root: scratch.root }, timing: storeTiming, ...(checkpoint === undefined ? {} : { checkpoint })
    });
    clients.push(git);
    store = git;
  }
  else {
    const root = mkdtempSync(join(tmpdir(), "pixelwatch-store-ingress-"));
    roots.push(root);
    store = new LocalDirStore({
      directory: root, repositoryId: "42", defaultBranch: "main"
    });
  }
  const actualStore = store;
  let cas = 0, decodes = 0, encodes = 0, compares = 0, closes = 0, active = 0, maxActive = 0;
  let deadlineCalls = 0, disposed = 0;
  const work = async <T>(label: string, operation: () => T | Promise<T>): Promise<T> => {
    active++;
    maxActive = Math.max(maxActive, active);
    trace.push(label);
    try {
      return await operation();
    }
    finally {
      active--;
    }
  };
  const worker: NonNullable<SourceJobDependencies["worker"]> = {
    decode: bytes => work("decode", () => {
      decodes++;
      return decodePng(bytes);
    }), encode: image => work("encode", () => {
      encodes++;
      return encodePng(image);
    }), compare: (a, b, policy) => work("compare", () => {
      compares++;
      return compareImages(a, b, policy);
    }), close: () => {
      closes++;
      trace.push("close");
      return Promise.resolve();
    }
  };
  const deps: SourceJobDependencies = {
    forge, store: { read: () => actualStore.read(), cas: (tip, candidate) => {
        trace.push("cas");
        cas++;
        return actualStore.cas(tip, candidate);
      } }, worker,
    admission: {
      now: time, metadata: { timestamp: time }, prStates: new Map(), pins: new Set(), delay: ms => {
        trace.push(`delay:${String(ms)}`);
        return Promise.resolve();
      }, jitter: () => 42
    },
    timing: { deadline: ms => {
        expect(ms).toBe(600000);
        deadlineCalls++;
        return { signal: controller.signal, dispose: () => {
            disposed++;
            trace.push("dispose");
          } };
      } }
  };
  const counters = () => ({
    cas, decodes, encodes, compares, closes, maxActive, deadlineCalls, disposed
  });
  return {
    input, deps, forge, store: actualStore, controller, trace, counters, parts, metadata, list, responses, api
  };
}
function sourceAttempt(f: ReturnType<typeof fixture>, id: string, createdAt: string): void {
  const original = JSON.parse(Buffer.from(present(f.responses.get(`${f.api}/actions/runs/99`)).body).toString("utf8")) as Record<string, unknown>;
  const run = {
    ...original, id: Number(id), created_at: createdAt
  };
  for (const path of [`/actions/runs/${id}`, `/actions/runs/${id}/attempts/7`])
    f.responses.set(f.api + path, json(run));
  f.responses.set(`${f.api}/actions/runs/${id}/artifacts?per_page=100&page=1`, present(f.responses.get(`${f.api}/actions/runs/99/artifacts?per_page=100&page=1`)));
  (f.input as {
    event: Uint8Array;
  }).event = canonicalBytes({
    action: "completed", repository: repo, workflow_run: run
  });
}
async function success(f: ReturnType<typeof fixture>) {
  const result = await ingestJob(f.input, f.deps);
  raw.push(inspect(result, { depth: 20 }), JSON.stringify(result), JSON.stringify(f.trace), JSON.stringify(f.counters()));
  const snapshot = await f.store.read();
  for (const file of snapshot.files)
    raw.push(await snapshot.readFile(file.path));
  return { result, snapshot };
}
async function failure(f: ReturnType<typeof fixture>, code?: string) {
  let error: unknown;
  try {
    await ingestJob(f.input, f.deps);
  }
  catch (value) {
    error = value;
  }
  raw.push(inspect(error, { showHidden: true, depth: 10 }), JSON.stringify(f.trace), JSON.stringify(f.counters()));
  expect(error).toBeInstanceOf(PublisherError);
  if (code !== undefined)
    expect((error as PublisherError).code).toBe(code);
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  return error;
}
describe("production source job", () => {
  it.each(["local", "git"] as const)("authenticates actual API source and stores canonical pixels through native %s CAS", async (kind) => {
    const f = fixture(kind);
    const { result, snapshot } = await success(f);
    expect(result.projection).toBe("pending");
    expect(result.admission.status).toBe("stored");
    const run = snapshot.runs.get("99-a7");
    expect(run?.source).toMatchObject({
      repositoryId: "42", workflowId: "101", runId: "99", attempt: "7", createdAt: time, configSha: f.input.configCommit, releaseSha: f.input.assets.releaseCommit, commits: { head }
    });
    expect(run?.counts.incomparable).toBe(1);
    expect(snapshot.runs.size).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 1, decodes: 1, encodes: 1, closes: 1, maxActive: 1, deadlineCalls: 1, disposed: 1
    });
    expect(f.trace.indexOf("close")).toBeLessThan(f.trace.indexOf("cas"));
  }, 0);
  it("preserves unique opaque API descriptors and never downloads duplicated or ignored parts", async () => {
    const a = part("head", 1, 3, "1"), b = part("head", 2, 3, "2"), c = part("head", 3, 3, "3"), d = { ...c, artifactId: "4" }, ignored = {
      ...a, artifactId: "5", artifactName: "other-results"
    };
    const f = fixture("local", false, [a, b, c, d, ignored]);
    present(f.input.config.providers[0]).shards = 3;
    present(f.metadata[1]).expired = true;
    f.list();
    const original = f.forge.downloadArtifacts;
    let selections = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: input => f.forge.verifySource(input), listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: (selected, signal) => {
          selections++;
          expect(selected.map(value => value.artifactId)).toEqual(["1", "2"]);
          return Reflect.apply(original, f.forge, [selected, signal]);
        }
      } };
    const { result, snapshot } = await success(f);
    expect(selections).toBe(1);
    expect(result.diagnostics.missing).toEqual([{ artifactId: "2", reason: "expired" }]);
    expect(result.diagnostics.ignored).toEqual([{ artifactId: "5", reason: "not-pixelwatch" }]);
    expect(snapshot.runs.get("99-a7")?.coverage.status).toBe("incomplete");
    expect(f.trace.filter(value => value.includes("/actions/artifacts/"))).toEqual(["api:/repos/owner/repo/actions/artifacts/1/zip"]);
  });
  it("stores unknown catalog coverage when no usable artifact was listed", async () => {
    const f = fixture("local", false, []);
    const { snapshot } = await success(f);
    expect(snapshot.runs.get("99-a7")?.coverage.status).toBe("unknown");
    expect(snapshot.runs.get("99-a7")?.results).toEqual([]);
    expect(f.counters()).toMatchObject({
      decodes: 0, encodes: 0, compares: 0, closes: 1, cas: 1
    });
  });
  it.each(["config", "source", "store", "bundle"] as const)("refuses unknown or mismatched %s before any durable mutation", async (variant) => {
    const f = fixture();
    if (variant === "config")
      (f.input.config as {
        schemaVersion: number;
      }).schemaVersion = 2;
    else if (variant === "source") {
      const event = JSON.parse(Buffer.from(f.input.event).toString("utf8")) as {
        workflow_run: {
          workflow_id: number;
        };
      };
      event.workflow_run.workflow_id = 202;
      (f.input as {
        event: Uint8Array;
      }).event = canonicalBytes(event);
    }
    else if (variant === "store") {
      const before = await f.store.read();
      f.deps = { ...f.deps, store: { read: () => Promise.resolve({ ...before, store: { ...before.store, dataVersion: 2 } as unknown as typeof before.store }), cas: () => {
            throw new Error(CANARY_TOKEN);
          } } };
    }
    else {
      const future = artifact({
        attempt: "7", revision: "head", providerId: "p", shard: [1, 1], units: [{ viewId: "v1", state: "captured" }]
      }, { id: "1", edit: value => ({ ...value, schemaVersion: 2 }) });
      f.responses.set(`${f.api}/actions/artifacts/1/zip`, {
        status: 200, headers: {}, body: future.zip
      });
      present(f.metadata[0]).size_in_bytes = future.zip.byteLength;
      f.list();
    }
    await failure(f);
    expect(f.counters()).toMatchObject({
      cas: 0, decodes: 0, encodes: 0
    });
    expect((await f.store.read()).tip).toBe(null);
  });
  it.each(["traversal", "active"] as const)("rejects hostile %s archives without serving capture attachments", async (variant) => {
    const f = fixture();
    const bytes = readFileSync(new URL(`../../../testdata/zip/hostile/${variant === "traversal" ? "name-traversal-dotdot" : "extra-file-app-js"}.zip`, import.meta.url));
    f.responses.set(`${f.api}/actions/artifacts/1/zip`, {
      status: 200, headers: {}, body: bytes
    });
    present(f.metadata[0]).size_in_bytes = bytes.byteLength;
    f.list();
    const { snapshot } = await success(f);
    expect(snapshot.runs.get("99-a7")?.coverage.status).toBe("unknown");
    expect(snapshot.files.some(value => value.path.endsWith(".html") || value.path.endsWith(".js"))).toBe(false);
    expect(f.counters().decodes).toBe(0);
  });
  it("compares both actual captured sides sequentially with the configured comparator", async () => {
    const f = fixture("local", true, [part("base", 1, 1, "1", 1), part("head", 1, 1, "2", 2)]);
    const { snapshot } = await success(f);
    const run = snapshot.runs.get("99-a7");
    expect(run?.results[0]?.status).toBe("changed");
    expect(run?.results[0]?.diff?.analyses).toHaveLength(4);
    expect(f.counters()).toMatchObject({
      compares: 1, decodes: 4, maxActive: 1, closes: 1
    });
  });
  it("reuses validated canonical blobs without extra encoding or reuse-only decoding", async () => {
    const f = fixture();
    const first = await success(f);
    const firstBlob = present(first.snapshot.files.find(value => value.path.startsWith("blobs/")));
    const original = await first.snapshot.readFile(firstBlob.path);
    const event = JSON.parse(Buffer.from(f.input.event).toString("utf8")) as {
      workflow_run: {
        id: number;
      };
    };
    event.workflow_run.id = 100;
    for (const path of ["/actions/runs/99", "/actions/runs/99/attempts/7"]) {
      const response = present(f.responses.get(f.api + path));
      const run = JSON.parse(Buffer.from(response.body).toString("utf8")) as {
        id: number;
      };
      run.id = 100;
      f.responses.set(f.api + path.replace("99", "100"), json(run));
    }
    f.responses.set(`${f.api}/actions/runs/100/artifacts?per_page=100&page=1`, present(f.responses.get(`${f.api}/actions/runs/99/artifacts?per_page=100&page=1`)));
    (f.input as {
      event: Uint8Array;
    }).event = canonicalBytes(event);
    const second = await success(f);
    expect(second.snapshot.runs.size).toBe(2);
    expect(f.counters()).toMatchObject({
      decodes: 2, encodes: 1, closes: 2
    });
    expect(await second.snapshot.readFile(firstBlob.path)).toEqual(original);
  });
  it.each(["source", "download", "decode", "compare"] as const)("races an ignored %s cancellation signal and closes the worker without mutation", async (stage) => {
    const f = fixture("local", stage === "compare", stage === "compare" ? [part("base", 1, 1, "1", 1), part("head", 1, 1, "2", 2)] : [part()]);
    let reached = 0;
    const hang = () => {
      reached++;
      f.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
      return new Promise<never>(() => {
      });
    };
    if (stage === "source")
      f.deps = { ...f.deps, forge: {
          verifySource: hang, listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: (selected, signal) => f.forge.downloadArtifacts(selected, signal)
        } };
    else if (stage === "download")
      f.deps = { ...f.deps, forge: {
          verifySource: input => f.forge.verifySource(input), listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: hang
        } };
    else
      f.deps = { ...f.deps, worker: { ...present(f.deps.worker), [stage]: hang } };
    await failure(f, "source-job-cancelled");
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 0, closes: 1, deadlineCalls: 1, disposed: 1
    });
  });
  it("captures trusted bytes methods and context once before asynchronous source callbacks", async () => {
    const f = fixture();
    const original = f.forge.verifySource;
    let binds = 0, gets = 0;
    const verify = function (this: object, ...args: Parameters<typeof original>) {
      expect(this).toBe(port);
      f.input.assets.script.fill(0);
      f.input.event.fill(0);
      f.input.config.providers = [];
      return Reflect.apply(original, f.forge, args);
    };
    Object.defineProperty(verify, "bind", { get() {
        binds++;
        throw new Error(CANARY_TOKEN);
      } });
    const port = {
      ...f.deps.forge, get verifySource() {
        gets++;
        return verify;
      }, listArtifacts: (id: string, signal?: AbortSignal) => f.forge.listArtifacts(id, signal), downloadArtifacts: (selected: readonly ArtifactDescriptor[], signal?: AbortSignal) => f.forge.downloadArtifacts(selected, signal)
    };
    f.deps = { ...f.deps, forge: port };
    const { snapshot } = await success(f);
    expect(snapshot.runs.get("99-a7")?.source.configSha).toBe("3".repeat(40));
    expect(gets).toBe(1);
    expect(binds).toBe(0);
  });
  it("a worker cleanup failure refuses before CAS and never exposes callback aliases", async () => {
    const f = fixture();
    let reached = 0;
    const error = new PngError("worker-crash", CANARY_TOKEN + SIGNED_URL);
    f.deps = { ...f.deps, worker: { ...present(f.deps.worker), close: () => {
          reached++;
          return Promise.reject(error);
        } } };
    await failure(f, "source-job-codec-failed");
    expect(reached).toBe(1);
    expect(f.counters().cas).toBe(0);
  });
  it("bounds conflicting admission and preserves truthful lost accepted reply status", async () => {
    for (const outcome of ["conflict", "unknown"] as const) {
      const f = fixture();
      let reached = 0;
      const original = f.deps.store;
      f.deps = { ...f.deps, store: { read: () => original.read(), async cas(tip, candidate) {
            reached++;
            if (outcome === "conflict" && reached === 1)
              return { status: "conflict" };
            const actual = await original.cas(tip, candidate);
            return outcome === "unknown" ? { status: "unknown", ...(actual.status === "accepted" ? { attemptedTip: actual.tip } : {}) } : actual;
          } } };
      const { result } = await success(f);
      expect(result.admission.status).toBe("stored");
      expect(reached).toBe(outcome === "conflict" ? 2 : 1);
      expect(f.counters().closes).toBe(1);
    }
  });
  it("sanitizes a poisoned codec diagnostic without reading public code message or causes", async () => {
    const f = fixture();
    const error = new PngError("signature", CANARY_TOKEN + SIGNED_URL);
    let getters = 0;
    for (const field of ["code", "message", "cause", "stack"])
      Object.defineProperty(error, field, { get() {
          getters++;
          return CANARY_TOKEN + SIGNED_URL;
        } });
    f.deps = { ...f.deps, worker: { ...present(f.deps.worker), decode: () => Promise.reject(error) } };
    const { snapshot } = await success(f);
    expect(getters).toBe(0);
    expect(snapshot.runs.get("99-a7")?.parts[0]?.diagnostic).toContain("signature");
    expect(f.counters().cas).toBe(1);
  });
  it("uses injected timing and actual pure codec without ambient clocks randomness or credential access", async () => {
    const f = fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout"), random = vi.spyOn(Math, "random"), now = vi.spyOn(Date, "now");
    const originalEnvironment = process.env;
    let credentialReads = 0;
    process.env = new Proxy(originalEnvironment, { get(target, key, receiver) {
        if (key === "GH_TOKEN" || key === "GITHUB_TOKEN") {
          credentialReads++;
          throw new Error("ambient credential access refused");
        }
        return Reflect.get(target, key, receiver) as unknown;
      } });
    try {
      await success(f);
      expect(timeout).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(credentialReads).toBe(0);
    }
    finally {
      process.env = originalEnvironment;
      timeout.mockRestore();
      random.mockRestore();
      now.mockRestore();
    }
  });
  it("uses the actual default PNG worker and finishes its cleanup before native CAS", async () => {
    const f = fixture("local", true, [part("base", 1, 1, "1", 1), part("head", 1, 1, "2", 2)]);
    const { worker: unused, ...deps } = f.deps;
    expect(unused).toBeDefined();
    f.deps = deps;
    const { snapshot, result } = await success(f);
    expect(snapshot.runs.get("99-a7")?.counts.changed).toBe(1);
    expect(result.admission.status).toBe("stored");
    expect(f.counters()).toMatchObject({
      cas: 1, decodes: 0, encodes: 0, compares: 0, disposed: 1
    });
  }, 0);
  it.each(["repository", "config", "release", "workflow", "event"] as const)("rejects a returned authenticated envelope with mismatched %s before store or artifact reads", async (field) => {
    const f = fixture();
    let reached = 0, storeReads = 0, lists = 0;
    const original = f.forge.verifySource;
    f.deps = {
      ...f.deps, forge: {
        verifySource: async (input) => {
          reached++;
          const value = await Reflect.apply(original, f.forge, [input]);
          const envelope = { ...value.envelope };
          if (field === "repository")
            envelope.repositoryId = "43";
          else if (field === "config")
            envelope.configSha = "5".repeat(40);
          else if (field === "release")
            envelope.releaseSha = "6".repeat(40);
          else if (field === "workflow")
            envelope.workflowId = "202";
          else
            (envelope as unknown as {
              event: string;
            }).event = "future-event";
          return { ...value, envelope };
        }, listArtifacts: () => {
          lists++;
          return Promise.reject(new Error(CANARY_TOKEN));
        }, downloadArtifacts: () => Promise.reject(new Error(SIGNED_URL))
      }, store: { read: () => {
          storeReads++;
          return f.store.read();
        }, cas: () => Promise.reject(new Error(CANARY_TOKEN)) }
    };
    await failure(f, "source-job-source-invalid");
    expect({
      reached, storeReads, lists
    }).toEqual({
      reached: 1, storeReads: 0, lists: 0
    });
    expect(f.counters().closes).toBe(1);
  });
  it("rejects all downloaded identity mismatches before reading any sibling ZIP bytes", async () => {
    const f = fixture("local", false, [part("head", 1, 2, "1"), part("head", 2, 2, "2")]);
    present(f.input.config.providers[0]).shards = 2;
    let selected = 0, zipReads = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: input => f.forge.verifySource(input), listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: descriptors => {
          selected++;
          expect(descriptors.map(value => value.artifactId)).toEqual(["1", "2"]);
          return Promise.resolve({ artifacts: [{
                artifactId: "1", artifactName: present(f.parts[0]).artifactName, get zip(): Uint8Array {
                  zipReads++;
                  throw new Error(CANARY_TOKEN + SIGNED_URL);
                }
              }, {
                artifactId: "2", artifactName: "mismatched-name", zip: present(f.parts[1]).zip
              }], missing: [] });
        }
      } };
    await failure(f, "source-job-download-invalid");
    expect({ selected, zipReads }).toEqual({ selected: 1, zipReads: 0 });
    expect(f.counters()).toMatchObject({
      decodes: 0, encodes: 0, cas: 0, closes: 1
    });
  });
  it("preflights every selected bundle version before decoding a valid sibling", async () => {
    const valid = part("head", 1, 2, "1"), future = artifact({
      attempt: "7", revision: "head", providerId: "p", shard: [2, 2], units: [{
          viewId: "v2", state: "captured", png: tinyPng(1)
        }]
    }, { id: "2", edit: value => ({ ...value, schemaVersion: 2 }) });
    const f = fixture("local", false, [valid, future]);
    present(f.input.config.providers[0]).shards = 2;
    await failure(f);
    expect(f.trace.filter(value => value.includes("/actions/artifacts/"))).toHaveLength(2);
    expect(f.counters()).toMatchObject({
      decodes: 0, encodes: 0, cas: 0, closes: 1, disposed: 1
    });
    expect((await f.store.read()).tip).toBe(null);
  });
  it("closes an already supplied worker when a dependency getter refuses during preflight", async () => {
    const f = fixture();
    let reached = 0;
    Object.defineProperty(f.deps, "forge", { get() {
        reached++;
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    await failure(f);
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      closes: 1, cas: 0, deadlineCalls: 1, disposed: 1
    });
  });
  it("closes the captured worker when a decode getter throws before asynchronous work", async () => {
    const f = fixture();
    let reached = 0;
    Object.defineProperty(f.deps.worker, "decode", { get() {
        reached++;
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    await failure(f);
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      closes: 1, cas: 0, deadlineCalls: 1, disposed: 1
    });
  });
  it("races a worker close that ignores abort and never starts admission", async () => {
    const f = fixture();
    let reached = 0;
    f.deps = { ...f.deps, worker: { ...present(f.deps.worker), close: () => {
          reached++;
          f.controller.abort(new Error(CANARY_TOKEN));
          return new Promise<void>(() => {
          });
        } } };
    await failure(f, "source-job-cancelled");
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({ cas: 0, disposed: 1 });
  });
  it.each(["accepted", "unknown"] as const)("preserves proven %s native CAS after cancellation without starting another write", async (outcome) => {
    const f = fixture();
    let reached = 0;
    const port = f.deps.store;
    f.deps = { ...f.deps, store: { read: () => port.read(), cas: async (tip, candidate) => {
          reached++;
          const reply = await port.cas(tip, candidate);
          expect(reply.status).toBe("accepted");
          f.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
          return outcome === "unknown" && reply.status === "accepted" ? { status: "unknown", attemptedTip: reply.tip } : reply;
        } } };
    const { result, snapshot } = await success(f);
    expect(result.admission.status).toBe("stored");
    expect(snapshot.runs.size).toBe(1);
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 1, closes: 1, disposed: 1
    });
  });
  it("reports a fixed cleanup warning while preserving a proven durable admission", async () => {
    const f = fixture();
    let disposed = 0;
    f.deps = { ...f.deps, timing: { deadline: () => ({ signal: f.controller.signal, dispose() {
            disposed++;
            throw new Error(CANARY_TOKEN + SIGNED_URL);
          } }) } };
    const { result, snapshot } = await success(f);
    expect(result.admission.status).toBe("stored");
    expect(result.diagnostics.cleanup).toEqual(["timing-disposal-failed"]);
    expect(snapshot.runs.size).toBe(1);
    expect(disposed).toBe(1);
    expect(f.counters().cas).toBe(1);
  });
  it("refuses a deadline disposal failure before admission with a fixed safe category", async () => {
    const f = fixture();
    let disposed = 0;
    f.deps = {
      ...f.deps, timing: { deadline: () => ({ signal: f.controller.signal, dispose() {
            disposed++;
            throw new Error(CANARY_TOKEN + SIGNED_URL);
          } }) }, checkpoint: point => {
        if (point === "verified")
          throw new Error(CANARY_TOKEN);
        return Promise.resolve();
      }
    };
    await failure(f, "source-job-timing-invalid");
    expect(disposed).toBe(1);
    expect(f.counters()).toMatchObject({ cas: 0, closes: 1 });
  });
  it("captures bounded API listing count and native ZIP bytes without invoking supplied map or iterators", async () => {
    const f = fixture();
    const original = f.forge.listArtifacts, download = f.forge.downloadArtifacts;
    let lengthReads = 0, maps = 0, iterators = 0, zipReads = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: input => f.forge.verifySource(input), listArtifacts: async (id, signal) => {
          const values = await Reflect.apply(original, f.forge, [id, signal]);
          return new Proxy(values, { get(target, key, receiver) {
              if (key === "length")
                lengthReads++;
              if (key === "map" || key === Symbol.iterator) {
                maps++;
                throw new Error(CANARY_TOKEN);
              }
              return Reflect.get(target, key, receiver) as unknown;
            } });
        }, downloadArtifacts: async (selected, signal) => {
          const result = await Reflect.apply(download, f.forge, [selected, signal]);
          const value = present(result.artifacts[0]);
          const bytes = value.zip;
          Object.defineProperty(bytes, Symbol.iterator, { value() {
              iterators++;
              throw new Error(CANARY_TOKEN);
            } });
          return { ...result, artifacts: [{
                artifactId: value.artifactId, artifactName: value.artifactName, get zip() {
                  zipReads++;
                  return bytes;
                }
              }] };
        }
      } };
    await success(f);
    expect({
      lengthReads, maps, iterators, zipReads
    }).toEqual({
      lengthReads: 1, maps: 0, iterators: 0, zipReads: 1
    });
  });
  it("bounds the first API listing count before any caller index or map operation", async () => {
    const f = fixture();
    let lengths = 0, indices = 0, maps = 0;
    const values = new Proxy([] as ArtifactDescriptor[], { get(target, key, receiver) {
        if (key === "length") {
          lengths++;
          return lengths === 1 ? 1025 : 0;
        }
        if (key === "0") {
          indices++;
          throw new Error(CANARY_TOKEN);
        }
        if (key === "map") {
          maps++;
          throw new Error(SIGNED_URL);
        }
        return Reflect.get(target, key, receiver) as unknown;
      } });
    f.deps = { ...f.deps, forge: {
        verifySource: input => f.forge.verifySource(input), listArtifacts: () => Promise.resolve(values), downloadArtifacts: () => Promise.reject(new Error(CANARY_TOKEN))
      } };
    await failure(f, "source-job-download-invalid");
    expect({
      lengths, indices, maps
    }).toEqual({
      lengths: 1, indices: 0, maps: 0
    });
    expect(f.counters()).toMatchObject({
      cas: 0, decodes: 0, closes: 1
    });
  });
  it("sanitizes a deadline creation failure during preflight cleanup without exposing native aliases", async () => {
    const f = fixture();
    let deadline = 0, forge = 0;
    f.deps = { ...f.deps, timing: { deadline: () => {
          deadline++;
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        } } };
    Object.defineProperty(f.deps, "forge", { get() {
        forge++;
        throw new Error(CANARY_TOKEN);
      } });
    await failure(f, "source-job-timing-invalid");
    expect({ deadline, forge }).toEqual({ deadline: 1, forge: 1 });
    expect(f.counters()).toMatchObject({ closes: 1, cas: 0 });
  });
  it.each(["source", "decode"] as const)("ignores late %s completion after cancellation and cannot resume staging or admission", async (stage) => {
    const f = fixture();
    let reached = 0;
    let finish: (() => void) | undefined;
    const verify = f.forge.verifySource, worker = present(f.deps.worker);
    if (stage === "source")
      f.deps = { ...f.deps, forge: {
          verifySource: async (input) => {
            const value = await Reflect.apply(verify, f.forge, [input]);
            return new Promise(resolve => {
              reached++;
              finish = () => {
                resolve(value);
              };
              f.controller.abort(new Error(CANARY_TOKEN));
            });
          }, listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: (selected, signal) => f.forge.downloadArtifacts(selected, signal)
        } };
    else
      f.deps = { ...f.deps, worker: { ...worker, decode: async (bytes) => {
            const value = await decodePng(bytes);
            return new Promise(resolve => {
              reached++;
              finish = () => {
                resolve(value);
              };
              f.controller.abort(new Error(CANARY_TOKEN));
            });
          } } };
    await failure(f, "source-job-cancelled");
    present(finish)();
    for (let step = 0; step < 4; step++)
      await Promise.resolve();
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 0, encodes: 0, closes: 1, disposed: 1
    });
    expect((await f.store.read()).tip).toBe(null);
  });
  it.each(["same-repo", "fork"] as const)("authenticates a real %s API PR association while untrusted claims cannot replace source commits", async (kind) => {
    const claimed = "c".repeat(40);
    const uploaded = artifact({
      attempt: "7", revision: "head", providerId: "p", shard: [1, 1], units: [{
          viewId: "v1", state: "captured", png: tinyPng(2)
        }]
    }, { id: "2", edit: value => ({ ...value, claims: { revisionSha: claimed, harnessSha: "d".repeat(40) } }) });
    const f = fixture("local", false, [part("base", 1, 1, "1", 1), uploaded]);
    f.input.config.source.events = ["pull_request"];
    const sourceRepository = kind === "fork" ? { id: 43, full_name: "contributor/repo" } : repo;
    const pull = {
      id: 301, number: 8, head: {
        sha: head, ref: "feature", repo: sourceRepository
      }, base: {
        sha: "e".repeat(40), ref: "main", repo
      }
    };
    const original = JSON.parse(Buffer.from(present(f.responses.get(`${f.api}/actions/runs/99`)).body).toString("utf8")) as Record<string, unknown>;
    const run = {
      ...original, event: "pull_request", head_branch: "feature", head_repository: sourceRepository, pull_requests: [pull]
    };
    for (const path of ["/actions/runs/99", "/actions/runs/99/attempts/7"])
      f.responses.set(f.api + path, json(run));
    f.responses.set(`${f.api}/commits/${head}/pulls?per_page=100&page=1`, json([pull]));
    f.responses.set(`${f.api}/pulls/8`, json(pull));
    f.responses.set(`${f.api}/compare/${"e".repeat(40)}...${head}`, json({ base_commit: { sha: "e".repeat(40) }, merge_base_commit: { sha: base } }));
    (f.input as {
      event: Uint8Array;
    }).event = canonicalBytes({
      action: "completed", repository: repo, workflow_run: run
    });
    const { snapshot } = await success(f);
    const accepted = present(snapshot.runs.get("99-a7"));
    expect(accepted.source.association).toEqual({ status: "corroborated", prNumber: "8" });
    expect(accepted.source.commits).toEqual({
      head, base, baseBranch: "e".repeat(40)
    });
    expect(accepted.claims.head?.revisionSha).toBe(claimed);
    expect(accepted.source.repositoryId).toBe("42");
    expect(accepted.counts.changed).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 1, compares: 1, maxActive: 1
    });
  });
  it("refuses an oversized decoded image before copying pixels encoding or staging", async () => {
    const f = fixture();
    let reached = 0, pixelReads = 0;
    f.deps = { ...f.deps, worker: { ...present(f.deps.worker), decode: () => {
          reached++;
          return Promise.resolve({
            width: 16384, height: 1, channels: 3, data: new Proxy(new Uint8Array(), { get(target, key, receiver) {
                if (key === "byteLength" || key === Symbol.iterator)
                  pixelReads++;
                return Reflect.get(target, key, receiver) as unknown;
              } })
          });
        } } };
    await failure(f);
    expect({ reached, pixelReads }).toEqual({ reached: 1, pixelReads: 0 });
    expect(f.counters()).toMatchObject({
      cas: 0, encodes: 0, closes: 1
    });
  });
  it("races cancellation while reading a reused canonical image only for actual comparison", async () => {
    const first = fixture();
    await success(first);
    const f = fixture("local", true, [part("base", 1, 1, "1", 1), part("head", 1, 1, "2", 2)]);
    let reached = 0;
    f.deps = { ...f.deps, store: { read: async () => {
          const snapshot = await first.store.read();
          const reader = snapshot.readFile;
          return { ...snapshot, readFile(path) {
              if (path.startsWith("blobs/")) {
                reached++;
                f.controller.abort(new Error(CANARY_TOKEN));
                return new Promise<Uint8Array>(() => {
                });
              }
              return Reflect.apply(reader, snapshot, [path]);
            } };
        }, cas: () => Promise.reject(new Error(CANARY_TOKEN)) } };
    await failure(f, "source-job-cancelled");
    expect(reached).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 0, decodes: 2, encodes: 1, compares: 0, closes: 1, disposed: 1
    });
    expect((await first.store.read()).runs.size).toBe(1);
  });
  it("recovers an actual accepted native Git push whose reply callback was lost", async () => {
    let pushes = 0, lostReplies = 0;
    const f = fixture("git", false, [part()], event => {
      if (event.point === "before-push")
        pushes++;
      if (event.point === "after-push") {
        lostReplies++;
        expect(event.result).toBe("accepted");
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      }
      return Promise.resolve();
    });
    const { result, snapshot } = await success(f);
    expect(result.admission.status).toBe("stored");
    expect(snapshot.runs.size).toBe(1);
    expect({ pushes, lostReplies }).toEqual({ pushes: 1, lostReplies: 1 });
    expect(f.counters()).toMatchObject({
      cas: 1, closes: 1, disposed: 1
    });
  }, 0);
  it("refuses after exactly five actual admission conflicts with deterministic backoff", async () => {
    const f = fixture();
    let reached = 0;
    const delays: number[] = [];
    f.deps = {
      ...f.deps, store: { read: () => f.store.read(), cas: () => {
          reached++;
          return Promise.resolve({ status: "conflict" });
        } }, admission: { ...f.deps.admission, delay: milliseconds => {
          delays.push(milliseconds);
          return Promise.resolve();
        } }
    };
    await failure(f, "admission-lease-exhausted");
    expect(reached).toBe(5);
    expect(delays).toEqual([142, 242, 442, 842]);
    expect((await f.store.read()).tip).toBe(null);
    expect(f.counters()).toMatchObject({ closes: 1, disposed: 1 });
  });
  it("keeps unavailable selected downloads honest without inventing received part records", async () => {
    const f = fixture();
    f.responses.set(`${f.api}/actions/artifacts/1/zip`, {
      status: 410, headers: {}, body: new Uint8Array()
    });
    const { snapshot, result } = await success(f);
    expect(result.diagnostics.missing).toEqual([{ artifactId: "1", reason: "unavailable" }]);
    expect(snapshot.runs.get("99-a7")?.parts).toEqual([]);
    expect(snapshot.runs.get("99-a7")?.coverage.missingParts[0]?.reason).toBe("not-received");
    expect(f.counters()).toMatchObject({
      decodes: 0, encodes: 0, cas: 1
    });
  });
  it("preserves a genuinely expired durable outcome and its disposal warning", async () => {
    const newer = fixture();
    newer.input.config.retention = { mainRuns: 1 };
    const original = JSON.parse(Buffer.from(present(newer.responses.get(`${newer.api}/actions/runs/99`)).body).toString("utf8")) as Record<string, unknown>;
    const run = {
      ...original, id: 100, created_at: "2026-10-04T00:00:00Z"
    };
    for (const path of ["/actions/runs/100", "/actions/runs/100/attempts/7"])
      newer.responses.set(newer.api + path, json(run));
    newer.responses.set(`${newer.api}/actions/runs/100/artifacts?per_page=100&page=1`, present(newer.responses.get(`${newer.api}/actions/runs/99/artifacts?per_page=100&page=1`)));
    (newer.input as {
      event: Uint8Array;
    }).event = canonicalBytes({
      action: "completed", repository: repo, workflow_run: run
    });
    await success(newer);
    const f = fixture();
    f.input.config.retention = { mainRuns: 1 };
    f.store = newer.store;
    let reached = 0, disposed = 0;
    f.deps = {
      ...f.deps, store: { read: () => newer.store.read(), cas: (tip, candidate) => {
          reached++;
          return newer.store.cas(tip, candidate);
        } }, timing: { deadline: () => ({ signal: f.controller.signal, dispose: () => {
            disposed++;
            throw new Error(CANARY_TOKEN + SIGNED_URL);
          } }) }
    };
    const { result, snapshot } = await success(f);
    expect(result.admission).toMatchObject({
      status: "expired", runKey: "99-a7", reason: "main-limit", attempts: 1
    });
    expect(result.projection).toBe("not-retained");
    expect(result.diagnostics.cleanup).toEqual(["timing-disposal-failed"]);
    expect([...snapshot.runs.keys()]).toEqual(["100-a7"]);
    expect({ reached, disposed }).toEqual({ reached: 1, disposed: 1 });
  });
  it("keeps private trusted policy when a source port mutates its supplied request after authentication", async () => {
    const f = fixture();
    const original = f.forge.verifySource;
    let reached = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: async (input) => {
          const result = await Reflect.apply(original, f.forge, [input]);
          reached++;
          input.config.providers = [];
          input.event.fill(0);
          return result;
        }, listArtifacts: (id, signal) => f.forge.listArtifacts(id, signal), downloadArtifacts: (selected, signal) => f.forge.downloadArtifacts(selected, signal)
      } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect(snapshot.runs.get("99-a7")?.coverage.status).toBe("complete-declared");
    expect(snapshot.runs.get("99-a7")?.results).toHaveLength(1);
    expect(f.counters()).toMatchObject({
      decodes: 1, encodes: 1, cas: 1
    });
  });
  it.each(["proxy", "symbol-accessor"] as const)("rejects a hostile native %s signal before traps source or durable writes", async (variant) => {
    const f = fixture();
    let traps = 0, source = 0, downloads = 0, cas = 0;
    const signal = variant === "proxy" ? new Proxy(f.controller.signal, { get(target, key, receiver) {
        traps++;
        return Reflect.get(target, key, receiver) as unknown;
      }, getPrototypeOf(target) {
        traps++;
        return Reflect.getPrototypeOf(target);
      } }) : Object.create(AbortSignal.prototype) as AbortSignal;
    if (variant === "symbol-accessor")
      for (const key of Object.getOwnPropertySymbols(f.controller.signal)) {
        const descriptor = Object.getOwnPropertyDescriptor(f.controller.signal, key);
        Object.defineProperty(signal, key, { configurable: true, get() {
            traps++;
            return descriptor?.value as unknown;
          } });
      }
    f.deps = {
      ...f.deps, signal, forge: {
        verifySource: () => {
          source++;
          return Promise.reject(new Error(CANARY_TOKEN));
        }, listArtifacts: () => Promise.reject(new Error(CANARY_TOKEN)), downloadArtifacts: () => {
          downloads++;
          return Promise.reject(new Error(CANARY_TOKEN));
        }
      }, store: { read: () => f.store.read(), cas: () => {
          cas++;
          return Promise.reject(new Error(CANARY_TOKEN));
        } }
    };
    await failure(f, "source-job-input-invalid");
    expect({
      traps, source, downloads, cas
    }).toEqual({
      traps: 0, source: 0, downloads: 0, cas: 0
    });
    expect(f.counters()).toMatchObject({
      closes: 1, deadlineCalls: 1, disposed: 1
    });
  });
  it.each(["accepted", "unknown"] as const)("preserves %s proof and fixed checkpoint warnings through the source-job result", async (outcome) => {
    const f = fixture();
    const port = f.deps.store;
    let reached = 0, cas = 0;
    f.deps = {
      ...f.deps, store: { read: () => port.read(), cas: async (tip, candidate) => {
          cas++;
          const reply = await port.cas(tip, candidate);
          return outcome === "unknown" && reply.status === "accepted" ? { status: "unknown", attemptedTip: reply.tip } : reply;
        } }, admission: { ...f.deps.admission, checkpoint: event => {
          if (event.point === "after-cas") {
            reached++;
            throw new Error(CANARY_TOKEN + SIGNED_URL);
          }
          return Promise.resolve();
        } }
    };
    const { result, snapshot } = await success(f);
    expect(result.admission.status).toBe("stored");
    expect(result.admission.warnings).toEqual(["checkpoint-failed"]);
    expect(snapshot.runs.size).toBe(1);
    expect({ reached, cas }).toEqual({ reached: 1, cas: 1 });
    expect(result.projection).toBe("pending");
  });
  it("carries exact referenced canonical bytes across a later writer's actual GC without reencoding", async () => {
    const first = fixture();
    first.input.config.retention = { mainRuns: 1 };
    sourceAttempt(first, "99", "2026-10-01T00:00:00Z");
    const initial = await success(first);
    const blob = present(initial.snapshot.files.find(file => file.path.startsWith("blobs/")));
    const original = await initial.snapshot.readFile(blob.path);
    let reads = 0, readerGets = 0, binds = 0, iterators = 0;
    const returned: Uint8Array[] = [];
    const borrowed: StoreAdapter = { read: async () => {
        const snapshot = await first.store.read();
        if (++reads !== 1)
          return snapshot;
        const reader = snapshot.readFile;
        const operation = async function (this: object, path: string) {
          expect(this).toBe(captured);
          const bytes = await Reflect.apply(reader, snapshot, [path]);
          if (path === blob.path) {
            returned.push(bytes);
            Object.defineProperty(bytes, Symbol.iterator, { value() {
                iterators++;
                throw new Error(CANARY_TOKEN);
              } });
          }
          return bytes;
        };
        Object.defineProperty(operation, "bind", { get() {
            binds++;
            throw new Error(CANARY_TOKEN);
          } });
        const captured = { ...snapshot, get readFile() {
            readerGets++;
            return operation;
          } };
        return captured;
      }, cas: (tip, candidate) => first.store.cas(tip, candidate) };
    const incoming = fixture("local", false, [part()], undefined, borrowed);
    incoming.input.config.retention = { mainRuns: 1 };
    sourceAttempt(incoming, "100", "2026-10-03T00:00:00Z");
    const other = fixture("local", false, [part("head", 1, 1, "1", 2)], undefined, first.store);
    other.input.config.retention = { mainRuns: 1 };
    sourceAttempt(other, "101", "2026-10-02T00:00:00Z");
    let gcReached = 0;
    incoming.deps = { ...incoming.deps, checkpoint: async (point) => {
        if (point === "before-admission") {
          gcReached++;
          expect(returned).toHaveLength(1);
          for (const bytes of returned)
            bytes.fill(0);
          await success(other);
          const current = await first.store.read();
          expect([...current.runs.keys()]).toEqual(["101-a7"]);
          expect(current.files.some(file => file.path === blob.path)).toBe(false);
        }
      } };
    const { result, snapshot } = await success(incoming);
    expect(gcReached).toBe(1);
    expect({
      readerGets, binds, iterators
    }).toEqual({
      readerGets: 1, binds: 0, iterators: 0
    });
    expect(result.admission.status).toBe("stored");
    expect([...snapshot.runs.keys()]).toEqual(["100-a7"]);
    expect(await snapshot.readFile(blob.path)).toEqual(original);
    expect(incoming.counters()).toMatchObject({
      decodes: 1, encodes: 0, compares: 0, cas: 1, closes: 1
    });
  });
  it("races an ignored reused-byte read while preparing admission and never starts CAS", async () => {
    const first = fixture();
    await success(first);
    const incoming = fixture("local", false, [part()], undefined, first.store);
    sourceAttempt(incoming, "100", time);
    let reached = 0;
    incoming.deps = { ...incoming.deps, store: { read: async () => {
          const snapshot = await first.store.read();
          const reader = snapshot.readFile;
          return { ...snapshot, readFile(path) {
              if (path.startsWith("blobs/")) {
                reached++;
                incoming.controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
                return new Promise<Uint8Array>(() => {
                });
              }
              return Reflect.apply(reader, snapshot, [path]);
            } };
        }, cas: () => Promise.reject(new Error(CANARY_TOKEN)) } };
    await failure(incoming, "source-job-cancelled");
    expect(reached).toBe(1);
    expect(incoming.counters()).toMatchObject({
      decodes: 1, encodes: 0, cas: 0, closes: 1, disposed: 1
    });
    expect((await first.store.read()).runs.size).toBe(1);
  });
  it("refuses a changed listed canonical byte length before copying reused admission bytes", async () => {
    const first = fixture();
    await success(first);
    const incoming = fixture("local", false, [part()], undefined, first.store);
    sourceAttempt(incoming, "100", time);
    let reached = 0;
    incoming.deps = { ...incoming.deps, store: { read: async () => {
          const snapshot = await first.store.read();
          const reader = snapshot.readFile;
          return { ...snapshot, async readFile(path) {
              const bytes = await Reflect.apply(reader, snapshot, [path]);
              if (path.startsWith("blobs/")) {
                reached++;
                return new Uint8Array(bytes.byteLength + 1);
              }
              return bytes;
            } };
        }, cas: () => Promise.reject(new Error(CANARY_TOKEN)) } };
    await failure(incoming, "byte-array-limit");
    expect(reached).toBe(1);
    expect(incoming.counters()).toMatchObject({
      encodes: 0, cas: 0, closes: 1
    });
  });
  it("settles a rejected Proxy without prototype traps, unhandled rejections or missed cleanup", async () => {
    const f = fixture();
    let traps = 0, settled = false;
    const unhandled: unknown[] = [];
    const observe = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", observe);
    try {
      const hostile = new Proxy(new Error("hostile"), { getPrototypeOf() {
          traps++;
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        } });
      f.deps = { ...f.deps, forge: {
          verifySource: () => Promise.reject(hostile), listArtifacts: (...args) => f.forge.listArtifacts(...args), downloadArtifacts: (...args) => f.forge.downloadArtifacts(...args)
        } };
      const pending = failure(f, "source-job-operation-failed").then(() => {
        settled = true;
      });
      for (let step = 0; step < 100; step++)
        await Promise.resolve();
      expect({
        settled, traps, unhandled: unhandled.length
      }).toEqual({
        settled: true, traps: 0, unhandled: 0
      });
      await pending;
      expect(f.counters()).toMatchObject({
        cas: 0, closes: 1, disposed: 1
      });
    }
    finally {
      f.controller.abort();
      process.removeListener("unhandledRejection", observe);
    }
  });
  it.each(["caller", "deadline"] as const)("refuses intrinsic already-aborted %s state before any source call without reading public accessors", async (target) => {
    const f = fixture();
    const controller = target === "deadline" ? f.controller : new AbortController();
    controller.abort(new Error(CANARY_TOKEN + SIGNED_URL));
    let getters = 0;
    Object.defineProperty(controller.signal, "aborted", { get() {
        getters++;
        return false;
      } });
    if (target === "caller")
      f.deps = { ...f.deps, signal: controller.signal };
    await failure(f, "source-job-cancelled");
    expect(getters).toBe(0);
    expect(f.trace.some(value => value.startsWith("api:"))).toBe(false);
    expect(f.counters()).toMatchObject({
      cas: 0, closes: 1, disposed: 1
    });
  });
  it.each(["caller", "deadline"] as const)("links live native %s signals without executing poisoned public signal getters", async (target) => {
    const f = fixture();
    const controller = target === "deadline" ? f.controller : new AbortController();
    let getters = 0;
    for (const key of ["aborted", "reason", "addEventListener", "removeEventListener"])
      Object.defineProperty(controller.signal, key, { get() {
          getters++;
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        } });
    if (target === "caller")
      f.deps = { ...f.deps, signal: controller.signal };
    const { result } = await success(f);
    expect(result.admission.status).toBe("stored");
    expect(getters).toBe(0);
  });
  it("owns authenticated source commits at fulfillment before a producer's queued mutation", async () => {
    const f = fixture();
    let reached = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: (...args) => mutateAfterFulfillment(f.forge.verifySource(...args), value => {
          reached++;
          value.envelope.commits.head = "f".repeat(40);
        }), listArtifacts: (...args) => f.forge.listArtifacts(...args), downloadArtifacts: (...args) => f.forge.downloadArtifacts(...args)
      } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect(snapshot.runs.get("99-a7")?.source.commits.head).toBe(head);
  });
  it("owns downloaded ZIP bytes at fulfillment before a producer zeroes its archive", async () => {
    const f = fixture();
    let reached = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: (...args) => f.forge.verifySource(...args), listArtifacts: (...args) => f.forge.listArtifacts(...args), downloadArtifacts: (...args) => mutateAfterFulfillment(f.forge.downloadArtifacts(...args), value => {
          reached++;
          present(value.artifacts[0]).zip.fill(0);
        })
      } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect(snapshot.runs.get("99-a7")?.parts[0]?.status).toBe("valid");
    expect(snapshot.runs.get("99-a7")?.counts.incomparable).toBe(1);
  });
  it("owns the full artifact listing at fulfillment while preserving original opaque descriptors", async () => {
    const f = fixture();
    let reached = 0, downloads = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: (...args) => f.forge.verifySource(...args), listArtifacts: (...args) => mutateAfterFulfillment(f.forge.listArtifacts(...args).then(values => Array.from(values)), values => {
          reached++;
          (values as ArtifactDescriptor[]).length = 0;
        }), downloadArtifacts: (...args) => {
          downloads++;
          return f.forge.downloadArtifacts(...args);
        }
      } };
    const { snapshot } = await success(f);
    expect({ reached, downloads }).toEqual({ reached: 1, downloads: 1 });
    expect(snapshot.runs.get("99-a7")?.parts[0]?.status).toBe("valid");
  });
  it("owns decoded native pixels at fulfillment before producer mutation changes their hash", async () => {
    const f = fixture();
    const worker = present(f.deps.worker);
    let reached = 0;
    f.deps = { ...f.deps, worker: { ...worker, decode: (...args) => mutateAfterFulfillment(worker.decode(...args), value => {
          reached++;
          value.data.fill(0);
        }) } };
    const image = await decodePng(tinyPng(1));
    const expected = encodePng({
      ...image, channels: 4, data: normalizeRgba(image)
    });
    const { snapshot } = await success(f);
    const blob = present(snapshot.files.find(value => value.path.startsWith("blobs/")));
    expect(reached).toBe(1);
    expect(Buffer.from(await snapshot.readFile(blob.path)).equals(Buffer.from(expected))).toBe(true);
  });
  it("owns encoded canonical PNG bytes at fulfillment before producer mutation", async () => {
    const f = fixture();
    const worker = present(f.deps.worker);
    let reached = 0;
    f.deps = { ...f.deps, worker: { ...worker, encode: (...args) => mutateAfterFulfillment(worker.encode(...args), value => {
          reached++;
          value.fill(0);
        }) } };
    const image = await decodePng(tinyPng(1));
    const expected = encodePng({
      ...image, channels: 4, data: normalizeRgba(image)
    });
    const { snapshot } = await success(f);
    const blob = present(snapshot.files.find(value => value.path.startsWith("blobs/")));
    expect(reached).toBe(1);
    expect(Buffer.from(await snapshot.readFile(blob.path)).equals(Buffer.from(expected))).toBe(true);
  });
  it("owns the actual comparison verdict at fulfillment before a producer replaces it", async () => {
    const f = fixture("local", true, [part("base", 1, 1, "1", 1), part("head", 1, 1, "2", 2)]);
    const worker = present(f.deps.worker);
    let reached = 0;
    f.deps = { ...f.deps, worker: { ...worker, compare: (...args) => mutateAfterFulfillment(worker.compare(...args), value => {
          reached++;
          Object.assign(value, { status: "unchanged" });
          value.reasons.length = 0;
        }) } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect(snapshot.runs.get("99-a7")?.counts.changed).toBe(1);
  });
  it("owns a coherent initial native store snapshot before a producer changes its tip", async () => {
    const first = fixture();
    await success(first);
    const f = fixture("local", false, [part()], undefined, first.store);
    sourceAttempt(f, "100", time);
    const port = f.deps.store;
    let reads = 0, reached = 0;
    f.deps = { ...f.deps, store: { read: () => {
          const pending = port.read();
          return ++reads === 1 ? mutateAfterFulfillment(pending, value => {
            reached++;
            Object.assign(value, { tip: null });
          }) : pending;
        }, cas: (...args) => port.cas(...args) } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect([...snapshot.runs.keys()].sort()).toEqual(["100-a7", "99-a7"]);
  });
  it.each(["rejected", "fulfilled"] as const)("settles a %s source operation when native listener removal throws and still cleans resources", async (outcome) => {
    const f = fixture();
    let hooks = 0, settled = false;
    const key = present(Object.getOwnPropertySymbols(EventTarget.prototype).find(value => value.description === "kRemoveListener"));
    f.deps = { ...f.deps, forge: {
        verifySource: args => {
          Object.defineProperty(args.signal, key, { configurable: true, value() {
              hooks++;
              throw new Error(CANARY_TOKEN + SIGNED_URL);
            } });
          return outcome === "rejected" ? Promise.reject(new Error("opaque")) : f.forge.verifySource(args);
        }, listArtifacts: (...args) => f.forge.listArtifacts(...args), downloadArtifacts: (...args) => f.forge.downloadArtifacts(...args)
      } };
    const pending = failure(f).then(() => {
      settled = true;
    });
    for (let step = 0; step < 100; step++)
      await Promise.resolve();
    expect(settled).toBe(true);
    await pending;
    expect(hooks).toBeGreaterThan(0);
    expect(f.counters()).toMatchObject({
      cas: 0, closes: 1, disposed: 1
    });
  });
  it("attempts every native source unlink and deadline disposal while preserving proven admission", async () => {
    const f = fixture();
    const caller = new AbortController();
    let first = 0, second = 0;
    const key = present(Object.getOwnPropertySymbols(EventTarget.prototype).find(value => value.description === "kRemoveListener"));
    Object.defineProperty(f.controller.signal, key, { value() {
        first++;
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    Object.defineProperty(caller.signal, key, { value() {
        second++;
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    f.deps = { ...f.deps, signal: caller.signal };
    const { result, snapshot } = await success(f);
    expect({ first, second }).toEqual({ first: 1, second: 1 });
    expect(result.admission.status).toBe("stored");
    expect(result.diagnostics.cleanup).toEqual(["timing-disposal-failed"]);
    expect(snapshot.runs.size).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 1, closes: 1, disposed: 1
    });
  });
  it.each([false, true])("cleans partial source listener registration before refusing when removal also throws %s", async (removalThrows) => {
    const f = fixture();
    let added = 0, removed = 0, original = 0;
    f.controller.signal.addEventListener("abort", () => {
      original++;
    });
    const add = present(Object.getOwnPropertySymbols(EventTarget.prototype).find(value => value.description === "kNewListener"));
    const remove = present(Object.getOwnPropertySymbols(EventTarget.prototype).find(value => value.description === "kRemoveListener"));
    Object.defineProperty(f.controller.signal, add, { value() {
        added++;
        throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    Object.defineProperty(f.controller.signal, remove, { value() {
        removed++;
        if (removalThrows)
          throw new Error(CANARY_TOKEN + SIGNED_URL);
      } });
    await failure(f, "source-job-timing-invalid");
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    expect(getEventListeners(f.controller.signal, "abort")).toHaveLength(1);
    f.controller.abort();
    expect(original).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 0, closes: 1, disposed: 1
    });
    expect(f.trace.some(value => value.startsWith("api:"))).toBe(false);
  });
  it("settles a fulfillment capture getter failure with fixed diagnostics and complete cleanup", async () => {
    const f = fixture();
    let getters = 0;
    f.deps = { ...f.deps, forge: {
        verifySource: (...args) => f.forge.verifySource(...args).then(value => {
          Object.defineProperty(value, "envelope", { get() {
              getters++;
              throw new Error(CANARY_TOKEN + SIGNED_URL);
            } });
          return value;
        }), listArtifacts: (...args) => f.forge.listArtifacts(...args), downloadArtifacts: (...args) => f.forge.downloadArtifacts(...args)
      } };
    await failure(f, "source-job-operation-failed");
    expect(getters).toBe(1);
    expect(f.counters()).toMatchObject({
      cas: 0, closes: 1, disposed: 1
    });
  });
  it.each(["creation", "signal-getter", "signal-state"] as const)("failed deadline %s setup settles ignored worker cleanup and disposes acquired timing", async (variant) => {
    const f = fixture();
    let deadlines = 0, closes = 0, disposals = 0, traps = 0, settled = false;
    f.deps = {
      ...f.deps, timing: { deadline: () => {
          deadlines++;
          if (variant === "creation")
            throw new Error(CANARY_TOKEN + SIGNED_URL);
          return { get signal() {
              if (variant === "signal-getter")
                throw new Error(CANARY_TOKEN + SIGNED_URL);
              return new Proxy(f.controller.signal, { getPrototypeOf() {
                  traps++;
                  throw new Error(CANARY_TOKEN);
                } });
            }, dispose() {
              disposals++;
            } };
        } }, worker: { ...present(f.deps.worker), close: () => {
          closes++;
          return new Promise<void>(() => {
          });
        } }
    };
    const pending = failure(f, "source-job-timing-invalid").then(() => {
      settled = true;
    });
    for (let step = 0; step < 100; step++)
      await Promise.resolve();
    expect(settled).toBe(true);
    await pending;
    expect({
      deadlines, closes, disposals, traps
    }).toEqual({
      deadlines: 1, closes: 1, disposals: variant === "creation" ? 0 : 1, traps: 0
    });
    expect(f.counters().cas).toBe(0);
  });
  it.each(["timing-parent", "deadline-getter", "nonfunction-deadline", "null-timing"] as const)("failed early %s acquisition settles captured cleanup without awaiting an unavailable deadline", async (variant) => {
    const f = fixture();
    let setup = 0, closes = 0, settled = false;
    let release = () => {
    };
    f.deps = { ...f.deps, worker: { ...present(f.deps.worker), close: () => {
          closes++;
          return new Promise<void>(resolve => {
            release = resolve;
          });
        } } };
    if (variant === "timing-parent")
      Object.defineProperty(f.deps, "timing", { get() {
          setup++;
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        } });
    else if (variant === "deadline-getter")
      Object.defineProperty(f.deps.timing, "deadline", { get() {
          setup++;
          throw new Error(CANARY_TOKEN + SIGNED_URL);
        } });
    else if (variant === "nonfunction-deadline")
      Object.defineProperty(f.deps.timing, "deadline", { get() {
          setup++;
          return 1;
        } });
    else
      Object.defineProperty(f.deps, "timing", { get() {
          setup++;
          return null;
        } });
    const expected = variant === "nonfunction-deadline" ? "source-job-input-invalid" : "source-job-operation-failed";
    const pending = failure(f, expected).then(() => {
      settled = true;
    });
    void pending.catch(() => {
    });
    try {
      for (let step = 0; step < 100; step++)
        await Promise.resolve();
      expect(settled).toBe(true);
      await pending;
      expect({ setup, closes }).toEqual({ setup: 1, closes: 1 });
      expect(f.counters()).toMatchObject({
        cas: 0, deadlineCalls: 0, disposed: 0
      });
      expect(f.trace.some(value => value.startsWith("api:"))).toBe(false);
    }
    finally {
      release();
    }
  });
  it("preserves reused canonical bytes through the composed reader's producer fulfillment mutation", async () => {
    const first = fixture();
    const initial = await success(first);
    const blob = present(initial.snapshot.files.find(value => value.path.startsWith("blobs/"))), expected = await initial.snapshot.readFile(blob.path);
    const f = fixture("local", false, [part()], undefined, first.store);
    sourceAttempt(f, "100", time);
    const port = f.deps.store;
    let reads = 0, reached = 0;
    f.deps = { ...f.deps, store: { read: async () => {
          const snapshot = await port.read();
          if (++reads !== 1)
            return snapshot;
          const reader = snapshot.readFile;
          return { ...snapshot, readFile(path) {
              const pending = Reflect.apply<typeof snapshot, [
                string
              ], Promise<Uint8Array>>(reader, snapshot, [path]);
              return path.startsWith("blobs/") ? mutateAfterFulfillment(pending, value => {
                reached++;
                value.fill(0);
              }) : pending;
            } };
        }, cas: (...args) => port.cas(...args) } };
    const { snapshot } = await success(f);
    expect(reached).toBe(1);
    expect(await snapshot.readFile(blob.path)).toEqual(expected);
    expect(f.counters()).toMatchObject({ encodes: 0, decodes: 1 });
  });
});

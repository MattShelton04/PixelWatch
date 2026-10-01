// Worker isolation for the PNG codec and the comparator (02 §5: one decode/compare at a time,
// cancellable per image). A PngWorker owns at most one worker thread and sends it one job at a time. A job that times out
// or is aborted terminates the thread, and the next job starts a fresh one. A crash is reported
// as `worker-crash`, never as a result.
//
// What this does and doesn't bound: `resourceLimits` caps the worker's V8 heap only. Image
// buffers live outside that heap, so the 02 §5 memory budget comes from the decoder itself (the
// output is the only image-sized allocation, sized from the checked header), and the recorded
// peak RSS in docs/evidence/m1.1-png-bench.md checks it. The worker adds crash containment, a
// hard timeout and cancellation.
//
// The worker loads only this package's own worker.ts. A bundled publisher (M2.5) must emit it as
// a separate entry and pass its URL as `workerUrl`.
import { Worker } from "node:worker_threads";
import type { Comparison } from "../comparator/compare.ts";
import { type ComparatorPolicy, checkPolicy } from "../comparator/policy.ts";
import { type RawPixels, checkPixels } from "../pixel-hash.ts";
import { PngError } from "./errors.ts";
import type { WorkerReply, WorkerRequest } from "./worker.ts";

export interface PngWorkerOptions {
  /** V8 old-generation heap cap for the worker, in MiB. */
  readonly maxHeapMb?: number;
  /** Default per-job timeout. */
  readonly timeoutMs?: number;
  /** Worker entry; defaults to this package's worker.ts. Tests substitute misbehaving workers. */
  readonly workerUrl?: URL;
}

export interface JobOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type Request =
  | { op: "decode"; bytes: Uint8Array }
  | { op: "encode"; image: RawPixels }
  | { op: "compare"; base: RawPixels; head: RawPixels; policy: ComparatorPolicy };

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HEAP_MB = 256;

export class PngWorker {
  readonly #url: URL;
  readonly #heapMb: number;
  readonly #timeoutMs: number;
  #worker: Worker | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #nextId = 1;

  constructor(options: PngWorkerOptions = {}) {
    this.#url = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
    this.#heapMb = options.maxHeapMb ?? DEFAULT_HEAP_MB;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** decodePng in the worker. The caller's buffer is copied, never detached. */
  decode(bytes: Uint8Array, job: JobOptions = {}): Promise<RawPixels> {
    return this.#enqueue({ op: "decode", bytes }, job) as Promise<RawPixels>;
  }

  /** encodePng in the worker. */
  encode(image: RawPixels, job: JobOptions = {}): Promise<Uint8Array> {
    return this.#enqueue({ op: "encode", image }, job) as Promise<Uint8Array>;
  }

  /**
   * compareImages in the worker, so it shares the one-job queue, timeout and cancellation. The
   * images are copied; a malformed image or policy is refused here, before anything is sent.
   */
  async compare(base: RawPixels, head: RawPixels, policy: ComparatorPolicy, job: JobOptions = {}): Promise<Comparison> {
    checkPolicy(policy);
    checkPixels(base);
    checkPixels(head);
    return this.#enqueue({ op: "compare", base, head, policy }, job) as Promise<Comparison>;
  }

  /** Terminates the worker thread. Queued jobs after this start a new one. */
  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.terminate();
  }

  #enqueue(request: Request, job: JobOptions): Promise<unknown> {
    const run = this.#queue.then(() => this.#run(request, job));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #spawn(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const worker = new Worker(this.#url, { resourceLimits: { maxOldGenerationSizeMb: this.#heapMb } });
    // An idle worker never keeps the process alive; a running job holds its timeout timer.
    worker.unref();
    // Errors are handled per job; this keeps a late one from becoming an uncaught exception.
    worker.on("error", () => undefined);
    worker.once("exit", () => {
      if (this.#worker === worker) this.#worker = undefined;
    });
    this.#worker = worker;
    return worker;
  }

  #run(request: Request, job: JobOptions): Promise<unknown> {
    const { signal } = job;
    if (signal?.aborted === true) return Promise.reject(new PngError("aborted", "job cancelled before it started"));
    const timeoutMs = job.timeoutMs ?? this.#timeoutMs;
    const worker = this.#spawn();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
      };
      const kill = (error: PngError) => {
        cleanup();
        if (this.#worker === worker) this.#worker = undefined;
        void worker.terminate();
        reject(error);
      };
      const onMessage = (reply: WorkerReply) => {
        if (reply.id !== id) return;
        cleanup();
        if (reply.ok) resolve(reply.value);
        else reject(new PngError(reply.code, reply.detail));
      };
      const onError = () => {
        kill(new PngError("worker-crash", "the PNG worker failed"));
      };
      const onExit = (code: number) => {
        kill(new PngError("worker-crash", `the PNG worker exited with code ${String(code)}`));
      };
      const onAbort = () => {
        kill(new PngError("aborted", "job cancelled"));
      };
      const timer = setTimeout(() => {
        kill(new PngError("timeout", `job exceeded ${String(timeoutMs)} ms`));
      }, timeoutMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Copy exactly the view's bytes (`new Uint8Array(view)` copies; `Buffer#slice` wouldn't) and
      // transfer the copy: cloning a view would copy its whole backing buffer (e.g. an entire
      // archive), and transferring the caller's buffer would detach it.
      const copy = (image: RawPixels): RawPixels => ({ width: image.width, height: image.height, channels: image.channels, data: new Uint8Array(image.data) });
      let message: WorkerRequest;
      let transfer: Uint8Array[];
      if (request.op === "decode") {
        message = { id, op: "decode", bytes: new Uint8Array(request.bytes) };
        transfer = [message.bytes];
      } else if (request.op === "encode") {
        message = { id, op: "encode", image: copy(request.image) };
        transfer = [message.image.data];
      } else {
        const { thresholds, subtleMaxPixels, subtleMaxDelta, tile, maxRegions } = request.policy;
        message = { id, op: "compare", base: copy(request.base), head: copy(request.head), policy: { thresholds: [...thresholds], subtleMaxPixels, subtleMaxDelta, tile, maxRegions } };
        transfer = [message.base.data, message.head.data];
      }
      worker.postMessage(message, transfer.map((bytes) => bytes.buffer as ArrayBuffer));
    });
  }
}

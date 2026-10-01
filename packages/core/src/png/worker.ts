// Worker entry for PngWorker (isolated.ts). Runs one decode or encode per message and replies
// with the result (buffers transferred, not copied) or the PngError code. Anything else that
// throws is a bug: it crashes this worker, and the host reports `worker-crash`.
import { parentPort } from "node:worker_threads";
import type { RawPixels } from "../pixel-hash.ts";
import { decodePng } from "./decode.ts";
import { encodePng } from "./encode.ts";
import { type PngErrorCode, PngError } from "./errors.ts";

export type WorkerRequest = { id: number; op: "decode"; bytes: Uint8Array } | { id: number; op: "encode"; image: RawPixels };
export type WorkerReply =
  | { id: number; ok: true; value: RawPixels | Uint8Array }
  | { id: number; ok: false; code: PngErrorCode; detail: string };

async function handle(request: WorkerRequest): Promise<void> {
  const port = parentPort;
  if (port === null) return;
  try {
    if (request.op === "decode") {
      const image = await decodePng(request.bytes);
      port.postMessage({ id: request.id, ok: true, value: image } satisfies WorkerReply, [image.data.buffer as ArrayBuffer]);
    } else {
      const png = encodePng(request.image);
      port.postMessage({ id: request.id, ok: true, value: png } satisfies WorkerReply, [png.buffer as ArrayBuffer]);
    }
  } catch (error) {
    if (!(error instanceof PngError)) throw error;
    port.postMessage({ id: request.id, ok: false, code: error.code, detail: error.detail } satisfies WorkerReply);
  }
}

parentPort?.on("message", (request: WorkerRequest) => {
  void handle(request);
});

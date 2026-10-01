// @pixelwatch/core: the pure engine (06 §2). No network, process or file I/O. The one exception
// is PngWorker, which starts a worker thread from this package's own png/worker.ts.
export * from "./pixel-hash.ts";
export * from "./blob-pool.ts";
export { type DecodeOptions, type PngHeader, decodePng, inspectPng } from "./png/decode.ts";
export { encodePng } from "./png/encode.ts";
export { PngError, type PngErrorCode } from "./png/errors.ts";
export { type JobOptions, PngWorker, type PngWorkerOptions } from "./png/isolated.ts";
export { MAX_DIMENSION, MAX_PIXELS, MAX_PNG_BYTES } from "./png/limits.ts";

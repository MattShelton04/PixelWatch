// @pixelwatch/core: the pure engine (06 §2). No network, credentials, process or file I/O. The one exception
// is PngWorker, which starts a worker thread from this package's own png/worker.ts.
export * from "./pixel-hash.ts";
export * from "./blob-pool.ts";
export * from "./comparator/compare.ts";
export * from "./comparator/policy.ts";
export * from "./comparator/result.ts";
export { type DecodeOptions, type PngHeader, decodePng, inspectPng } from "./png/decode.ts";
export { encodePng } from "./png/encode.ts";
export { PngError, type PngErrorCode } from "./png/errors.ts";
export { type JobOptions, PngWorker, type PngWorkerOptions } from "./png/isolated.ts";
export { MAX_DIMENSION, MAX_PIXELS, MAX_PNG_BYTES } from "./png/limits.ts";
export { type ConfigParse, type ConfigWarning, parseConfig } from "./config/parse.ts";
export { YAML_LIMITS, YamlError, type YamlErrorCode, type YamlLimits, parseYamlSubset } from "./config/yaml.ts";
export { IngressError, type IngressErrorCode, type IngestionErrorCode, type PartErrorCode, type ZipErrorCode } from "./ingest/errors.ts";
export { ingestArtifacts } from "./ingest/ingest.ts";
export { INGEST_LIMITS, IngestBudget } from "./ingest/limits.ts";
export { MAX_PARTS, type MergeInput, type MergeResult, mergeParts } from "./ingest/merge.ts";
export { MAX_IGNORED, type Selection, comparePartKeys, expectedParts, partKeyString, selectArtifacts } from "./ingest/select.ts";
export type * from "./ingest/types.ts";
export { type ZipArchive, type ZipEntry, openZip, readEntry } from "./ingest/zip.ts";

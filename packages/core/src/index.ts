// @pixelwatch/core: the pure engine (06 §2). No network, credentials, process or file I/O. The one exception
// is PngWorker, which starts a worker thread from this package's own png/worker.ts.
export * from "./pixel-hash.ts";
export * from "./blob-pool.ts";
export * from "./comparator/compare.ts";
export * from "./comparator/policy.ts";
export * from "./comparator/result.ts";
export { type DecodeOptions, type PngHeader, decodePng } from "./png/decode.ts";
export { type PngStructure, parsePngStructure } from "./png/chunks.ts";
export { encodePng } from "./png/encode.ts";
export { PngError, type PngErrorCode } from "./png/errors.ts";
export { type JobOptions, PngWorker, type PngWorkerOptions } from "./png/isolated.ts";
export { MAX_DIMENSION, MAX_PIXELS, MAX_PNG_BYTES } from "./png/limits.ts";
export { IngressError, type IngressErrorCode, type IngestionErrorCode, type PartErrorCode, type ZipErrorCode } from "./ingest/errors.ts";
export { ingestArtifacts } from "./ingest/ingest.ts";
export { INGEST_LIMITS, IngestBudget } from "./ingest/limits.ts";
export { MAX_PARTS, type MergeInput, type MergeResult, mergeParts } from "./ingest/merge.ts";
export { MAX_IGNORED, type Selection, comparePartKeys, expectedParts, partKeyString, selectArtifacts } from "./ingest/select.ts";
export type * from "./ingest/types.ts";
export { type ZipArchive, type ZipEntry, openZip, readEntry } from "./ingest/zip.ts";
export { type Analysis, baselineFor, buildAnalysis, buildRun, unitKeyString } from "./run/build.ts";
export { MAX_STREAM_RUNS, addRun, deriveStreams, newStore, streamFor } from "./run/store.ts";
export {
  type Breakdown,
  type BudgetInput,
  type BudgetPlan,
  type BudgetRefusal,
  type GraceDrop,
  type ProjectedSizes,
  type PruneReason,
  type PrunedRun,
  type SiteCategory,
  type SiteFile,
  type SizeLimits,
  planBudget,
  sizeLimits,
} from "./housekeeping/budget.ts";
export { HousekeepingError, type HousekeepingErrorCode } from "./housekeeping/errors.ts";
export { type GcKeep, type GcPlan, planGc } from "./housekeeping/gc.ts";
export {
  API_INDEX,
  API_SCHEMA_KINDS,
  ENTRY_PAGE,
  LLMS_TXT,
  SITE_JSON,
  type ApiSchemaKind,
  type StorePath,
  apiSchemaPath,
  appScriptPath,
  classifyStorePath,
  changesPath,
  derivedPath,
  permalinkPath,
  prPointerPath,
  runRecordPath,
  streamPath,
} from "./housekeeping/paths.ts";
export { type HousekeepingInput, type HousekeepingPlan, planHousekeeping } from "./housekeeping/plan.ts";
export {
  type ExpiredRun,
  type ExpiryReason,
  type PrState,
  type PrStreamRetention,
  type RetainedRun,
  type RetentionInput,
  type RetentionPlan,
  type RetentionPolicy,
  type RunClass,
  retentionPolicy,
  selectRetention,
} from "./housekeeping/retention.ts";
export { type GraceNamespace, type References, type StoreFile, type StoreGraph, type StoreTree, readStoreTree } from "./housekeeping/tree.ts";
export { capabilitiesOf, projectChanges } from "./projection/changes.ts";
export {
  type GenerationInputs,
  PRODUCT_NAME,
  PROJECTION_VERSION,
  type StreamSummary,
  apiIndexDocument,
  generationId,
  llmsTxt,
  prPointerDocument,
  siteDocument,
  streamDocument,
  streamSummaries,
} from "./projection/documents.ts";
export { ProjectionError, type ProjectionErrorCode } from "./projection/errors.ts";
export { type PagesSite, type ProjectedFile, type ProjectionInput, type SizeInput, projectSite, projectedSizes, siteLocation } from "./projection/project.ts";
export { DEFAULT_PREFIX, type SiteLocation, SiteUrls, siteUrls } from "./projection/site.ts";

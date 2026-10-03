// The files M1.7 projects into the served tree (03 §3; ADR 0013), and their sizes for the M1.6
// budget. Pure: the store, its run records, the trusted config, the Pages site, the generation and
// the release go in; canonical bytes at generated paths come out.
//
// Projected here: site.json, llms.txt, api/v1/index.json, the API schemas, every run's
// changes.json, every stream file and every PR pointer. Not here: run-record and blob copies (the
// projector copies validated store files, M2.3) and HTML and the app (M2.3, M2.7), whose sizes the
// caller supplies to `projectedSizes`.
import { type Config, type Run, type Store, canonicalBytes, canonicalJson, compareGitHubIds, schemaFor, validateDocument } from "@pixelwatch/schemas";
import type { ProjectedSizes, SiteFile } from "../housekeeping/budget.ts";
import { API_INDEX, API_SCHEMA_KINDS, LLMS_TXT, SITE_JSON, apiSchemaPath, changesPath, isReleaseVersion, prPointerPath, streamPath } from "../housekeeping/paths.ts";
import { MAX_STREAM_RUNS, deriveStreams, streamFor } from "../run/store.ts";
import { projectChanges } from "./changes.ts";
import { type StreamSummary, apiIndexDocument, llmsTxt, prPointerDocument, siteDocument, streamDocument, streamSummaries } from "./documents.ts";
import { refuse } from "./errors.ts";
import { DEFAULT_PREFIX, type SiteLocation, type SiteUrls, siteUrls } from "./site.ts";

/** The Pages site, from the forge's Pages metadata (M2.1). */
export interface PagesSite {
  /** `html_url`: `https://<owner>.github.io/<repo>/`, or a root or custom-domain site. */
  readonly url: string;
  /** The host the site must be on: `<owner>.github.io` or the configured custom domain. */
  readonly host: string;
}

export interface ProjectionInput {
  /** Trusted config@1 at the commit the generation records. Supplies the prefix and theme. */
  readonly config: Config;
  readonly pages: PagesSite;
  /** store.json after this transaction's GC: exactly the runs the site keeps. */
  readonly store: Store;
  /** Run records by run key: at least every run in `store`. */
  readonly runs: ReadonlyMap<string, Run>;
  /** The generation ID (`generationId`). */
  readonly generation: string;
  /** The release version that projects, e.g. `0.1.0`. */
  readonly release: string;
}

export interface ProjectedFile {
  /** Relative to the site prefix (03 §3). */
  readonly path: string;
  readonly bytes: Uint8Array;
  /** True for changes.json: the bytes under its URL never change. Everything else is rebuilt. */
  readonly immutable: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function siteLocation(config: Config, pages: PagesSite): SiteLocation {
  return { pagesUrl: pages.url, expectedHost: pages.host, prefix: config.store?.prefix ?? DEFAULT_PREFIX };
}

interface Context {
  readonly config: Config;
  readonly urls: SiteUrls;
  readonly store: Store;
  readonly entries: ReadonlyMap<string, Store["runs"][number]>;
  readonly runs: ReadonlyMap<string, Run>;
  readonly generation: string;
  readonly release: string;
}

function context(input: ProjectionInput): Context {
  const config = validateDocument("config", input.config);
  if (!config.ok) refuse("invalid-input", `the config is invalid: ${config.issue.message}`);
  const store = validateDocument("store", input.store);
  if (!store.ok) refuse("invalid-input", `the store is invalid: ${store.issue.message}`);
  if (!SHA256.test(input.generation)) refuse("invalid-input", "the generation must be a 64-hex SHA-256");
  if (!isReleaseVersion(input.release)) refuse("invalid-input", "the release must be a release version");
  const urls = siteUrls(siteLocation(config.value, input.pages));
  const entries = new Map(store.value.runs.map((e) => [e.runKey, e]));
  return { config: config.value, urls, store: store.value, entries, runs: input.runs, generation: input.generation, release: input.release };
}

/** The record for a store entry, checked against it (key, created time, stream, repository). */
function runFor(ctx: Context, runKey: string): Run {
  const entry = ctx.entries.get(runKey);
  const run = ctx.runs.get(runKey);
  if (entry === undefined || run === undefined) refuse("invalid-input", `no run record for ${runKey}`);
  const valid = validateDocument("run", run);
  if (!valid.ok) refuse("invalid-input", `the record for ${runKey} is invalid: ${valid.issue.message}`);
  if (
    run.runKey !== runKey ||
    run.source.createdAt !== entry.sourceCreatedAt ||
    streamFor(run.source) !== entry.stream ||
    compareGitHubIds(run.source.repositoryId, ctx.store.repositoryId) !== 0
  ) {
    refuse("invalid-input", `the record for ${runKey} disagrees with its store.json entry`);
  }
  return run;
}

function bytes(value: unknown): Uint8Array {
  return canonicalBytes(value);
}

function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function theme(config: Config) {
  return config.theme?.preset ?? "github-light";
}

/** Files that don't depend on which runs are kept. */
function constantFiles(ctx: Context): ProjectedFile[] {
  return [
    { path: LLMS_TXT, bytes: utf8(llmsTxt(ctx.urls, ctx.release)), immutable: false },
    ...API_SCHEMA_KINDS.map((kind) => ({ path: apiSchemaPath(kind), bytes: utf8(canonicalJson(schemaFor(kind))), immutable: false })),
  ];
}

function summaryFiles(ctx: Context, summaries: readonly StreamSummary[]): ProjectedFile[] {
  return [
    { path: SITE_JSON, bytes: bytes(siteDocument(ctx.store, ctx.urls.prefix, summaries, ctx.generation, ctx.release, theme(ctx.config))), immutable: false },
    { path: API_INDEX, bytes: bytes(apiIndexDocument(ctx.store, summaries, ctx.generation, ctx.release)), immutable: false },
  ];
}

/** Every file M1.7 projects for this store, sorted by path. */
export function projectSite(input: ProjectionInput): ProjectedFile[] {
  const ctx = context(input);
  const files: ProjectedFile[] = [...constantFiles(ctx)];
  for (const entry of ctx.store.runs) {
    files.push({ path: changesPath(entry.runKey), bytes: bytes(projectChanges(runFor(ctx, entry.runKey), ctx.urls)), immutable: true });
  }
  const streams = deriveStreams(ctx.store);
  for (const stream of streams) {
    files.push({ path: streamPath(stream.streamId), bytes: bytes(streamDocument(stream.streamId, stream.runs)), immutable: false });
    if (stream.streamId === "main" || stream.latest === null) continue;
    const pr = stream.streamId.slice(3);
    files.push({ path: prPointerPath(pr), bytes: bytes(prPointerDocument(pr, runFor(ctx, stream.latest), ctx.generation)), immutable: false });
  }
  files.push(...summaryFiles(ctx, streamSummaries(streams)));
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface SizeInput extends ProjectionInput {
  /** The store before housekeeping: every run retention and the budget may keep. */
  readonly store: Store;
  /** Files M2.3 and M2.7 write once per site (entry page, app build), with their categories. */
  readonly html: readonly SiteFile[];
  /** The permalink page size for a run (M2.7). */
  readonly permalink: (runKey: string) => number;
}

/**
 * Stream summaries no smaller than any that a subset of the store's runs can produce: each stream's
 * longest run key as its latest, and its full (capped) run count. Housekeeping only removes runs,
 * and site.json and the API index differ only in these values, so the bound holds.
 */
function boundingSummaries(store: Store): StreamSummary[] {
  const byStream = new Map<string, string[]>();
  for (const entry of store.runs) {
    if (entry.stream === undefined) continue;
    const keys = byStream.get(entry.stream) ?? [];
    keys.push(entry.runKey);
    byStream.set(entry.stream, keys);
  }
  return deriveStreams(store).map((s) => {
    const keys = byStream.get(s.streamId) ?? [];
    const longest = keys.reduce((a, b) => (b.length > a.length ? b : a), "");
    return { streamId: s.streamId, latest: longest, runCount: Math.min(keys.length, MAX_STREAM_RUNS) };
  });
}

/**
 * ProjectedSizes for planHousekeeping (ADR 0012 §6), measured on the bytes `projectSite` emits:
 * changes.json, stream files and PR pointers exactly; site.json and the API index as upper bounds
 * over whatever the plan keeps; llms.txt and the schemas exactly; HTML and the app as supplied.
 */
export function projectedSizes(input: SizeInput): ProjectedSizes {
  const ctx = context(input);
  const summaries = boundingSummaries(ctx.store);
  // The bound isn't a document a site serves (its latest keys are picked for length), so it's
  // measured without validation.
  const site = { schemaVersion: 1, repositoryId: ctx.store.repositoryId, basePath: ctx.urls.prefix, versions: { release: ctx.release, data: 1, api: 1 }, generation: ctx.generation, dataNamespaces: ["v1"], streams: summaries, theme: { preset: theme(ctx.config) } };
  const index = { schemaVersion: 1, repositoryId: ctx.store.repositoryId, versions: { release: ctx.release, api: 1, changes: 1, prPointer: 1, stream: 1 }, generation: ctx.generation, streams: summaries };
  const fixed: SiteFile[] = [
    ...constantFiles(ctx).map((f) => ({ path: f.path, bytes: f.bytes.byteLength, category: "api" as const })),
    { path: SITE_JSON, bytes: bytes(site).byteLength, category: "data" },
    { path: API_INDEX, bytes: bytes(index).byteLength, category: "api" },
    ...input.html,
  ];
  const changes = new Map<string, number>();
  return {
    fixed,
    changes(runKey) {
      let size = changes.get(runKey);
      if (size === undefined) {
        size = bytes(projectChanges(runFor(ctx, runKey), ctx.urls)).byteLength;
        changes.set(runKey, size);
      }
      return size;
    },
    permalink: (runKey) => input.permalink(runKey),
    stream: (streamId, runKeys) => bytes(streamDocument(streamId, runKeys.slice(-MAX_STREAM_RUNS))).byteLength,
    prPointer: (prNumber, latest) => bytes(prPointerDocument(prNumber, runFor(ctx, latest), ctx.generation)).byteLength,
  };
}

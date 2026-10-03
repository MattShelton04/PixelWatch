// Explicitly synthetic local acceptance input, compared/projected through real core and final app.
// This is the product viewer, not live capture evidence or a prototype recording.
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addRun, appScriptPath, buildRun, compareImages, comparatorPolicy, encodePng, generationId, mergeParts,
  newStore, pixelHash, projectChanges, projectSite, siteUrls, unitKeyString, DEFAULT_PREFIX, runRecordPath, type Comparison, type RawPixels, type ValidPart } from "../../packages/core/src/index.ts";
import { canonicalBytes, type Config, type SourceEnvelope } from "../../packages/schemas/src/index.ts";
import { renderEntry } from "../../packages/viewer/src/entry.ts";
import { buildViewerAssets } from "./build.ts";

export async function buildViewerFixture(destination: string, options: { pages?: { url: string; host: string }; prefix?: string } = {}): Promise<{root: string; entryPath: string; runKey: string; release: string}> {
  const root = resolve(destination); const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || readdirSync(root).length !== 0) throw new Error("viewer fixture requires an empty directory");
  const release = "0.1.0-rc.1"; const repository = { repositoryId: "987654321", owner: "PixelWatchPreview", name: "example" };
  const config: Config = { schemaVersion: 1, source: { workflowIds: ["123456"], events: ["pull_request", "push"] }, providers: [{id: "example", shards: 1}], ...(options.prefix === undefined ? {} : { store: { prefix: options.prefix } }) };
  const pages = options.pages ?? { url: "https://pixelwatchpreview.github.io/example/", host: "pixelwatchpreview.github.io" };
  const urls = siteUrls({ pagesUrl: pages.url, expectedHost: pages.host, prefix: options.prefix ?? DEFAULT_PREFIX });
  const blobs = new Map<string, Uint8Array>(); const images = new Map<string, RawPixels>();
  const paint = (changed: boolean): RawPixels => {
    const width = 480; const height = 240; const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const card = x > 28 && x < 452 && y > 24 && y < 216;
      const bar = card && x > 48 && x < (changed ? 395 : 320) && y > 68 && y < 100;
      const at = (y * width + x) * 3; data[at] = bar ? 25 : card ? 255 : 238; data[at + 1] = bar ? 107 : card ? 255 : 242; data[at + 2] = bar ? 199 : card ? 255 : 248;
    } return { width, height, channels: 3, data };
  };
  const captured = (image: RawPixels) => {
    const hash = pixelHash(image); images.set(hash, image); blobs.set(`blobs/${hash.slice(0, 2)}/${hash}.png`, encodePng(image));
    return { state: "captured" as const, pixelHash: hash, width: image.width, height: image.height };
  };
  const before = captured(paint(false)); const after = captured(paint(true));
  const parts: ValidPart[] = (["base", "head"] as const).map((revision) => ({ revision, providerId: "example", shard: {index: 1, count: 1}, artifact: {artifactId: revision === "base" ? "1001" : "1002"}, claims: {}, units: [
    {viewId: "dashboard", variantId: "desktop", side: revision === "base" ? before : after, details: { labels: { title: "Dashboard" } }},
    {viewId: "settings", variantId: "desktop", side: before, details: { labels: { title: "Settings" } }},
    {viewId: "unavailable", variantId: "desktop", side: revision === "base" ? before : {state: "failed", category: "capture-error"}, details: {}},
  ] }));
  const ingestion = { ...mergeParts({config, baseline: "expected", valid: parts, rejected: []}), attempt: "1", ignored: [], ignoredOverflow: 0 };
  const comparisons = new Map<string, Comparison>();
  for (const unit of ingestion.units) if (unit.base.state === "captured" && unit.head.state === "captured") {
    const base = images.get(unit.base.pixelHash); const head = images.get(unit.head.pixelHash);
    if (base === undefined || head === undefined) throw new Error("fixture image missing");
    comparisons.set(unitKeyString(unit), compareImages(base, head, comparatorPolicy(1)));
  }
  const source: SourceEnvelope = { repositoryId: repository.repositoryId, workflowId: "123456", runId: "11", attempt: "1", event: "pull_request", createdAt: "2026-10-03T00:00:00Z", association: {status: "corroborated", prNumber: "7"}, commits: {base: "1".repeat(40), head: "2".repeat(40)}, configSha: "3".repeat(40), releaseSha: "4".repeat(40) };
  const run = buildRun(source, ingestion, comparisons, { release, config: 1, comparator: 1, bundle: 1, data: 1 });
  const store = addRun(newStore(repository.repositoryId), run).store;
  const generation = generationId({storeTip: "5".repeat(40), releaseCommit: source.releaseSha, configCommit: source.configSha, projectionVersion: 1});
  const assets = await buildViewerAssets(release); const files = new Map(projectSite({config, pages, store, runs: new Map([[run.runKey, run]]), generation, release}).map((file) => [file.path, file.bytes]));
  for (const [path, bytes] of blobs) files.set(path, bytes);
  files.set(appScriptPath(release), assets.script); files.set("index.html", renderEntry({urls, repository, assets}));
  files.set(`runs/${run.runKey}/index.html`, renderEntry({urls, repository, assets, changes: projectChanges(run, urls)}));
  files.set("store.json", canonicalBytes(store)); files.set(runRecordPath(run.runKey), canonicalBytes(run));
  const prefix = urls.prefix;
  for (const [path, bytes] of files) { const target = join(root, prefix, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, {flag: "wx"}); }
  return { root, entryPath: `${prefix}/runs/${run.runKey}/index.html`, runKey: run.runKey, release };
}

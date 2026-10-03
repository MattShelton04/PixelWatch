import { createHash } from "node:crypto";
import { appScriptPath, classifyStorePath, generationId, parsePngStructure, permalinkPath, projectSite, PROJECTION_VERSION, runRecordPath, siteLocation, siteUrls, sizeLimits, type Breakdown, type SiteCategory } from "@pixelwatch/core";
import { canonicalBytes } from "@pixelwatch/schemas";
import { captureContext, captureTree, checkedOid, copyBytes, entryBytes, JSON_BYTES, projection, safely } from "./assembly-input.ts";
import { guarded, refuse, type AssemblyInput, type AssembledFile, type AssembledSite } from "./types.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const breakdown = (): Breakdown => ({ html: 0, app: 0, api: 0, stubs: 0, data: 0, blobs: 0, derived: 0, grace: 0 });
const equal = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
function generatedCategory(path: string): SiteCategory {
  if (path === "site.json" || path.startsWith("data/v1/streams/")) return "data";
  if (path === "llms.txt" || path.startsWith("api/v1/")) return "api";
  return refuse("generated-path-refused");
}

/** Read-only complete assembly. Store/config freshness and serialization are caller duties. */
export function assembleSite(input: AssemblyInput): Promise<AssembledSite> {
  return guarded(async () => {
    const context = safely(() => captureContext(input));
    const source = input.snapshot;
    const tip = source.tip; if (tip === null) refuse("store-absent"); const storeTip = checkedOid(tip);
    // StoreSnapshot has no derived-reference authority; every derived file is a root.
    const { tree, graph } = safely(() => captureTree({store:source.store,runs:source.runs,files:source.files}, context.repository.repositoryId));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the captured method to this same snapshot.
    const reader = source.readFile;
    if (typeof reader !== "function") refuse("store-reader-invalid");
    // The validated adapter's own bounded function is captured once, never reread after await.
    const readFile = (path: string): Promise<Uint8Array> => Reflect.apply<typeof source,[string],Promise<Uint8Array>>(reader,source,[path]);
    const generation = generationId({ storeTip, releaseCommit: context.assets.releaseCommit, configCommit: context.configCommit, projectionVersion: PROJECTION_VERSION });
    const urls = siteUrls(siteLocation(context.config, context.pages)); const limits = sizeLimits(context.config);
    const generated: AssembledFile[] = []; const measured = breakdown(); const occupied = new Set<string>(); let totalBytes = 0;
    const account = (path: string, size: number, category: SiteCategory) => {
      if (occupied.has(path) || !Number.isSafeInteger(size) || size < 0) refuse("site-listing-invalid");
      if (path.endsWith(".json") && size > JSON_BYTES) refuse("json-limit");
      occupied.add(path); measured[category] += size; totalBytes += size;
      if (totalBytes > limits.hardBytes) refuse("site-budget-refused");
    };
    const add = (path: string, bytes: Uint8Array, category: SiteCategory, immutable: boolean) => {
      account(path, bytes.byteLength, category); generated.push({ path, bytes, category, immutable, sha256: sha256(bytes) });
    };
    safely(() => {
      for (const file of projectSite(projection(context, tree, generation))) add(file.path, file.bytes, generatedCategory(file.path), file.immutable);
      add("index.html", entryBytes(context), "html", false);
      add(appScriptPath(context.assets.release), context.assets.script, "app", true);
      for (const [key, run] of tree.runs) add(permalinkPath(key), entryBytes(context, run), "stubs", false);
    });
    const copy = new Set<string>();
    for (const key of graph.entries.keys()) {
      copy.add(runRecordPath(key)); const refs = graph.refs(key); for (const path of [...refs.blobs, ...refs.derived]) copy.add(path);
    }
    // run@1 does not encode derived references, so all derived pool files remain roots.
    if (!graph.derivedKnown) for (const path of graph.derivedFiles) copy.add(path);
    const copied = [...copy].sort().map((path) => {
      const kind = classifyStorePath(path); const category: SiteCategory | undefined = kind?.kind === "run" ? "data" : kind?.kind === "blob" ? "blobs" : kind?.kind === "derived" ? "derived" : undefined;
      if (category === undefined) refuse("store-path-refused");
      const size = graph.bytes(path); account(path, size, category); return { path, size, category };
    });
    // All sizes are known and hard-budget checked before any stored PNG/record is allocated.
    for (const file of copied) {
      let returned: Uint8Array;
      try { returned = await readFile(file.path); } catch { return refuse("store-read-failed"); }
      const bytes = copyBytes(returned,file.size,file.size);
      const kind = classifyStorePath(file.path);
      if (kind?.kind === "run") {
        const run = tree.runs.get(kind.runKey); if (run === undefined || !equal(bytes, canonicalBytes(run))) refuse("stored-run-changed");
      } else {
        try { parsePngStructure(bytes); } catch { return refuse("stored-png-invalid"); }
        if (kind?.kind === "derived" && !file.path.endsWith(`/${sha256(bytes)}.png`)) refuse("stored-derived-changed");
      }
      generated.push({ path: file.path, bytes, category: file.category, immutable: true, sha256: sha256(bytes) });
    }
    generated.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { generation, storeTip, configCommit: context.configCommit, releaseCommit: context.assets.releaseCommit, urls, files: generated,
      totalBytes, breakdown: measured, overSoftLimit: totalBytes > limits.softBytes };
  });
}

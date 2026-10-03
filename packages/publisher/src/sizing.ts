import { appScriptPath, projectedSizes, type ProjectedSizes, type SiteFile } from "@pixelwatch/core";
import { captureContext, captureTree, entryBytes, JSON_BYTES, projection, safely } from "./assembly-input.ts";
import { refuse, type SizingInput } from "./types.ts";

/** A fixed-width size probe only; no fabricated tip or generation is ever served. */
const MEASUREMENT_GENERATION = "0".repeat(64);
export function measureSite(input: SizingInput): ProjectedSizes {
  return safely(() => {
    const context = captureContext(input); const { tree } = captureTree(input.tree, context.repository.repositoryId);
    const home = entryBytes(context);
    const html: SiteFile[] = [{ path: "index.html", bytes: home.byteLength, category: "html" },
      { path: appScriptPath(context.assets.release), bytes: context.assets.script.byteLength, category: "app" }];
    const permalink = new Map([...tree.runs].map(([key, run]) => [key, entryBytes(context, run).byteLength]));
    const measured = projectedSizes({ ...projection(context, tree, MEASUREMENT_GENERATION), html, permalink: (key) => {
      const size = permalink.get(key); if (size === undefined) refuse("run-missing"); return size;
    } });
    for (const file of measured.fixed) if (file.path.endsWith(".json") && file.bytes > JSON_BYTES) refuse("json-limit");
    return {
      fixed: Object.freeze(measured.fixed.map((file) => Object.freeze({ ...file }))),
      changes: (key) => safely(() => { const size = measured.changes(key); if (size > JSON_BYTES) refuse("json-limit"); return size; }),
      permalink: (key) => safely(() => measured.permalink(key)),
      stream: (id, keys) => safely(() => { const size = measured.stream(id, keys); if (size > JSON_BYTES) refuse("json-limit"); return size; }),
      prPointer: (number, latest) => safely(() => { const size = measured.prPointer(number, latest); if (size > JSON_BYTES) refuse("json-limit"); return size; }),
    };
  });
}

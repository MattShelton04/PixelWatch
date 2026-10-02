// Local-only evidence for M1.4: ingests real prototype capture output from .reference/ (ADR 0001,
// git-ignored). Not part of `pnpm check`; tests never read .reference/.
//
//   node tools/check-reference-ingest.ts
//
// 1. Converts PropertyScope run 36405830015 and TracePilot run 36314265418 with the M0.3
//    converters, zips each part under its 02 §6 name with the test-side writer in upload-artifact's
//    layout, and runs ingestArtifacts with a PngWorker and an in-memory pool. Prints parts,
//    coverage, side states and the eight results (canonical blobs decoded and compared in the
//    worker), checks per-part unit counts against the converter output, and checks that reversed
//    artifact and entry order gives the same ingestion.
// 2. Runs the structural stages of the ZIP reader on the 16 archives GitHub's upload-artifact
//    produced for the prototype runs, then extracts every entry (size and CRC). Their entry names
//    are prototype names, so the name stage is skipped for this check only.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConvertedBundle,
  type Config,
  canonicalJson,
  convertPropertyScope,
  convertTracePilot,
  validateDocument,
} from "../packages/schemas/src/index.ts";
import { type BlobPool, blobPath } from "../packages/core/src/blob-pool.ts";
import { COMPARATOR_V1 } from "../packages/core/src/comparator/policy.ts";
import { unitResult } from "../packages/core/src/comparator/result.ts";
import { ingestArtifacts } from "../packages/core/src/ingest/ingest.ts";
import { IngestBudget } from "../packages/core/src/ingest/limits.ts";
import type { ArtifactInput, Ingestion } from "../packages/core/src/ingest/types.ts";
import { checkLayout, readCentralDirectory, readEntry } from "../packages/core/src/ingest/zip.ts";
import { PngWorker } from "../packages/core/src/png/isolated.ts";
import { buildZip } from "./zip-corpus/zip-builder.ts";

const root = join(import.meta.dirname, "..", ".reference", "artifacts");

interface RunSpec {
  readonly run: string;
  readonly providers: readonly [string, number][];
  readonly convert: (manifest: Uint8Array, images: Map<string, Uint8Array>) => ConvertedBundle;
  readonly manifest: RegExp;
}

const RUNS: readonly RunSpec[] = [
  {
    run: "ps-36405830015",
    providers: [
      ["fixture", 1],
      ["stack", 1],
    ],
    convert: (manifest, images) => convertPropertyScope({ manifest, images, attempt: "1" }),
    manifest: /^capture-[a-z]+\.json$/,
  },
  {
    run: "tp-36314265418",
    providers: [["fixture", 2]],
    convert: (manifest, images) => convertTracePilot({ manifest, images, attempt: "1" }),
    manifest: /^capture-\d+-\d+\.json$/,
  },
];

function readImages(dir: string): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) if (name.endsWith(".png")) images.set(name, readFileSync(join(dir, name)));
  return images;
}

function memoryPool(): BlobPool & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    has: (path) => Promise.resolve(blobs.has(path)),
    add: (path, bytes) => {
      blobs.set(path, bytes);
      return Promise.resolve();
    },
  };
}

function configOf(providers: readonly [string, number][]): Config {
  const checked = validateDocument("config", {
    schemaVersion: 1,
    source: { workflowIds: ["1"], events: ["pull_request"] },
    providers: providers.map(([id, shards]) => ({ id, shards })),
  });
  if (!checked.ok) throw new Error(checked.issue.message);
  return checked.value;
}

function zipOf(converted: ConvertedBundle, reverse: boolean): Uint8Array {
  const entries = [...converted.files].map(([name, data]) => ({ name, data }));
  return buildZip({ entries: reverse ? entries.reverse() : entries });
}

/** The ingestion without archive hashes, which differ when entry order does. */
function comparable(ingestion: Ingestion): string {
  return canonicalJson({ ...ingestion, parts: ingestion.parts.map((p) => ({ ...p, artifacts: p.artifacts.map((a) => a.artifactId) })) });
}

const worker = new PngWorker();
let failures = 0;
let found = 0;

for (const spec of RUNS) {
  const runDir = join(root, spec.run);
  if (!existsSync(runDir)) continue;
  const converted: ConvertedBundle[] = [];
  for (const artifact of readdirSync(runDir).sort()) {
    const dir = join(runDir, artifact);
    for (const file of readdirSync(dir)) {
      if (spec.manifest.test(file)) converted.push(spec.convert(readFileSync(join(dir, file)), readImages(dir)));
    }
  }
  if (converted.length === 0) continue;
  found++;
  const config = configOf(spec.providers);
  const artifacts = (reverse: boolean): ArtifactInput[] => {
    const list = converted.map((c, i) => ({ artifactName: c.artifactName, artifactId: String(1000 + i), zip: zipOf(c, reverse) }));
    return reverse ? list.reverse() : list;
  };
  const pool = memoryPool();
  const started = performance.now();
  const ingestion = await ingestArtifacts({ config, attempt: "1", baseline: "expected", artifacts: artifacts(false), pool, codec: worker });
  const ingestMs = performance.now() - started;
  const reversed = await ingestArtifacts({ config, attempt: "1", baseline: "expected", artifacts: artifacts(true), pool: memoryPool(), codec: worker });

  console.log(`\n${spec.run}: ${String(converted.length)} parts, ${String(pool.blobs.size)} canonical blobs, ingested in ${ingestMs.toFixed(0)} ms`);
  let ok = true;
  for (const part of ingestion.parts) {
    const source = converted.find((c) => c.bundle.revision === part.revision && c.bundle.providerId === part.providerId && c.bundle.shard.index === part.shard.index);
    const match = part.status === "valid" && part.unitCount === source?.bundle.units.length;
    ok &&= match;
    console.log(
      `  ${match ? "ok  " : "FAIL"} ${part.revision}/${part.providerId}/s${String(part.shard.index)}-of${String(part.shard.count)}: ${part.status}, ` +
        `${String(part.unitCount ?? "?")} units (converter: ${String(source?.bundle.units.length ?? "?")})` +
        (part.diagnostic === undefined ? "" : ` [${part.diagnostic.code}: ${part.diagnostic.message}]`),
    );
  }
  const sides = new Map<string, number>();
  const results = new Map<string, number>();
  for (const unit of ingestion.units) {
    const pair = `${unit.base.state}/${unit.head.state}`;
    sides.set(pair, (sides.get(pair) ?? 0) + 1);
    let comparison;
    if (unit.base.state === "captured" && unit.head.state === "captured") {
      const base = await worker.decode(pool.blobs.get(blobPath(unit.base.pixelHash)) ?? new Uint8Array());
      const head = await worker.decode(pool.blobs.get(blobPath(unit.head.pixelHash)) ?? new Uint8Array());
      comparison = await worker.compare(base, head, COMPARATOR_V1);
    }
    const { status } = unitResult(unit, unit.base, unit.head, comparison);
    results.set(status, (results.get(status) ?? 0) + 1);
  }
  const permutationOk = comparable(ingestion) === comparable(reversed);
  ok &&= permutationOk && ingestion.coverage.status === "complete-declared";
  console.log(`  coverage: ${JSON.stringify(ingestion.coverage)}`);
  console.log(`  side states: ${[...sides].map(([k, n]) => `${k} ${String(n)}`).join(", ")}`);
  console.log(`  results: ${[...results].sort().map(([k, n]) => `${k} ${String(n)}`).join(", ")}`);
  console.log(`  excluded: ${String(ingestion.excluded.count)}; ignored: ${String(ingestion.ignored.length)}`);
  console.log(`  ${permutationOk ? "ok  " : "FAIL"} reversed artifact and entry order gives the same ingestion`);
  if (!ok) failures++;
}
await worker.close();

// GitHub's own archives: structure, layout, descriptors and CRC.
let zips = 0;
console.log("\nupload-artifact archives (structure, layout, descriptors, CRC):");
for (const dir of existsSync(root) ? readdirSync(root).filter((d) => d.endsWith("-zips")).sort() : []) {
  for (const file of readdirSync(join(root, dir)).sort()) {
    const bytes = readFileSync(join(root, dir, file));
    const budget = new IngestBudget();
    try {
      const directory = readCentralDirectory(bytes, budget);
      const names = directory.records.map((r) => Buffer.from(r.nameBytes).toString("latin1"));
      const entries = checkLayout(bytes, directory, names);
      let expanded = 0;
      for (const entry of entries) expanded += (await readEntry({ bytes, entries }, entry.name)).byteLength;
      zips++;
      console.log(`  ok   ${dir}/${file}: ${String(entries.length)} entries, ${String(bytes.byteLength)} bytes, ${String(expanded)} expanded`);
    } catch (error) {
      failures++;
      console.log(`  FAIL ${dir}/${file}: ${String(error)}`);
    }
  }
}

if (found === 0 && zips === 0) {
  console.error("No reference capture output found under .reference/artifacts (see ADR 0001). Nothing ran.");
  process.exitCode = 1;
} else if (failures > 0) {
  process.exitCode = 1;
}

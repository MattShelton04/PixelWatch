// Peak RSS and time for M1.4 ingestion (threat-model R4.2-08). Not part of `pnpm check`: it
// writes evidence from real runs on this machine.
//
//   node tools/ingest-bench.ts     # 3 runs per scenario → docs/evidence/m1.4-ingest-bench.md
//
// Each measurement runs in a fresh Node process (`--child`), so `maxRSS` is that process's own
// peak, including reading every archive. Inputs are generated into a temporary directory first.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, canonicalBytes, formatArtifactName, unitFileName, validateDocument } from "../packages/schemas/src/index.ts";
import type { BlobPool } from "../packages/core/src/blob-pool.ts";
import { IngressError } from "../packages/core/src/ingest/errors.ts";
import { ingestArtifacts } from "../packages/core/src/ingest/ingest.ts";
import { IngestBudget } from "../packages/core/src/ingest/limits.ts";
import type { ArtifactInput, Ingestion } from "../packages/core/src/ingest/types.ts";
import { openZip } from "../packages/core/src/ingest/zip.ts";
import { PngWorker } from "../packages/core/src/png/isolated.ts";
import { buildPng } from "./png-corpus/png-builder.ts";
import { buildZip } from "./zip-corpus/zip-builder.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVIDENCE = join(ROOT, "docs", "evidence", "m1.4-ingest-bench.md");
const HOSTILE = join(ROOT, "testdata", "zip", "hostile");
const RUNS = 3;

type Mode = "baseline" | "zip" | "ingest" | "ingest-worker";

interface Scenario {
  readonly id: string;
  readonly what: string;
  readonly mode: Mode;
  /** A generated input set, or a corpus file ingested as the only part of provider `p`. */
  readonly input: string;
}

interface Measurement {
  outcome: string;
  totalMs: number;
  maxRssMiB: number;
  archives: number;
  archiveBytes: number;
  entries?: number;
  expandedBytes?: number;
  units?: number;
}

const MAX_SHARDS = 48;
const MAX_UNITS = 2000;

const SCENARIOS: readonly Scenario[] = [
  { id: "baseline", what: "Node, modules and reading the max set; no ingestion", mode: "baseline", input: "max" },
  { id: "max-zip", what: "Max set, ZIP stages only (structure, layout, inflate + CRC, shared budget)", mode: "zip", input: "max" },
  { id: "max-ingest", what: "Max set, full ingestion, in-process codec", mode: "ingest", input: "max" },
  { id: "max-ingest-worker", what: "Max set, full ingestion, PngWorker codec", mode: "ingest-worker", input: "max" },
  { id: "tall-ingest-worker", what: "200 units of 1440×2000 screenshot-like PNGs, PngWorker codec", mode: "ingest-worker", input: "tall" },
  { id: "bomb-expanded-total", what: "17 honest 32 MiB entries (544 MiB)", mode: "ingest", input: "bomb-expanded-total.zip" },
  { id: "bomb-lying-header", what: "Header says 1 KiB, inflates to 64 MiB", mode: "ingest", input: "bomb-lying-header.zip" },
  { id: "bomb-entry-count", what: "EOCD declares 5000 entries", mode: "ingest", input: "bomb-entry-count.zip" },
  { id: "bomb-declared-png", what: "Central record declares a 33 MiB PNG", mode: "ingest", input: "bomb-declared-png.zip" },
  { id: "overlap-shared-offset", what: "Two entries share one local header", mode: "ingest", input: "overlap-shared-offset.zip" },
];

function configOf(providers: readonly [string, number][]): Config {
  const checked = validateDocument("config", {
    schemaVersion: 1,
    source: { workflowIds: ["1"], events: ["push"] },
    providers: providers.map(([id, shards]) => ({ id, shards })),
  });
  if (!checked.ok) throw new Error(checked.issue.message);
  return checked.value;
}

/** A discarding pool: every blob is new and nothing is kept, so RSS reflects ingestion only. */
const DISCARD: BlobPool = { read: () => Promise.resolve(undefined), create: () => Promise.resolve("created") };

function part(revision: "base" | "head", providerId: string, index: number, count: number, units: [string, Uint8Array][]): [string, Uint8Array] {
  const files = units.map(([viewId, png]) => [unitFileName({ providerId, viewId, variantId: "desktop" }), viewId, png] as const);
  const bundle = {
    schemaVersion: 1,
    revision,
    providerId,
    attempt: "1",
    shard: { index, count },
    producer: { name: "ingest-bench", version: "1" },
    claims: {},
    units: files.map(([file, viewId]) => ({ viewId, variantId: "desktop", state: "captured", file })),
  };
  const name = formatArtifactName({ attempt: "1", revision, providerId, shard: { index, count } });
  return [name, buildZip({ entries: [{ name: "bundle.json", data: canonicalBytes(bundle) }, ...files.map(([file, , data]) => ({ name: file, data }))] })];
}

/**
 * The largest ingestion the limits allow: 1 provider × 48 shards × base and head = 96 parts,
 * 96 bundle.json + 4000 PNGs = 4096 entries, 2000 declared units, ≈ 495 MiB actually inflated.
 * Each PNG is 1440×30 RGB in a stored (level 0) zlib stream, so its bytes are mostly pixels, with
 * a per-image first row so no two are equal.
 */
function maxSet(dir: string): void {
  const [w, h] = [1440, 30];
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) % 251;
  for (const revision of ["base", "head"] as const) {
    for (let shard = 1; shard <= MAX_SHARDS; shard++) {
      const units: [string, Uint8Array][] = [];
      for (let u = shard - 1; u < MAX_UNITS; u += MAX_SHARDS) {
        const own = pixels.slice();
        own.fill(u % 256, 0, w * 3);
        own[0] = revision === "base" ? 1 : 2;
        units.push([`v${String(u).padStart(4, "0")}`, buildPng(w, h, 3, own, { level: 0 })]);
      }
      const [name, zip] = part(revision, "p", shard, MAX_SHARDS, units);
      writeFileSync(join(dir, `${name}.zip`), zip);
    }
  }
}

/** 200 head units of tall, compressible screenshot-like images: realistic codec cost per image. */
function tallSet(dir: string): void {
  const [w, h] = [1440, 2000];
  const units: [string, Uint8Array][] = [];
  for (let u = 0; u < 200; u++) {
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const band = Math.floor((y + u * 13) / 40) % 7;
        const text = (x * 7 + y * 13 + u) % 97 < 9 && y % 40 > 10 && y % 40 < 30;
        data[i] = text ? 30 : 240 - band * 8;
        data[i + 1] = text ? 30 : 244 - band * 4;
        data[i + 2] = text ? 40 : 250;
      }
    }
    units.push([`v${String(u).padStart(3, "0")}`, buildPng(w, h, 3, data, { filters: (y) => (y === 0 ? 1 : 4) })]);
  }
  const [name, zip] = part("head", "p", 1, 1, units);
  writeFileSync(join(dir, `${name}.zip`), zip);
}

function readSet(dir: string): ArtifactInput[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".zip"))
    .sort()
    .map((f, i) => ({ artifactName: f.slice(0, -4), artifactId: String(i + 1), zip: readFileSync(join(dir, f)) }));
}

async function child(mode: Mode, input: string): Promise<Measurement> {
  const corpus = input.endsWith(".zip");
  const artifacts = corpus ? [{ artifactName: "pixelwatch-b1-a1-head-p-s1-of1", artifactId: "1", zip: readFileSync(input) }] : readSet(input);
  const shards = corpus ? 1 : artifacts.length === 1 ? 1 : MAX_SHARDS;
  const baseline = corpus || artifacts.length === 1 ? "none" : "expected";
  const result: Measurement = { outcome: "", totalMs: 0, maxRssMiB: 0, archives: artifacts.length, archiveBytes: artifacts.reduce((s, a) => s + a.zip.byteLength, 0) };
  const started = performance.now();
  const worker = mode === "ingest-worker" ? new PngWorker() : undefined;
  try {
    if (mode === "baseline") {
      result.outcome = "no ingestion";
    } else if (mode === "zip") {
      const budget = new IngestBudget();
      for (const a of artifacts) await openZip(a.zip, budget);
      result.outcome = "opened";
      result.entries = budget.entries;
      result.expandedBytes = budget.expandedBytes;
    } else {
      const ingestion: Ingestion = await ingestArtifacts({
        config: configOf([["p", shards]]),
        attempt: "1",
        baseline,
        artifacts,
        pool: DISCARD,
        ...(worker === undefined ? {} : { codec: worker }),
      });
      const rejected = ingestion.parts.find((p) => p.status === "rejected");
      result.outcome = rejected === undefined ? ingestion.coverage.status : `part rejected \`${rejected.diagnostic?.code ?? "?"}\``;
      result.units = ingestion.units.length;
    }
  } catch (error) {
    if (!(error instanceof IngressError)) throw error;
    result.outcome = `refused \`${error.code}\``;
  } finally {
    await worker?.close();
  }
  result.totalMs = performance.now() - started;
  result.maxRssMiB = process.resourceUsage().maxRSS / 1024;
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function provenance(): string {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  // The tree hash identifies the measured code even after the branch is squash-merged.
  const tree = execFileSync("git", ["rev-parse", "--short", "HEAD:packages/core/src"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "packages/core/src"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
  const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
  return [
    `- Machine: ${cpu}, ${String(cpus().length)} logical CPUs, ${String(Math.round(totalmem() / 2 ** 30))} GiB RAM, ${platform()} ${release()}`,
    `- Node ${process.version}; commit \`${commit}\`, \`packages/core/src\` tree \`${tree}\`${dirty ? " plus uncommitted changes (not a valid record)" : ""}`,
  ].join("\n");
}

const MiB = (n: number | undefined) => (n === undefined ? "–" : (n / 2 ** 20).toFixed(1));

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "pixelwatch-ingest-bench-"));
  try {
    const sets = new Map<string, string>();
    for (const [name, build] of [
      ["max", maxSet],
      ["tall", tallSet],
    ] as const) {
      const at = join(dir, name);
      mkdirSync(at);
      build(at);
      sets.set(name, at);
    }
    const rows: string[] = [];
    for (const s of SCENARIOS) {
      const input = sets.get(s.input) ?? join(HOSTILE, s.input);
      const runs: Measurement[] = [];
      for (let i = 0; i < RUNS; i++) {
        const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", s.mode, input], { encoding: "utf8", maxBuffer: 1 << 20 });
        if (out.status !== 0) throw new Error(`${s.id} failed: ${out.stderr}`);
        runs.push(JSON.parse(out.stdout) as Measurement);
      }
      const [first] = runs;
      const outcomes = new Set(runs.map((r) => r.outcome));
      if (outcomes.size !== 1) throw new Error(`${s.id}: runs disagree (${[...outcomes].join(", ")})`);
      rows.push(
        `| ${s.id} | ${s.what} | ${String(first?.archives ?? 0)} | ${MiB(first?.archiveBytes)} | ${first?.entries?.toLocaleString("en-US") ?? "–"} | ${MiB(first?.expandedBytes)} | ${first?.units?.toLocaleString("en-US") ?? "–"} | ${first?.outcome ?? "?"} | ${median(runs.map((r) => r.totalMs)).toFixed(0)} | ${Math.max(...runs.map((r) => r.maxRssMiB)).toFixed(0)} |`,
      );
      console.log(rows.at(-1));
    }
    const doc = `# M1.4 ingestion: peak RSS and time

Recorded by \`node tools/ingest-bench.ts\` on ${new Date().toISOString().slice(0, 10)}. Threat-model row R4.2-08;
02 §5 budgets: ≤ 4096 entries and ≤ 512 MiB expanded per ingestion, one decode at a time within
512 MiB, 10-minute hard timeout.

${provenance()}
- Each row: ${String(RUNS)} runs, each in a fresh Node process. Time is the median in ms, from the first
  ingestion call to its result or refusal. Peak RSS is the largest \`process.resourceUsage().maxRSS\`
  of the runs, in MiB, and includes Node, the modules and every archive read into memory (see
  \`baseline\`). Worker rows include the PngWorker thread, which shares the process.
- The blob pool discards what it is given, so RSS reflects ingestion, not stored blobs.
- Max set: 1 provider × ${String(MAX_SHARDS)} shards × base and head = 96 parts, 96 \`bundle.json\` + 4000 PNGs = 4096
  entries, ${String(MAX_UNITS)} declared units. Each PNG is 1440×30 RGB in a stored zlib stream, so inflated bytes
  are nearly all pixels. Entries and expanded MiB are counted by the shared budget from inflated
  output (zip row).
- Bombs come from \`testdata/zip/hostile/\`, ingested as the only part of a one-shard provider.

| Scenario | Input | Archives | Archive MiB | Entries | Expanded MiB | Units | Outcome | Time | Peak RSS |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

The ZIP reader never holds an expanded archive: pass 1 inflates every entry in 64 KiB pieces and
discards them, and pass 2 extracts one entry at a time. The 544 MiB bomb is refused when the
running total of actually inflated bytes passes 512 MiB, without an entry-sized buffer; the lying
header stops one chunk past its declared size; the entry-count and declared-size bombs and the
overlap fail before any inflation. Only this Windows machine was measured; CI runs the same code
on Linux but doesn't record RSS.
`;
    writeFileSync(EVIDENCE, doc);
    console.log(`wrote ${EVIDENCE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--child") {
    void child(process.argv[3] as Mode, process.argv[4] ?? "").then((m) => {
      process.stdout.write(JSON.stringify(m));
    });
  } else {
    main();
  }
}

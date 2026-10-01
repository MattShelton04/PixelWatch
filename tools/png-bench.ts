// Peak RSS and time for the restricted PNG codec (M1.1; threat-model R4.2-08) and the comparator
// (M1.3). Not part of `pnpm check`: it writes evidence files from real runs on this machine.
//
//   node tools/png-bench.ts            # codec scenarios, 3 runs each → docs/evidence/m1.1-png-bench.md
//   node tools/png-bench.ts compare    # compare scenarios, 3 runs each → docs/evidence/m1.3-compare-bench.md
//
// Each measurement runs in a fresh Node process (`--child`), so `maxRSS` is that process's own
// peak: module loading, reading the input file, and the measured work. Inputs are generated once
// into a temporary directory first, so generating them never counts.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { COMPARATOR_V1, type Comparison, compareImages, decodePng, encodePng, inspectPng, pixelHash, PngError, PngWorker } from "../packages/core/src/index.ts";
import { IEND, buildPng, chunk, concat, filterScanlines, ihdr, png } from "./png-corpus/png-builder.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVIDENCE = join(ROOT, "docs", "evidence", "m1.1-png-bench.md");
const COMPARE_EVIDENCE = join(ROOT, "docs", "evidence", "m1.3-compare-bench.md");
const RUNS = 3;

type Mode = "baseline" | "inspect" | "decode" | "canonicalize" | "worker-decode";

interface Scenario {
  id: string;
  what: string;
  mode: Mode;
  /** Input path relative to the repo, or a generated input name. */
  input: string;
}

interface Measurement {
  ok: boolean;
  code?: string;
  inspectMs?: number;
  decodeMs?: number;
  hashMs?: number;
  encodeMs?: number;
  totalMs: number;
  encodedBytes?: number;
  maxRssMiB: number;
}

/** Synthetic inputs: structured content that compresses like a screenshot, inside 32 MiB. */
function generated(name: string): Uint8Array {
  if (name === "synthetic-1440x6000-rgb") return buildPng(1440, 6000, 3, tallPattern(), { filters: (y) => (y === 0 ? 1 : 4) });
  if (name === "synthetic-4000x4000-rgba") return buildPng(4000, 4000, 4, maxPattern(4000), { filters: () => 4 });
  const variant = COMPARE_VARIANTS[name];
  if (variant !== undefined) return variant();
  if (name === "many-idat-1000x850-rgb") {
    // The most IDAT chunks that fit in 32 MiB: a stored (level 0) stream, one byte per chunk.
    const [w, h] = [1000, 850];
    const stream = deflateSync(filterScanlines(w, h, 3, new Uint8Array(w * h * 3), () => 0), { level: 0 });
    const parts = [png(ihdr({ width: w, height: h }))];
    for (const byte of stream) parts.push(chunk("IDAT", Uint8Array.of(byte)));
    parts.push(IEND);
    return concat(parts);
  }
  if (name === "too-large-32mib-plus-1") {
    const bytes = new Uint8Array(32 * 1024 * 1024 + 1);
    bytes.set(readFileSync(join(ROOT, "testdata", "comparator", "crops", "crops", "36287837535-config-injector-base.png")));
    return bytes;
  }
  throw new Error(`unknown generated input ${name}`);
}

/** The 1440×6000 RGB pattern of synthetic-1440x6000-rgb. */
function tallPattern(): Uint8Array {
  const [w, h] = [1440, 6000];
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const band = Math.floor(y / 40) % 7;
      const text = (x * 7 + y * 13) % 97 < 9 && y % 40 > 10 && y % 40 < 30;
      data[i] = text ? 30 : 240 - band * 8;
      data[i + 1] = text ? 30 : 244 - band * 4;
      data[i + 2] = text ? 40 : 250;
    }
  }
  return data;
}

/** The 4000-wide RGBA pattern of synthetic-4000x4000-rgba, `h` rows tall. */
function maxPattern(h: number): Uint8Array {
  const w = 4000;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x ^ y) & 0xff;
      data[i + 1] = (x >> 4) & 0xff;
      data[i + 2] = (y >> 4) & 0xff;
      data[i + 3] = x % 64 === 0 ? 0 : 255 - ((x + y) & 0x3f);
    }
  }
  return data;
}

/** synthetic-4000x4000-rgba with the red channel of every pixel `where` holds flipped (Δ128, visible). */
function maxEdited(where: (x: number, y: number) => boolean): Uint8Array {
  const data = maxPattern(4000);
  for (let y = 0; y < 4000; y++) {
    for (let x = 0; x < 4000; x++) {
      if (!where(x, y)) continue;
      const i = (y * 4000 + x) * 4;
      data[i] = (data[i] as number) ^ 0x80;
      if (data[i + 3] === 0) data[i + 3] = 255;
    }
  }
  return buildPng(4000, 4000, 4, data, { filters: () => 4 });
}

/** Head images for the compare scenarios (bases are the existing synthetic inputs). */
const COMPARE_VARIANTS: Record<string, () => Uint8Array> = {
  "synthetic-1440x6000-rgb-band": () => {
    // A 1040×120 band changes, like a re-styled panel.
    const data = tallPattern();
    for (let y = 3000; y < 3120; y++) for (let x = 200; x < 1240; x++) data[(y * 1440 + x) * 3 + 1] = 90;
    return buildPng(1440, 6000, 3, data, { filters: (y) => (y === 0 ? 1 : 4) });
  },
  // 25 scattered 40×12 blocks, a third of their pixels unchanged.
  "synthetic-4000x4000-rgba-sparse": () => maxEdited((x, y) => (x % 800) < 40 && (y % 800) < 12 && (x + y) % 3 !== 0),
  // Every pixel changes: one region covering the canvas.
  "synthetic-4000x4000-rgba-dense": () => maxEdited(() => true),
  // One changed pixel in every tile at an even row and column: 62,500 separate regions.
  "synthetic-4000x4000-rgba-stride2": () => maxEdited((x, y) => x % 16 === 3 && y % 16 === 5),
  // One changed pixel in every tile on every third tile diagonal: ~333 long diagonal regions with
  // canvas-sized tile rectangles (the window-box edge scans).
  "synthetic-4000x4000-rgba-diagonals": () => maxEdited((x, y) => x % 8 === 0 && y % 8 === 0 && (x / 8 - y / 8) % 3 === 0),
  // The same pattern, 1000 rows shorter: a height change with a 4000×1000 padded band.
  "synthetic-4000x3000-rgba": () => buildPng(4000, 3000, 4, maxPattern(3000), { filters: () => 4 }),
};

const REAL = "testdata/prototypes/propertyscope-36405830015/visual-head-fixture/f1-overview-error.png";
const BOMB = "testdata/png/hostile/bomb-4000x4000-rgba.png";

const SCENARIOS: Scenario[] = [
  { id: "baseline", what: "Node + core modules loaded, input read, no codec call", mode: "baseline", input: REAL },
  { id: "real-inspect", what: "Largest committed real screenshot, validation pass only", mode: "inspect", input: REAL },
  { id: "real-decode", what: "Largest committed real screenshot, 1440×1013 RGB, 23 IDATs", mode: "decode", input: REAL },
  { id: "real-canonical", what: "Same, decode + hash + canonical encode", mode: "canonicalize", input: REAL },
  { id: "tall-decode", what: "Synthetic 1440×6000 RGB (PropertyScope's tallest)", mode: "decode", input: "synthetic-1440x6000-rgb" },
  { id: "tall-canonical", what: "Same, decode + hash + canonical encode", mode: "canonicalize", input: "synthetic-1440x6000-rgb" },
  { id: "max-decode", what: "Synthetic 4000×4000 RGBA (16 MP limit)", mode: "decode", input: "synthetic-4000x4000-rgba" },
  { id: "max-canonical", what: "Same, decode + hash + canonical encode", mode: "canonicalize", input: "synthetic-4000x4000-rgba" },
  { id: "max-worker", what: "Same, decoded in a PngWorker (process RSS includes the worker)", mode: "worker-decode", input: "synthetic-4000x4000-rgba" },
  { id: "max-inspect", what: "Synthetic 4000×4000 RGBA, validation pass only", mode: "inspect", input: "synthetic-4000x4000-rgba" },
  { id: "many-idat", what: "Hostile shape: 2,551,241 one-byte IDAT chunks (31.6 MiB), valid 1000×850 RGB", mode: "decode", input: "many-idat-1000x850-rgb" },
  { id: "bomb", what: "Hostile: 4000×4000 RGBA inflate bomb (64 MB + 1 MiB of zeros)", mode: "decode", input: BOMB },
  { id: "too-large", what: "Hostile: 32 MiB + 1 byte", mode: "decode", input: "too-large-32mib-plus-1" },
];

async function child(mode: Mode, path: string): Promise<Measurement> {
  const bytes = readFileSync(path);
  const started = performance.now();
  const timed = async <T>(work: () => T | Promise<T>): Promise<[T, number]> => {
    const t = performance.now();
    const value = await work();
    return [value, performance.now() - t];
  };
  const result: Measurement = { ok: true, totalMs: 0, maxRssMiB: 0 };
  try {
    if (mode === "inspect") {
      [, result.inspectMs] = await timed(() => inspectPng(bytes));
    } else if (mode === "decode" || mode === "canonicalize") {
      const [image, decodeMs] = await timed(() => decodePng(bytes));
      result.decodeMs = decodeMs;
      [, result.hashMs] = await timed(() => pixelHash(image));
      if (mode === "canonicalize") {
        const [png, encodeMs] = await timed(() => encodePng(image));
        result.encodeMs = encodeMs;
        result.encodedBytes = png.byteLength;
      }
    } else if (mode === "worker-decode") {
      const worker = new PngWorker();
      try {
        [, result.decodeMs] = await timed(() => worker.decode(bytes));
      } finally {
        await worker.close();
      }
    }
  } catch (error) {
    if (!(error instanceof PngError)) throw error;
    result.ok = false;
    result.code = error.code;
  }
  result.totalMs = performance.now() - started;
  result.maxRssMiB = process.resourceUsage().maxRSS / 1024;
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function fmt(value: number | undefined, digits = 0): string {
  return value === undefined ? "–" : value.toFixed(digits);
}

type CompareMode = "decode-pair" | "compare" | "worker-compare";

interface CompareScenario {
  id: string;
  what: string;
  mode: CompareMode;
  base: string;
  head: string;
}

interface CompareMeasurement {
  decodeMs: number;
  hashMs: number;
  compareMs?: number;
  totalMs: number;
  maxRssMiB: number;
  outcome?: string;
}

const MAX = "synthetic-4000x4000-rgba";
const COMPARE_SCENARIOS: CompareScenario[] = [
  { id: "pair-baseline", what: "Two 4000×4000 RGBA decoded and hashed, no compare (the RSS floor for the rows below)", mode: "decode-pair", base: MAX, head: `${MAX}-dense` },
  { id: "tall-band", what: "1440×6000 RGB, a 1040×120 band changed", mode: "compare", base: "synthetic-1440x6000-rgb", head: "synthetic-1440x6000-rgb-band" },
  { id: "max-identical", what: "4000×4000 RGBA (16 MP limit) against itself", mode: "compare", base: MAX, head: MAX },
  { id: "max-sparse", what: "4000×4000 RGBA, 25 scattered 40×12 blocks changed", mode: "compare", base: MAX, head: `${MAX}-sparse` },
  { id: "max-dense", what: "4000×4000 RGBA, every pixel changed (one region)", mode: "compare", base: MAX, head: `${MAX}-dense` },
  { id: "max-stride2", what: "4000×4000 RGBA, one pixel in every other tile row and column (62,500 regions)", mode: "compare", base: MAX, head: `${MAX}-stride2` },
  { id: "max-diagonals", what: "4000×4000 RGBA, every third tile diagonal (long regions, canvas-sized tile rectangles)", mode: "compare", base: MAX, head: `${MAX}-diagonals` },
  { id: "max-height", what: "4000×3000 → 4000×4000 RGBA (height change, padded band)", mode: "compare", base: "synthetic-4000x3000-rgba", head: MAX },
  { id: "max-dense-worker", what: "Same as max-dense, compared in a PngWorker (images copied in; RSS includes the worker)", mode: "worker-compare", base: MAX, head: `${MAX}-dense` },
];

function describeComparison(c: Comparison): string {
  const t0 = c.diff?.analyses[0];
  return `${c.status} (${c.reasons.join(", ") || "–"}), t0 ${t0?.changedPixels.toLocaleString("en-US") ?? "–"} px in ${t0?.regionCount?.toLocaleString("en-US") ?? "–"} regions`;
}

async function compareChild(mode: CompareMode, basePath: string, headPath: string): Promise<CompareMeasurement> {
  const baseBytes = readFileSync(basePath);
  const headBytes = readFileSync(headPath);
  const started = performance.now();
  let t = performance.now();
  const base = await decodePng(baseBytes);
  const head = await decodePng(headBytes);
  const result: CompareMeasurement = { decodeMs: performance.now() - t, hashMs: 0, totalMs: 0, maxRssMiB: 0 };
  t = performance.now();
  pixelHash(base);
  pixelHash(head);
  result.hashMs = performance.now() - t;
  if (mode !== "decode-pair") {
    t = performance.now();
    let comparison: Comparison;
    if (mode === "worker-compare") {
      const worker = new PngWorker();
      try {
        comparison = await worker.compare(base, head, COMPARATOR_V1);
      } finally {
        await worker.close();
      }
    } else {
      comparison = compareImages(base, head, COMPARATOR_V1);
    }
    result.compareMs = performance.now() - t;
    result.outcome = describeComparison(comparison);
  }
  result.totalMs = performance.now() - started;
  result.maxRssMiB = process.resourceUsage().maxRSS / 1024;
  return result;
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

function mainCompare(): void {
  const dir = mkdtempSync(join(tmpdir(), "pixelwatch-compare-bench-"));
  try {
    const inputs = new Map<string, string>();
    for (const name of COMPARE_SCENARIOS.flatMap((s) => [s.base, s.head])) {
      if (inputs.has(name)) continue;
      const path = join(dir, `${name}.png`);
      writeFileSync(path, generated(name));
      inputs.set(name, path);
    }
    const rows: string[] = [];
    for (const s of COMPARE_SCENARIOS) {
      const runs: CompareMeasurement[] = [];
      for (let i = 0; i < RUNS; i++) {
        const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--compare-child", s.mode, inputs.get(s.base) ?? "", inputs.get(s.head) ?? ""], { encoding: "utf8" });
        if (out.status !== 0) throw new Error(`${s.id} failed: ${out.stderr}`);
        runs.push(JSON.parse(out.stdout) as CompareMeasurement);
      }
      const pick = (key: "decodeMs" | "hashMs" | "compareMs" | "totalMs") => {
        const values = runs.map((r) => r[key]).filter((v): v is number => typeof v === "number");
        return values.length === 0 ? undefined : median(values);
      };
      rows.push(
        `| ${s.id} | ${s.what} | ${runs[0]?.outcome ?? "no compare"} | ${fmt(pick("decodeMs"))} | ${fmt(pick("hashMs"))} | ${fmt(pick("compareMs"))} | ${fmt(pick("totalMs"))} | ${fmt(Math.max(...runs.map((r) => r.maxRssMiB)))} |`,
      );
      console.log(rows.at(-1));
    }
    const doc = `# M1.3 comparator: peak RSS and time

Recorded by \`node tools/png-bench.ts compare\` on ${new Date().toISOString().slice(0, 10)}. 02 §5 budget: one
decode/compare at a time within 512 MiB. Policy: comparator-v1 (\`COMPARATOR_V1\`).

${provenance()}
- Each row: ${String(RUNS)} runs, each in a fresh Node process that reads two PNGs, decodes both
  (\`decodePng\`), hashes both (\`pixelHash\`) and compares them. Times are medians in ms. Peak RSS is
  the largest \`process.resourceUsage().maxRSS\` of the runs, in MiB. It includes Node itself, both
  encoded files and both decoded images.
- Total is everything from the first decode to the end.

| Scenario | Inputs | Outcome | Decode ×2 | Hash ×2 | Compare | Total | Peak RSS |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

The comparator streams 64-row chunks through the pixel hash's normalizer and keeps only per-tile
statistics (8 bytes per tile per threshold), so beyond the two decoded images it allocates a few
MB whatever the content: compare each row with \`pair-baseline\`. Region boxes come from each
component's tile-rectangle edges, which keeps the fragmented and diagonal cases linear. The worker
row copies both images into the worker, so the process briefly holds them twice. Only this Windows
machine was measured; CI runs the same code on Linux but doesn't record RSS.
`;
    writeFileSync(COMPARE_EVIDENCE, doc);
    console.log(`wrote ${COMPARE_EVIDENCE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "pixelwatch-png-bench-"));
  try {
    const inputs = new Map<string, string>();
    for (const s of SCENARIOS) {
      if (inputs.has(s.input)) continue;
      if (s.input.startsWith("testdata/")) {
        inputs.set(s.input, join(ROOT, s.input));
      } else {
        const path = join(dir, `${s.input}.png`);
        writeFileSync(path, generated(s.input));
        inputs.set(s.input, path);
      }
    }
    const rows: string[] = [];
    for (const s of SCENARIOS) {
      const path = inputs.get(s.input) ?? "";
      const runs: Measurement[] = [];
      for (let i = 0; i < RUNS; i++) {
        const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", s.mode, path], { encoding: "utf8" });
        if (out.status !== 0) throw new Error(`${s.id} failed: ${out.stderr}`);
        runs.push(JSON.parse(out.stdout) as Measurement);
      }
      const [first] = runs;
      const pick = (key: keyof Measurement) => {
        const values = runs.map((r) => r[key]).filter((v): v is number => typeof v === "number");
        return values.length === 0 ? undefined : median(values);
      };
      const inputBytes = readFileSync(path).byteLength;
      rows.push(
        `| ${s.id} | ${s.what} | ${inputBytes.toLocaleString("en-US")} | ${s.mode === "baseline" ? "no codec call" : first?.ok === true ? (s.mode === "inspect" ? "valid" : "decoded") : `rejected \`${first?.code ?? "?"}\``} | ${fmt(pick("inspectMs"))} | ${fmt(pick("decodeMs"))} | ${fmt(pick("hashMs"))} | ${fmt(pick("encodeMs"))} | ${fmt(pick("totalMs"))} | ${first?.encodedBytes?.toLocaleString("en-US") ?? "–"} | ${fmt(Math.max(...runs.map((r) => r.maxRssMiB)))} |`,
      );
      console.log(rows.at(-1));
    }
    const doc = `# M1.1 PNG codec: peak RSS and time

Recorded by \`node tools/png-bench.ts\` on ${new Date().toISOString().slice(0, 10)}. Threat-model row R4.2-08;
02 §5 budget: one decode/compare at a time within 512 MiB.

${provenance()}
- Each row: ${String(RUNS)} runs, each in a fresh Node process. Times are medians in ms. Peak RSS is the
  largest \`process.resourceUsage().maxRSS\` of the runs, in MiB, and includes Node itself (see
  \`baseline\`) and reading the input file.
- Total is the measured work from the first codec call to the end, including a rejection.
- Encoded bytes is the canonical PNG's size (canonicalize rows only).

| Scenario | Input | Input bytes | Outcome | Inspect | Decode | Hash | Encode | Total | Encoded bytes | Peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

\`decodePng\` runs the validating pass (\`inspectPng\`) itself, so the Decode column includes it.
The bomb is refused by that pass: it never allocates the 64,000,000-byte output buffer
(\`packages/core/test/png-decode.test.ts\` checks that no output buffer is allocated for any
hostile file). Only this Windows machine was measured; CI runs the same code on Linux but doesn't
record RSS.
`;
    writeFileSync(EVIDENCE, doc);
    console.log(`wrote ${EVIDENCE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "--compare-child") {
    void compareChild(process.argv[3] as CompareMode, process.argv[4] ?? "", process.argv[5] ?? "").then((m) => {
      process.stdout.write(JSON.stringify(m));
    });
  } else if (process.argv[2] === "compare") {
    mainCompare();
  } else if (process.argv[2] === "--child") {
    const mode = process.argv[3] as Mode;
    const path = process.argv[4] ?? "";
    void child(mode, path).then((m) => {
      process.stdout.write(JSON.stringify(m));
    });
  } else {
    main();
  }
}

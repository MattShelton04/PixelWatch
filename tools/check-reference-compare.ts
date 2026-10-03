// Local-only full-size parity for M1.3 (ADR comparator-v1, "Consequences"): runs the core
// comparator on every compared view of the three full-size recordings and requires the exact
// result that `comparedResult` maps from the recorded prototype output. Inputs are the real PNGs
// in .reference/ (ADR 0001, git-ignored), found by their recorded SHA-256. Not part of
// `pnpm check`; tests never read .reference/.
//
//   node tools/check-reference-compare.ts                 # core comparator on the decoded PNGs
//   node tools/check-reference-compare.ts --dev-compare   # the whole `pixelwatch-dev compare` path
//
// --dev-compare (M1.8, ADR 0014) converts the same captures to bundle@1 parts with the M0.3
// converters, writes them to a temp dir as `<revision>/<artifact name>/` directories, runs the
// dev CLI on them in process (local tree reader, ingress, merge, PngWorker comparison) and requires
// the same golden result for every compared view, nothing else in the report, and the exit code
// the goldens imply.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { COMPARATOR_V1, compareImages, decodePng, pixelHash, unitResult } from "../packages/core/src/index.ts";
import { type ConvertedBundle, convertPropertyScope, convertTracePilot } from "../packages/schemas/src/index.ts";
import type { CapturedSide, RunResult } from "../packages/schemas/src/generated/types.ts";
import { main } from "./dev/cli.ts";
import { type DevReport, EXIT } from "./dev/report.ts";
import { type RecordedSide, comparedResult } from "./prototype-goldens/expected.ts";
import type { PrototypeRecord } from "./prototype-goldens/mapping.ts";

const ROOT = join(import.meta.dirname, "..");
const DIRS = [join(ROOT, ".reference", "artifacts"), join(ROOT, ".reference", "m06", "base"), join(ROOT, ".reference", "m06", "head"), join(ROOT, ".reference", "m06", "tp-36287837535"), join(ROOT, ".reference", "m06", "tp-36301239732")];
const RECORDINGS = ["propertyscope-pr123", "tracepilot-36287837535", "tracepilot-36301239732"];

interface View {
  id: string;
  provider?: string;
  inputs?: Partial<Record<"base" | "head", RecordedSide & { fileSha256: string }>>;
  prototype?: PrototypeRecord;
}

function pngs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pngs(path);
    return name.endsWith(".png") ? [path] : [];
  });
}

const bySha = new Map<string, string>();
for (const path of DIRS.flatMap(pngs)) bySha.set(createHash("sha256").update(readFileSync(path)).digest("hex"), path);

/** The first differing path between two JSON values, for a readable mismatch report. */
function firstDifference(a: unknown, b: unknown, path = ""): string {
  if (isDeepStrictEqual(a, b)) return "";
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return `${path || "/"}: port ${JSON.stringify(a)} vs golden ${JSON.stringify(b)}`;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`);
    if (found) return found;
  }
  return `${path || "/"}: key order differs`;
}

let failures = 0;

function golden(view: View): RunResult | undefined {
  const { base, head } = view.inputs ?? {};
  if (!base || !head || !view.prototype) return undefined;
  const side = (s: RecordedSide): CapturedSide => ({ state: "captured", pixelHash: s.pixelHash, width: s.width, height: s.height });
  const identity = { providerId: view.provider ?? "fixture", viewId: view.id, variantId: "desktop" };
  return { ...identity, ...comparedResult(view.id, base, head, view.prototype, undefined, undefined), base: side(base), head: side(head) };
}

async function checkCore(): Promise<void> {
for (const name of RECORDINGS) {
  const { views } = JSON.parse(readFileSync(join(ROOT, "testdata", "comparator", name, "prototype.json"), "utf8")) as { views: View[] };
  const tally: Record<string, number> = {};
  let compared = 0;
  for (const view of views) {
    const { base, head } = view.inputs ?? {};
    if (!base || !head || !view.prototype) continue;
    compared++;
    const label = `${name}/${view.provider ?? "fixture"}/${view.id}`;
    const basePath = bySha.get(base.fileSha256);
    const headPath = bySha.get(head.fileSha256);
    if (basePath === undefined || headPath === undefined) {
      failures++;
      console.log(`FAIL ${label}: input PNG not found in .reference/`);
      continue;
    }
    const baseImage = await decodePng(readFileSync(basePath));
    const headImage = await decodePng(readFileSync(headPath));
    if (pixelHash(baseImage) !== base.pixelHash || pixelHash(headImage) !== head.pixelHash) {
      failures++;
      console.log(`FAIL ${label}: decoded pixel hash differs from the recording`);
      continue;
    }
    const expected = golden(view);
    if (expected === undefined) continue;
    const port = unitResult(expected, expected.base, expected.head, compareImages(baseImage, headImage, COMPARATOR_V1));
    if (JSON.stringify(port) !== JSON.stringify(expected)) {
      failures++;
      console.log(`FAIL ${label}: ${firstDifference(port, expected)}`);
      continue;
    }
    tally[port.status] = (tally[port.status] ?? 0) + 1;
  }
  console.log(`${name}: ${String(compared)} compared views; matched ${JSON.stringify(tally)}`);
}
console.log(`${String(bySha.size)} distinct real PNGs indexed; ${String(failures)} failures`);
}

const REFERENCE = join(ROOT, ".reference");

function readImages(dir: string): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const file of readdirSync(dir)) if (file.endsWith(".png")) images.set(file, readFileSync(join(dir, file)));
  return images;
}

/** Converted parts per recording: PropertyScope per artifact directory, TracePilot per shard manifest. */
function convertedParts(name: string): ConvertedBundle[] | undefined {
  const parts: ConvertedBundle[] = [];
  if (name === "propertyscope-pr123") {
    const dir = join(REFERENCE, "artifacts", "ps-36405830015");
    if (!existsSync(dir)) return undefined;
    for (const artifact of readdirSync(dir).sort()) {
      for (const file of readdirSync(join(dir, artifact)).filter((f) => /^capture-[a-z]+\.json$/.test(f))) {
        parts.push(convertPropertyScope({ manifest: readFileSync(join(dir, artifact, file)), images: readImages(join(dir, artifact)), attempt: "1" }));
      }
    }
  } else {
    const dir = join(REFERENCE, "m06", name.replace("tracepilot-", "tp-"));
    if (!existsSync(dir)) return undefined;
    for (const revision of ["base", "head"]) {
      for (const file of readdirSync(join(dir, revision)).filter((f) => /^capture-\d+-\d+\.json$/.test(f)).sort()) {
        parts.push(convertTracePilot({ manifest: readFileSync(join(dir, revision, file)), images: readImages(join(dir, revision)), attempt: "1" }));
      }
    }
  }
  return parts;
}

async function checkDevCompare(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "pixelwatch-dev-parity-"));
  try {
    for (const name of RECORDINGS) {
      const parts = convertedParts(name);
      if (parts === undefined || parts.length === 0) {
        failures++;
        console.log(`FAIL ${name}: reference captures not found in .reference/`);
        continue;
      }
      for (const part of parts) {
        const dir = join(scratch, name, part.bundle.revision, part.artifactName);
        mkdirSync(dir, { recursive: true });
        for (const [file, bytes] of part.files) writeFileSync(join(dir, file), bytes);
      }
      let stdout = "";
      let stderr = "";
      const started = performance.now();
      const code = await main(["compare", join(scratch, name, "base"), join(scratch, name, "head")], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
      const ms = performance.now() - started;
      if (code > EXIT.incomplete) {
        failures++;
        console.log(`FAIL ${name}: exit ${String(code)}: ${stderr.trim()}`);
        continue;
      }
      const report = JSON.parse(stdout) as DevReport;
      const { views } = JSON.parse(readFileSync(join(ROOT, "testdata", "comparator", name, "prototype.json"), "utf8")) as { views: View[] };
      const goldens = views.flatMap((v) => golden(v) ?? []);
      const byKey = new Map(report.results.map((r) => [`${r.providerId}/${r.viewId}/${r.variantId}`, r]));
      const tally: Record<string, number> = {};
      let bad = 0;
      for (const want of goldens) {
        const key = `${want.providerId}/${want.viewId}/${want.variantId}`;
        const got = byKey.get(key);
        byKey.delete(key);
        if (got === undefined) {
          bad++;
          console.log(`FAIL ${name}/${key}: not in the report`);
          continue;
        }
        const unlabelled: RunResult = { ...got };
        delete unlabelled.labels;
        if (!isDeepStrictEqual(unlabelled, want)) {
          bad++;
          console.log(`FAIL ${name}/${key}: ${firstDifference(unlabelled, want)}`);
          continue;
        }
        tally[got.status] = (tally[got.status] ?? 0) + 1;
      }
      for (const [key, extra] of byKey) {
        bad++;
        console.log(`FAIL ${name}/${key}: in the report (${extra.status}) but not a recorded compared view`);
      }
      const expectedCode = goldens.every((g) => g.status === "unchanged") ? EXIT.noDifferences : EXIT.differences;
      if (code !== expectedCode || report.coverage.status !== "complete-declared") {
        bad++;
        console.log(`FAIL ${name}: exit ${String(code)} (${report.outcome}, ${report.coverage.status}); the goldens imply exit ${String(expectedCode)}`);
      }
      failures += bad;
      console.log(
        `${name} via pixelwatch-dev compare: ${String(parts.length)} parts, ${String(report.results.length)} results, exit ${String(code)} (${report.outcome}), ` +
          `${ms.toFixed(0)} ms; matched ${JSON.stringify(tally)}; ${String(bad)} failures`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes("--dev-compare")) await checkDevCompare();
else await checkCore();
console.log(`${String(failures)} failures in total`);
process.exitCode = failures === 0 ? 0 : 1;


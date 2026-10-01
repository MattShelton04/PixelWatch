// Local-only full-size parity for M1.3 (ADR comparator-v1, "Consequences"): runs the core
// comparator on every compared view of the three full-size recordings and requires the exact
// result that `comparedResult` maps from the recorded prototype output. Inputs are the real PNGs
// in .reference/ (ADR 0001, git-ignored), found by their recorded SHA-256. Not part of
// `pnpm check`; tests never read .reference/.
//
//   node tools/check-reference-compare.ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { COMPARATOR_V1, compareImages, decodePng, pixelHash, unitResult } from "../packages/core/src/index.ts";
import type { CapturedSide, RunResult } from "../packages/schemas/src/generated/types.ts";
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
    const side = (s: RecordedSide): CapturedSide => ({ state: "captured", pixelHash: s.pixelHash, width: s.width, height: s.height });
    const identity = { providerId: view.provider ?? "fixture", viewId: view.id, variantId: "desktop" };
    const port = unitResult(identity, side(base), side(head), compareImages(baseImage, headImage, COMPARATOR_V1));
    const golden: RunResult = { ...identity, ...comparedResult(view.id, base, head, view.prototype, undefined, undefined), base: side(base), head: side(head) };
    if (JSON.stringify(port) !== JSON.stringify(golden)) {
      failures++;
      console.log(`FAIL ${label}: ${firstDifference(port, golden)}`);
      continue;
    }
    tally[port.status] = (tally[port.status] ?? 0) + 1;
  }
  console.log(`${name}: ${String(compared)} compared views; matched ${JSON.stringify(tally)}`);
}
console.log(`${String(bySha.size)} distinct real PNGs indexed; ${String(failures)} failures`);
process.exitCode = failures === 0 ? 0 : 1;

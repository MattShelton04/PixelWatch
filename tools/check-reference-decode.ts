// Local-only evidence for M1.1/M1.2 (ADR comparator-v1, "Consequences"): decodes every real
// prototype PNG in .reference/ (ADR 0001, git-ignored) with the trusted decoder. Each file must
// match fast-png's RGBA. Files with a recorded Pillow pixel hash (testdata/comparator/*/prototype.json)
// must also match that hash. Not part of `pnpm check`; tests never read .reference/.
//
//   node tools/check-reference-decode.ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decode as fastPngDecode } from "fast-png";
import { decodePng, pixelHash } from "../packages/core/src/index.ts";

const ROOT = join(import.meta.dirname, "..");
const DIRS = [join(ROOT, ".reference", "artifacts"), join(ROOT, ".reference", "m06", "base"), join(ROOT, ".reference", "m06", "head"), join(ROOT, ".reference", "m06", "tp-36287837535"), join(ROOT, ".reference", "m06", "tp-36301239732")];
const RECORDINGS = ["propertyscope-pr123", "tracepilot-36287837535", "tracepilot-36301239732"];

interface RecordedSide {
  fileSha256: string;
  pixelHash: string;
}

function pngs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pngs(path);
    return name.endsWith(".png") ? [path] : [];
  });
}

const recorded = new Map<string, string>();
for (const name of RECORDINGS) {
  const file = JSON.parse(readFileSync(join(ROOT, "testdata", "comparator", name, "prototype.json"), "utf8")) as {
    views: { inputs?: Partial<Record<"base" | "head", RecordedSide>> }[];
  };
  for (const view of file.views) for (const side of Object.values(view.inputs ?? {})) recorded.set(side.fileSha256, side.pixelHash);
}

const seen = new Set<string>();
let checked = 0;
let hashed = 0;
let failures = 0;
for (const path of DIRS.flatMap(pngs)) {
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (seen.has(sha)) continue;
  seen.add(sha);
  const ours = await decodePng(bytes);
  const theirs = fastPngDecode(bytes);
  const same =
    ours.width === theirs.width &&
    ours.height === theirs.height &&
    ours.channels === theirs.channels &&
    Buffer.from(ours.data).equals(Buffer.from(theirs.data.buffer, theirs.data.byteOffset, theirs.data.byteLength));
  const expected = recorded.get(sha);
  const hashOk = expected === undefined || pixelHash(ours) === expected;
  if (expected !== undefined) hashed++;
  checked++;
  if (!same || !hashOk) {
    failures++;
    console.log(`FAIL ${path}: ${same ? "" : "differs from fast-png "}${hashOk ? "" : "pixel hash differs from the recording"}`);
  }
}
console.log(`${String(checked)} distinct real PNGs decoded; ${String(hashed)} matched recorded Pillow pixel hashes; ${String(recorded.size)} recorded hashes; ${String(failures)} failures`);
process.exitCode = failures === 0 && checked > 0 ? 0 : 1;

// Local-only evidence for M0.3: converts the real prototype capture output in .reference/
// (ADR 0001, git-ignored) with its real PNGs and prints what came out. Not part of `pnpm check`;
// tests never read .reference/.
//
//   node tools/check-reference-conversion.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConvertedBundle,
  convertPropertyScope,
  convertTracePilot,
  parseArtifactName,
  parseDocument,
} from "../packages/schemas/src/index.ts";

const root = join(import.meta.dirname, "..", ".reference", "artifacts");

function readImages(dir: string): Map<string, Uint8Array> {
  const images = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) if (name.endsWith(".png")) images.set(name, readFileSync(join(dir, name)));
  return images;
}

function report(source: string, converted: ConvertedBundle): boolean {
  const bundleJson = converted.files.get("bundle.json");
  const reparsed = bundleJson === undefined ? undefined : parseDocument("bundle", bundleJson);
  const states = new Map<string, number>();
  for (const unit of converted.bundle.units) states.set(unit.state, (states.get(unit.state) ?? 0) + 1);
  const pngs = [...converted.files.keys()].filter((f) => f.endsWith(".png")).length;
  const identity = parseArtifactName(converted.artifactName);
  const ok =
    reparsed?.ok === true &&
    identity?.revision === converted.bundle.revision &&
    identity.providerId === converted.bundle.providerId &&
    pngs === (states.get("captured") ?? 0);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${source} -> ${converted.artifactName}: ${String(converted.bundle.units.length)} units ` +
      `(${[...states].map(([s, n]) => `${s} ${String(n)}`).join(", ")}), ${String(pngs)} PNGs` +
      (reparsed?.ok === false ? ` [${reparsed.issue.message}]` : ""),
  );
  return ok;
}

let failures = 0;
let found = 0;
for (const run of existsSync(root) ? readdirSync(root) : []) {
  const runDir = join(root, run);
  if (run.endsWith("-zips")) continue;
  for (const artifact of readdirSync(runDir)) {
    const dir = join(runDir, artifact);
    for (const file of readdirSync(dir)) {
      const manifest = readFileSync(join(dir, file));
      let converted: ConvertedBundle | undefined;
      if (run.startsWith("ps-") && /^capture-[a-z]+\.json$/.test(file)) {
        converted = convertPropertyScope({ manifest, images: readImages(dir), attempt: "1" });
      } else if (run.startsWith("tp-") && /^capture-\d+-\d+\.json$/.test(file)) {
        converted = convertTracePilot({ manifest, images: readImages(dir), attempt: "1" });
      }
      if (converted === undefined) continue;
      found++;
      if (!report(`${run}/${artifact}`, converted)) failures++;
    }
  }
}
if (found === 0) {
  console.error("No reference capture output found under .reference/artifacts (see ADR 0001). Nothing ran.");
  process.exitCode = 1;
} else if (failures > 0) {
  process.exitCode = 1;
}

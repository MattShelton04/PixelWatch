import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildViewerFixture } from "./fixture.ts";

const directory = process.argv[2];
if (directory === undefined || process.argv.length !== 3) { process.stderr.write("Usage: pnpm viewer:fixture <empty-directory>\nNothing generated.\n"); process.exitCode = 4; }
else {
  try {
    const root = resolve(directory); mkdirSync(root, {recursive: true}); const fixture = await buildViewerFixture(root);
    process.stdout.write(`Actual generated viewer: ${fixture.root}\nRun entry: ${fixture.entryPath}\nSynthetic local acceptance inputs; no live capture evidence.\n`);
  } catch { process.stderr.write("Fixture unavailable: destination must be an empty directory.\n"); process.exitCode = 1; }
}

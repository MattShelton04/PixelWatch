import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startPreview } from "./serve.ts";
import { parseDocument, parseRunKey } from "../../packages/schemas/src/index.ts";

/** Discover bounded, validated generated site roots, including all four allowed prefix segments. */
export function previewEntries(directory: string): readonly string[] {
  const root = resolve(directory); const entries: string[] = []; let visited = 0;
  const plainFile = (path: string, maxBytes: number): boolean => {
    try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes; } catch { return false; }
  };
  const walk = (parts: readonly string[]): void => {
    if (++visited > 20_000) throw new Error("preview discovery limit");
    const path = join(root, ...parts); const prefix = parts.join("/"); const metadata = join(path, "site.json");
    if (parts.length > 0 && plainFile(metadata, 1024 * 1024)) {
      const checked = parseDocument("site", readFileSync(metadata));
      if (checked.ok && checked.value.basePath === prefix && plainFile(join(path, "index.html"), 32 * 1024 * 1024)) {
        entries.push(`${prefix}/`);
        const runs = join(path, "runs");
        try {
          const stat = lstatSync(runs);
          if (stat.isDirectory() && !stat.isSymbolicLink()) for (const run of readdirSync(runs, {withFileTypes: true})) {
            if (++visited > 20_000) throw new Error("preview discovery limit");
            if (run.isDirectory() && !run.isSymbolicLink() && parseRunKey(run.name) !== undefined && plainFile(join(runs, run.name, "index.html"), 32 * 1024 * 1024)) entries.push(`${prefix}/runs/${run.name}/`);
          }
        } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        return;
      }
    }
    if (parts.length === 4) return;
    for (const child of readdirSync(path, {withFileTypes: true})) if (child.isDirectory() && !child.isSymbolicLink() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(child.name)) walk([...parts, child.name]);
  };
  const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid preview directory");
  walk([]); return entries.sort();
}

export async function serve(argv: readonly string[], write: (text: string) => void): Promise<number> {
  const directory = argv[0];
  if (directory === undefined || (argv.length !== 1 && (argv.length !== 3 || argv[1] !== "--port" || !/^[1-9][0-9]{0,4}$/.test(argv[2] ?? "")))) { write("Usage: pixelwatch-dev serve <generated-site-directory> [--port 4173]\nNothing served.\n"); return 4; }
  try {
    const root = resolve(directory); const entries = previewEntries(root);
    if (entries.length === 0) throw new Error("no generated entries");
    const preview = await startPreview(root, {port: argv.length === 1 ? 4173 : Number(argv[2])});
    write(`PixelWatch preview: ${preview.origin}/\n`);
    for (const entry of entries) write(`Generated site entry: ${preview.origin}/${entry}\n`);
    const close = () => { void preview.close().then(() => {process.exitCode = 0;}, () => {process.exitCode = 1;}); };
    process.once("SIGINT", close); process.once("SIGTERM", close); return 0;
  } catch { write("Preview unavailable: provide a generated site directory and an unused loopback port.\n"); return 1; }
}

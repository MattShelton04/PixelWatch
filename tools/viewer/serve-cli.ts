import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { startPreview } from "./serve.ts";

export async function serve(argv: readonly string[], write: (text: string) => void): Promise<number> {
  const directory = argv[0];
  if (directory === undefined || (argv.length !== 1 && (argv.length !== 3 || argv[1] !== "--port" || !/^[1-9][0-9]{0,4}$/.test(argv[2] ?? "")))) { write("Usage: pixelwatch-dev serve <generated-site-directory> [--port 4173]\nNothing served.\n"); return 4; }
  try {
    const root = resolve(directory); const preview = await startPreview(root, {port: argv.length === 1 ? 4173 : Number(argv[2])});
    write(`PixelWatch preview: ${preview.origin}/\n`);
    for (const item of readdirSync(root, {withFileTypes: true})) if (item.isDirectory() && !item.isSymbolicLink() && /^[A-Za-z0-9_-]+$/.test(item.name)) write(`Generated site entry: ${preview.origin}/${item.name}/\n`);
    const close = () => { void preview.close().then(() => {process.exitCode = 0;}, () => {process.exitCode = 1;}); };
    process.once("SIGINT", close); process.once("SIGTERM", close); return 0;
  } catch { write("Preview unavailable: provide a generated site directory and an unused loopback port.\n"); return 1; }
}

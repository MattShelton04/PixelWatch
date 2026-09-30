// `pnpm tools:install`: download the pinned actionlint and zizmor release binaries for this
// platform, verify their SHA-256, and unpack them into .tools/bin. This is the only networked
// setup step; `pnpm check` itself never downloads anything.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  binaryPath,
  binDir,
  installedManifestPath,
  loadManifest,
  platformKey,
  toolNames,
  verifySha256,
} from "./lib/lint-tools.ts";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

async function download(url: string): Promise<Uint8Array> {
  if (!url.startsWith("https://github.com/")) throw new Error(`refusing non-GitHub URL ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${String(response.status)}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`${url} exceeds the download cap`);
  return body;
}

function extract(archive: string, into: string): void {
  // Windows' bundled bsdtar reads both .zip and .tar.gz; Git Bash's GNU tar can't read .zip.
  const tar =
    process.platform === "win32"
      ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const result = spawnSync(tar, ["-xf", archive, "-C", into], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`failed to extract ${archive}`);
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const key = platformKey();
  mkdirSync(binDir, { recursive: true });
  const installed: Record<string, string> = {};

  for (const name of toolNames) {
    const tool = manifest[name];
    const asset = tool.assets[key];
    if (asset === undefined) throw new Error(`${name} ${tool.version} has no pinned asset for ${key}`);

    const work = mkdtempSync(path.join(tmpdir(), `pixelwatch-${name}-`));
    try {
      const data = await download(asset.url);
      verifySha256(data, asset.sha256, `${name} ${tool.version} (${key})`);
      const archive = path.join(work, path.basename(new URL(asset.url).pathname));
      writeFileSync(archive, data);
      const unpacked = path.join(work, "out");
      mkdirSync(unpacked);
      extract(archive, unpacked);
      const target = binaryPath(tool);
      copyFileSync(path.join(unpacked, path.basename(target)), target);
      chmodSync(target, 0o755);
      installed[name] = tool.version;
      console.log(`installed ${name} ${tool.version} -> ${path.relative(process.cwd(), target)}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  writeFileSync(installedManifestPath, `${JSON.stringify(installed, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(`tools:install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

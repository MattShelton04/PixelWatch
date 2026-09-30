// Shared by `pnpm tools:install` (the only networked step) and `pnpm lint:workflows` (offline).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const binDir = path.join(repoRoot, ".tools", "bin");
export const installedManifestPath = path.join(binDir, "installed.json");

export type ToolName = "actionlint" | "zizmor";
export const toolNames: readonly ToolName[] = ["actionlint", "zizmor"];

export interface ToolAsset {
  url: string;
  sha256: string;
}

export interface ToolPin {
  version: string;
  binary: string;
  assets: Partial<Record<string, ToolAsset>>;
}

export type ToolManifest = Record<ToolName, ToolPin>;

export function loadManifest(): ToolManifest {
  const raw = readFileSync(path.join(repoRoot, "tools", "lint-tools.json"), "utf8");
  return JSON.parse(raw) as ToolManifest;
}

export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

export function binaryPath(tool: ToolPin, platform: NodeJS.Platform = process.platform): string {
  return path.join(binDir, platform === "win32" ? `${tool.binary}.exe` : tool.binary);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws unless `data` hashes to `expected` (64 lowercase hex). */
export function verifySha256(data: Uint8Array, expected: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`${label}: pinned SHA-256 is not 64 lowercase hex`);
  }
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new Error(`${label}: SHA-256 mismatch (expected ${expected}, got ${actual})`);
  }
}

export const installHint =
  "Run `pnpm tools:install` (downloads the pinned actionlint and zizmor into .tools/bin).";

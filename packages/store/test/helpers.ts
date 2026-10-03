import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalBytes, parseDocument, type Run } from "@pixelwatch/schemas";
import { addRun, newStore, runRecordPath } from "@pixelwatch/core";
import type { StoreCandidate } from "../src/index.ts";

export const REPOSITORY_ID = "987654321";
export const METADATA = { timestamp: "2000-01-01T00:00:00Z" };
export function run(id = "101", captured = false): Run {
  const parsed = parseDocument("run", readFileSync(new URL(`../../../testdata/schemas/run/valid/${captured ? "initial-commit-no-baseline" : "no-usable-artifact"}.json`, import.meta.url)));
  if (!parsed.ok) throw new Error("invalid fixture");
  return { ...parsed.value, runKey: `${id}-a1`, source: { ...parsed.value.source, runId: id } };
}
export function candidate(runs: readonly Run[] = []): StoreCandidate & { files: Map<string, Uint8Array>; runs: Map<string, Run> } {
  let store = newStore(REPOSITORY_ID);
  const files = new Map<string, Uint8Array>();
  for (const value of runs) { store = addRun(store, value).store; files.set(runRecordPath(value.runKey), canonicalBytes(value)); }
  files.set("store.json", canonicalBytes(store));
  return { store, runs: new Map(runs.map((r) => [r.runKey, r])), files, metadata: METADATA };
}
export class Scratch {
  readonly root = mkdtempSync(join(tmpdir(), "pixelwatch-store-"));
  readonly remote = join(this.root, "remote.git");
  readonly hooks = join(this.root, "empty-hooks");
  readonly env: NodeJS.ProcessEnv;
  constructor() {
    mkdirSync(this.hooks); const config = join(this.root, "empty-config"); writeFileSync(config, "");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    this.env = { ...env, HOME: this.root, USERPROFILE: this.root, XDG_CONFIG_HOME: this.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: "946684800 +0000", GIT_COMMITTER_DATE: "946684800 +0000" };
    this.git(["init", "--bare", "--object-format=sha1", `--template=${this.hooks}`, this.remote], undefined, this.root);
  }
  git(args: string[], input?: string | Uint8Array, cwd = this.remote): string {
    const result = spawnSync("git", ["-c", `core.hooksPath=${this.hooks}`, "-c", "credential.helper=", "-c", "commit.gpgSign=false", ...args],
      { cwd, env: this.env, input, maxBuffer: 2 * 1024 * 1024, timeout: 30_000, windowsHide: true });
    if (result.status !== 0) throw new Error("fixture-git-failed");
    return result.stdout.toString("utf8").trim();
  }
  seed(files: ReadonlyMap<string, Uint8Array>, ref = "refs/heads/pixelwatch-data", mode = "100644"): string {
    const treeAt = (prefix: string): string => {
      const records: string[] = []; const directories = new Set<string>();
      for (const [path, bytes] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length); const slash = rest.indexOf("/");
        if (slash < 0) records.push(`${mode} blob ${this.git(["hash-object", "-w", "--stdin"], bytes)}\t${rest}\n`);
        else directories.add(rest.slice(0, slash));
      }
      for (const directory of directories) records.push(`040000 tree ${treeAt(`${prefix}${directory}/`)}\t${directory}\n`);
      return this.git(["mktree"], records.sort().join(""));
    };
    const tree = treeAt("");
    const tip = this.git(["commit-tree", tree], "fixture\n");
    this.git(["update-ref", ref, tip]); return tip;
  }
  close(): void {
    const target = resolve(this.root); const rel = relative(resolve(tmpdir()), target);
    if (isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith("pixelwatch-store-")) throw new Error("unsafe cleanup");
    rmSync(target, { recursive: true, force: true });
  }
}

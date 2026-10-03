// Test infrastructure only: a fully generated remote, never this checkout's Git/config/remotes.
import { spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { parseDocument, type Run } from "../../../packages/schemas/src/index.ts";
import { assertNoSecrets } from "../capture.ts";

export const REPOSITORY_ID = "987654321";
export function fixtureRun(id: string): Run {
  const parsed = parseDocument("run", readFileSync(new URL("../../../testdata/schemas/run/valid/no-usable-artifact.json", import.meta.url)));
  if (!parsed.ok || !/^10[1-4]$/.test(id)) throw new Error("store-simulation-fixture-invalid");
  return { ...parsed.value, runKey: `${id}-a1`, source: { ...parsed.value.source, runId: id } };
}
export class StoreRemote {
  readonly root = mkdtempSync(join(tmpdir(), "pixelwatch-store-sim-"));
  readonly remote = join(this.root, "remote.git");
  readonly raw: string[] = [];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #hooks = join(this.root, "empty-hooks");
  readonly #empty = join(this.root, "empty-config");
  constructor() {
    mkdirSync(this.#hooks); writeFileSync(this.#empty, ""); const allowed: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) { const value = process.env[key]; if (value !== undefined) allowed[key] = value; }
    this.#environment = { ...allowed, HOME: this.root, USERPROFILE: this.root, XDG_CONFIG_HOME: this.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: this.#empty, GIT_CONFIG_GLOBAL: this.#empty, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C", LANG: "C", TZ: "UTC" };
    try { this.#git(["init", "--bare", "--quiet", "--object-format=sha1", `--template=${this.#hooks}`, this.remote], this.root); } catch (error) { this.close(); throw error; }
  }
  #git(args: string[], cwd = this.remote): string {
    const location = relative(this.root, resolve(cwd)); if (isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`)) throw new Error("store-simulation-outside-scratch");
    const result = spawnSync("git", ["--no-optional-locks", "-c", `core.hooksPath=${this.#hooks}`, "-c", `core.attributesFile=${this.#empty}`, "-c", "credential.helper=", "-c", "core.sshCommand=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false", ...args],
      { cwd, env: this.#environment, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    // Scan raw diagnostics BEFORE discarding/redacting them. They never become normalized evidence.
    const output = (value: unknown) => Buffer.isBuffer(value) ? value.toString("utf8") : "";
    const raw = [output(result.stdout), output(result.stderr), result.error?.message ?? ""]; assertNoSecrets(raw); this.raw.push(...raw);
    if (result.status !== 0 || result.error !== undefined || result.signal !== null) throw new Error("store-simulation-git-failed"); return raw[0]?.trim() ?? "";
  }
  tip(): string { const value = this.#git(["rev-parse", "--verify", "refs/heads/pixelwatch-data"]); if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("store-simulation-tip-invalid"); return value; }
  assertCleanFiles(): void {
    let count = 0; let bytes = 0;
    const visit = (directory: string) => { for (const name of readdirSync(directory)) { const path = join(directory, name); const info = lstatSync(path); if (info.isSymbolicLink()) throw new Error("store-simulation-scratch-link"); if (info.isDirectory()) visit(path); else {
      if (++count > 10_000 || (bytes += info.size) > 64 * 1024 * 1024) throw new Error("store-simulation-fixture-limit"); assertNoSecrets([readFileSync(path)]);
    } } }; visit(this.root); assertNoSecrets(this.raw);
  }
  close(): void {
    const root = resolve(this.root); const location = relative(resolve(tmpdir()), root);
    if (isAbsolute(location) || !/^pixelwatch-store-sim-[A-Za-z0-9_-]+$/.test(location) || lstatSync(root).isSymbolicLink()) throw new Error("store-simulation-cleanup-refused"); rmSync(root, { recursive: true, force: true });
  }
}
export interface Gate { readonly promise: Promise<void>; release(): void }
export function gate(): Gate { let release: (() => void) | undefined; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release: () => { if (release === undefined) throw new Error("store-simulation-gate-invalid"); release(); } }; }

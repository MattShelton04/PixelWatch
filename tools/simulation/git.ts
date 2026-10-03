// Real Git, test infrastructure only. All transport endpoints are generated temporary paths.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { assertNoSecrets } from "./capture.ts";

const REF = "refs/heads/pixelwatch-data";
const OID = /^[0-9a-f]{40}$/;
interface Result { ok: boolean; text: string }
export class BareRemote {
  readonly root: string;
  readonly remotePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly trace: string[] = [];
  #empty: string;
  #hooks: string;
  #writers = new Set<string>();
  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "pixelwatch-simulation-"));
    this.remotePath = join(this.root, "remote.git");
    this.#hooks = join(this.root, "empty-hooks");
    this.#empty = join(this.root, "empty-config");
    mkdirSync(this.#hooks);
    writeFileSync(this.#empty, "");
    const env: NodeJS.ProcessEnv = {};
    // Do not enumerate the host environment or read tokens, Git overrides, HOME or USERPROFILE.
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    this.environment = Object.freeze({ ...env, HOME: this.root, USERPROFILE: this.root, XDG_CONFIG_HOME: this.root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: this.#empty, GIT_CONFIG_GLOBAL: this.#empty,
      GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
      GIT_AUTHOR_NAME: "Simulation", GIT_AUTHOR_EMAIL: "simulation@example.invalid",
      GIT_COMMITTER_NAME: "Simulation", GIT_COMMITTER_EMAIL: "simulation@example.invalid",
      GIT_AUTHOR_DATE: "946684800 +0000", GIT_COMMITTER_DATE: "946684800 +0000",
      LC_ALL: "C", LANG: "C", TZ: "UTC" });
    try {
      if (!this.#exec(this.root, ["init", "--bare", "--object-format=sha1", `--template=${this.#hooks}`, this.remotePath]).ok) throw new Error("git-init-failed");
      // Local receive-pack runs at the other end of the file transport: pin its hooks too.
      if (!this.#exec(this.remotePath, ["config", "core.hooksPath", this.#hooks]).ok) throw new Error("git-config-failed");
      mkdirSync(join(this.remotePath, "hooks"));
    } catch (error) { this.close(); throw error; }
  }
  #exec(cwd: string, args: string[], input?: string): Result {
    const rel = relative(this.root, resolve(cwd));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../")) throw new Error("git-outside-scratch");
    const result = spawnSync("git", ["--no-optional-locks", "-c", `core.hooksPath=${this.#hooks}`,
      "-c", `core.attributesFile=${this.#empty}`, "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
      "-c", "credential.helper=", "-c", "core.sshCommand=false", "-c", "commit.gpgSign=false",
      "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false", ...args],
    { cwd, env: this.environment, encoding: "utf8", input, maxBuffer: 1024 * 1024, windowsHide: true });
    // Raw Git errors can echo paths or tree input. Nothing captures or prints them.
    if (result.error !== undefined || result.signal !== null) throw new Error("git-process-failed");
    return { ok: result.status === 0, text: result.stdout };
  }
  writer(name: string): GitWriter {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || this.#writers.has(name)) throw new Error("git-writer-ambiguous");
    this.#writers.add(name);
    const dir = join(this.root, `${name}.git`);
    const init = this.#exec(this.root, ["init", "--bare", "--object-format=sha1", `--template=${this.#hooks}`, dir]);
    if (!init.ok) throw new Error("git-init-failed");
    const exec = (args: string[], input?: string) => this.#exec(dir, args, input);
    return new GitWriter(exec, this.remotePath, this.trace);
  }
  storedFiles(): string[] {
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error("git-scratch-link");
        if (stat.isDirectory()) visit(full); else files.push(full);
      }
    };
    visit(this.root);
    return files;
  }
  close(): void {
    const root = resolve(this.root);
    const rel = relative(resolve(tmpdir()), root);
    if (isAbsolute(rel) || rel.includes("..") || !rel.startsWith("pixelwatch-simulation-")) throw new Error("git-cleanup-outside-scratch");
    rmSync(root, { recursive: true, force: true });
  }
}

export class GitWriter {
  #exec: (args: string[], input?: string) => Result;
  #remote: string;
  #trace: string[];
  constructor(exec: (args: string[], input?: string) => Result, remote: string, trace: string[]) {
    this.#exec = exec; this.#remote = remote; this.#trace = trace;
  }
  #must(args: string[], input?: string, trim = true): string {
    const r = this.#exec(args, input);
    if (!r.ok) throw new Error("git-command-failed");
    return trim ? r.text.trim() : r.text;
  }
  fetch(): string | undefined {
    const listing = this.#must(["ls-remote", "--refs", this.#remote, REF]);
    if (listing === "") return undefined;
    const oid = listing.split(/\s/)[0];
    if (oid === undefined || !OID.test(oid)) throw new Error("git-ref-invalid");
    this.#must(["fetch", "--no-tags", "--depth=1", this.#remote, REF]);
    const fetched = this.#must(["rev-parse", "FETCH_HEAD"]);
    if (!OID.test(fetched)) throw new Error("git-ref-invalid");
    return fetched;
  }
  commit(files: ReadonlyMap<string, string>): string {
    assertNoSecrets([...files.keys(), ...files.values()]);
    const records: string[] = [];
    for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!/^(?:[a-z][a-z0-9.-]*|\.gitattributes)$/.test(name)) throw new Error("git-tree-path-invalid");
      const oid = this.#must(["hash-object", "-w", "--stdin", "--no-filters"], bytes);
      records.push(`100644 blob ${oid}\t${name}\n`);
    }
    const tree = this.#must(["mktree"], records.join(""));
    const oid = this.#must(["commit-tree", tree], "simulation\n");
    if (!OID.test(oid)) throw new Error("git-commit-invalid");
    return oid;
  }
  push(oid: string, expected: string | undefined): boolean {
    if (!OID.test(oid) || expected !== undefined && !OID.test(expected)) throw new Error("git-lease-invalid");
    const result = this.#exec(["push", "--porcelain", `--force-with-lease=${REF}:${expected ?? ""}`, this.#remote, `${oid}:${REF}`]);
    if (!result.ok && !result.text.includes("[rejected]")) throw new Error("git-push-failed");
    this.#trace.push(`push:${expected === undefined ? "expected-absent" : "explicit-lease"}:${result.ok ? "accepted" : "conflict"}`);
    return result.ok;
  }
  read(oid: string): Map<string, string> {
    if (!OID.test(oid)) throw new Error("git-object-invalid");
    const listing = this.#must(["ls-tree", "-z", oid]);
    const files = new Map<string, string>();
    for (const entry of listing.split("\0").filter(Boolean)) {
      const match = /^100644 blob ([0-9a-f]{40})\t([a-z.][a-z0-9.-]*)$/.exec(entry);
      if (match?.[1] === undefined || match[2] === undefined) throw new Error("git-tree-mode-refused");
      files.set(match[2], this.#must(["cat-file", "blob", match[1]], undefined, false));
    }
    return files;
  }
  parents(oid: string): string[] {
    if (!OID.test(oid)) throw new Error("git-object-invalid");
    return this.#must(["cat-file", "commit", oid]).split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  }
}

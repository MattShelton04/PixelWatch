import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cloneCandidate, identity, immutableBeforeWrite, listing, snapshot, tip, validateCandidate } from "./validate.ts";
import { guarded, refuse, STORE_LIMITS, StoreError, type CasResult, type StoreAdapter, type StoreCandidate, type StoreIdentity, type StoreSnapshot } from "./types.ts";
import { indexReservation, MAX_PACK_OBJECTS, PackReceiver, uploadRequest, validatePack } from "./pack.ts";
import { defaultTiming, httpPackTransport, terminateChildTree, type PackTransport, type StoreTiming } from "./transport.ts";

const OID = /^[0-9a-f]{40}$/;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured intrinsic is rebound to the signal below.
const nativeAddListener = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured intrinsic is rebound to the signal below.
const nativeRemoveListener = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured intrinsic getter is rebound to the signal below.
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
function aborted(signal: AbortSignal): boolean {
  if (nativeAborted === undefined) refuse("store-operation-failed");
  const value: unknown = nativeAborted.call(signal); if (typeof value !== "boolean") refuse("store-operation-failed"); return value;
}
// Explicit removal keeps a throwing native remove hook inside our cleanup boundary.
function listen(signal: AbortSignal, callback: () => void): void { nativeAddListener.call(signal, "abort", callback); }
function unlink(signal: AbortSignal, callback: () => void): void { nativeRemoveListener.call(signal, "abort", callback); }
function cleanup(steps: readonly (() => void)[]): void {
  let failed = false; for (const step of steps) { try { step(); } catch { failed = true; } }
  if (failed) refuse("store-operation-failed");
}
export interface GitBranchOptions extends StoreIdentity {
  readonly remote: string;
  /** Supplied credential only, never read from ambient env; not part of remote URLs. */
  readonly token?: string;
  /** Explicit test-only local transport, confined to generated pixelwatch-store-* scratch. */
  readonly testRemote?: { readonly root: string };
  readonly checkpoint?: (event: GitCheckpoint) => Promise<void>;
  readonly packTransport?: PackTransport;
  readonly timing?: StoreTiming;
  readonly packCheckpoint?: (event: GitPackCheckpoint) => Promise<void>;
}
export interface GitCheckpoint { readonly point: "before-push" | "after-push"; readonly expectedTip: string | null; readonly newTip: string; readonly result?: CasResult["status"] }
export interface GitPackCheckpoint { readonly point: "child-started" | "chunk-written" | "before-index"; readonly pid?: number; readonly bytes?: number }
interface GitResult { readonly ok: boolean; readonly stdout: Buffer; readonly interrupted: boolean }
export class GitBranchStore implements StoreAdapter {
  readonly #repositoryId: string;
  readonly #ref: string;
  readonly #remote: string;
  readonly #test: boolean;
  readonly #token: string | undefined;
  readonly #checkpoint: GitBranchOptions["checkpoint"];
  readonly #temporaryParent: string;
  readonly #packTransport: PackTransport;
  readonly #timing: StoreTiming;
  readonly #packCheckpoint: GitBranchOptions["packCheckpoint"];
  #root: string | undefined;
  #gitDir: string | undefined;
  #hooks: string | undefined;
  #empty: string | undefined;
  #environment: NodeJS.ProcessEnv | undefined;
  readonly #lifetime = new AbortController();
  readonly #operations = new Set<Promise<void>>();
  #closing: Promise<void> | undefined;
  constructor(options: GitBranchOptions) {
    this.#repositoryId = options.repositoryId; this.#ref = `refs/heads/${identity(options)}`; this.#token = options.token; this.#checkpoint = options.checkpoint;
    this.#packTransport = options.packTransport ?? httpPackTransport; this.#timing = options.timing ?? defaultTiming; this.#packCheckpoint = options.packCheckpoint;
    if (options.token !== undefined && (!/^[A-Za-z0-9_]+$/.test(options.token) || options.token.length > 512)) refuse("git-credential-invalid");
    this.#test = options.testRemote !== undefined;
    this.#temporaryParent = realpathSync.native(tmpdir());
    if (options.testRemote !== undefined) {
      const root = resolve(options.testRemote.root); const rel = relative(this.#temporaryParent, root);
      if (isAbsolute(rel) || !/^pixelwatch-store-[A-Za-z0-9_-]+$/.test(rel) || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) refuse("git-test-root-refused");
      const remote = resolve(options.remote); const child = relative(root, remote);
      if (isAbsolute(child) || child.startsWith("..") || child !== "remote.git" || lstatSync(remote).isSymbolicLink() || realpathSync(remote) !== remote) refuse("git-test-remote-refused");
      this.#remote = remote;
    } else {
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(options.remote) || options.remote.includes("/../") || options.remote.includes("/./")) refuse("git-remote-refused");
      this.#remote = options.remote;
    }
  }
  #initialize(): void {
    this.#alive();
    if (this.#root !== undefined) return;
    this.#root = mkdtempSync(join(this.#temporaryParent, "pixelwatch-store-client-")); this.#gitDir = join(this.#root, "client.git"); this.#hooks = join(this.#root, "empty-hooks"); this.#empty = join(this.#root, "empty-config");
    mkdirSync(this.#hooks); writeFileSync(this.#empty, "");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) { const value = process.env[key]; if (value !== undefined) env[key] = value; }
    this.#environment = { ...env, HOME: this.#root, USERPROFILE: this.#root, XDG_CONFIG_HOME: this.#root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: this.#empty, GIT_CONFIG_GLOBAL: this.#empty, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: this.#test ? "file" : "https", LC_ALL: "C", LANG: "C", TZ: "UTC" };
    if (this.#token !== undefined && !this.#test) {
      this.#environment["GIT_CONFIG_COUNT"] = "1"; this.#environment["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader";
      this.#environment["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.#token}`).toString("base64")}`;
    }
    this.#must(["init", "--bare", "--object-format=sha1", `--template=${this.#hooks}`, this.#gitDir], undefined, this.#root);
    if (this.#test) this.#must(["--git-dir", this.#remote, "config", "core.hooksPath", this.#hooks], undefined, this.#root);
  }
  #exec(args: readonly string[], input?: string | Uint8Array, cwd?: string, maximum = STORE_LIMITS.maxPngBytes): GitResult {
    this.#alive();
    const root = this.#root; if (root === undefined || this.#hooks === undefined || this.#empty === undefined || this.#environment === undefined) refuse("git-not-initialized");
    const directory = cwd ?? this.#gitDir; if (directory === undefined) refuse("git-not-initialized");
    const rel = relative(root, resolve(directory)); if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) refuse("git-path-refused");
    // Object-writing plumbing has known input bytes; reserve incompressible zlib overhead before it runs.
    if (["hash-object", "mktree", "commit-tree"].includes(args[0] ?? "")) {
      const bytes = typeof input === "string" ? Buffer.byteLength(input) : input?.byteLength ?? 0;
      if (this.#diskBudget() + bytes + Math.ceil(bytes / 1000) + 64 * 1024 > STORE_LIMITS.maxTreeBytes + STORE_LIMITS.maxPngBytes) refuse("git-disk-limit");
    }
    const result = spawnSync("git", this.#arguments(args),
      { cwd: directory, env: this.#environment, input, maxBuffer: maximum, timeout: STORE_LIMITS.processTimeoutMs, windowsHide: true });
    // Raw stderr/output is never logged or carried into thrown errors; it can contain a credential.
    this.#diskBudget();
    return { ok: result.status === 0 && result.error === undefined && result.signal === null, stdout: result.stdout, interrupted: result.error !== undefined || result.signal !== null };
  }
  #arguments(args: readonly string[]): string[] {
    if (this.#hooks === undefined || this.#empty === undefined) refuse("git-not-initialized");
    return ["--no-optional-locks", "-c", `core.hooksPath=${this.#hooks}`, "-c", `core.attributesFile=${this.#empty}`,
      "-c", "credential.helper=", "-c", "core.sshCommand=false", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
      "-c", "http.followRedirects=false", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", `protocol.${this.#test ? "file" : "https"}.allow=always`, "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false", ...args];
  }
  #diskBudget(): number {
    if (this.#root === undefined) return 0; let bytes = 0; let files = 0;
    const visit = (path: string): void => {
      for (const name of readdirSync(path)) {
        const full = join(path, name); const stat = lstatSync(full);
        if (stat.isSymbolicLink()) refuse("git-scratch-link");
        if (stat.isDirectory()) visit(full); else {
          bytes += stat.size; files++; if (bytes > STORE_LIMITS.maxTreeBytes + STORE_LIMITS.maxPngBytes || files > STORE_LIMITS.maxFiles + 10_000) refuse("git-disk-limit");
        }
      }
    }; visit(this.#root); return bytes;
  }
  async *#localPack(body: Uint8Array, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    if (this.#environment === undefined || this.#root === undefined) refuse("git-not-initialized");
    const environment = this.#environment;
    const child = spawn("git", this.#arguments(["upload-pack", "--stateless-rpc", this.#remote]), { cwd: this.#root, env: environment, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let spawnFailed = false;
    const completion = new Promise<boolean>((resolve) => { child.once("error", () => { spawnFailed = true; }); child.once("close", (code, sig) => { resolve(!spawnFailed && code === 0 && sig === null); }); });
    child.stderr.resume(); child.stdin.on("error", () => {}); child.stdin.end(body); let stopped = false; let stopFailed = false;
    const failedToStop = (): boolean => stopFailed;
    const stop = () => { if (stopped) return; stopped = true; if (child.pid !== undefined) { try { terminateChildTree(child.pid, environment); } catch { stopFailed = true; child.kill("SIGKILL"); } } child.stdout.destroy(); };
    listen(signal, stop);
    try {
      if (aborted(signal)) stop(); await this.#wait(this.#packCheckpoint?.({ point: "child-started", ...(child.pid === undefined ? {} : { pid: child.pid }) }), signal);
      for await (const chunk of child.stdout) { if (aborted(signal)) refuse("git-pack-deadline"); yield chunk as Buffer; }
      if (!await completion || aborted(signal)) refuse("git-pack-command-failed");
    } catch (error) { if (error instanceof StoreError && error.code !== "git-pack-deadline") throw error; refuse("git-pack-command-failed");
    } finally { unlink(signal, stop); if (child.exitCode === null && child.signalCode === null) stop(); await completion; if (failedToStop()) refuse("git-child-stop-failed"); }
  }
  async #fetchPack(want: string): Promise<void> {
    if (this.#root === undefined || this.#gitDir === undefined) refuse("git-not-initialized");
    const remaining = STORE_LIMITS.maxTreeBytes + STORE_LIMITS.maxPngBytes - this.#diskBudget() - indexReservation(MAX_PACK_OBJECTS) - 64 * 1024;
    const maximum = Math.min(STORE_LIMITS.maxTreeBytes, remaining); if (maximum < 32) refuse("git-disk-limit");
    const directory = join(this.#gitDir, "objects", "pack"); const pack = join(directory, "incoming.pack"); const index = join(directory, "incoming.idx");
    const fd = openSync(pack, "wx+"); let deadlineSignal: AbortSignal | undefined; let dispose: (() => void) | undefined;
    const controller = new AbortController(); const signal = controller.signal;
    const cancel = () => { controller.abort(); };
    try {
      listen(this.#lifetime.signal, cancel);
      const deadline = this.#timing.deadline(STORE_LIMITS.processTimeoutMs);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured disposal is rebound to this same acquired deadline below.
      const ownedDispose = deadline.dispose;
      if (typeof ownedDispose !== "function") refuse("store-operation-failed"); dispose = () => { ownedDispose.call(deadline); };
      deadlineSignal = deadline.signal;
      if (aborted(deadlineSignal) || aborted(this.#lifetime.signal)) cancel(); else listen(deadlineSignal, cancel);
      const request = uploadRequest(want); let chunks: AsyncIterable<Uint8Array>;
      if (this.#test) chunks = this.#localPack(request, signal);
      else {
        const headers: Record<string, string> = { "Content-Type": "application/x-git-upload-pack-request", Accept: "application/x-git-upload-pack-result", "Cache-Control": "no-cache" };
        if (this.#token !== undefined) headers["Authorization"] = `Basic ${Buffer.from(`x-access-token:${this.#token}`).toString("base64")}`;
        const result = await this.#wait(this.#packTransport.request({ url: `${this.#remote}/git-upload-pack`, body: request, headers, signal }), signal);
        if (result.status !== 200 || result.contentType !== "application/x-git-upload-pack-result") refuse("git-pack-response-invalid"); chunks = result.body;
      }
      const receiver = new PackReceiver({ fd, want, maxBytes: maximum, maxObjects: MAX_PACK_OBJECTS });
      const iterator = chunks[Symbol.asyncIterator]();
      try {
        for (;;) { const next = this.#test ? await iterator.next() : await this.#wait(iterator.next(), signal); if (next.done) break; if (aborted(signal)) refuse("git-pack-deadline"); receiver.write(next.value); await this.#wait(this.#packCheckpoint?.({ point: "chunk-written" }), signal); }
      } finally { await this.#returnPack(iterator, signal); }
      if (aborted(signal)) refuse("git-pack-deadline"); const received = receiver.finish(); validatePack(fd);
      if (received.shallow) writeFileSync(join(this.#gitDir, "shallow"), `${want}\n`);
      await this.#wait(this.#packCheckpoint?.({ point: "before-index", bytes: received.bytes }), signal); if (aborted(signal)) refuse("git-pack-deadline");
      const hash = this.#oid(["index-pack", "--strict", "--no-rev-index", "--index-version=2", "--threads=1", `--max-input-size=${String(maximum)}`, "-o", index, pack]);
      const target = join(directory, `pack-${hash}`);
      if (!existsSync(`${target}.pack`)) { renameSync(pack, `${target}.pack`); renameSync(index, `${target}.idx`); }
      this.#diskBudget(); if (this.#must(["cat-file", "-t", want]).toString("ascii").trim() !== "commit") refuse("git-ref-not-commit");
    } finally {
      cleanup([() => { unlink(this.#lifetime.signal, cancel); }, () => { if (deadlineSignal !== undefined) unlink(deadlineSignal, cancel); },
        () => { dispose?.(); }, () => { closeSync(fd); }, ...[pack, index].map((path) => () => { if (existsSync(path)) rmSync(path); })]);
    }
  }
  #must(args: readonly string[], input?: string | Uint8Array, cwd?: string, maximum?: number): Buffer {
    const result = this.#exec(args, input, cwd, maximum); if (!result.ok) refuse("git-command-failed"); return result.stdout;
  }
  #oid(args: readonly string[], input?: string | Uint8Array): string {
    const value = this.#must(args, input).toString("ascii").trim(); if (!OID.test(value)) refuse("git-object-invalid"); return value;
  }
  async #returnPack(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<void> {
    const returned = iterator.return?.();
    // Native Git owns a child and must join its close event. The HTTP transport's own
    // abort signal cancels its stream; an injected iterator cannot hold our pack FD open.
    if (this.#test) await returned; else { try { await this.#wait(returned, signal); } catch { if (!aborted(signal)) refuse("git-pack-command-failed"); } }
  }
  #alive(): void { if (aborted(this.#lifetime.signal)) refuse("git-not-initialized"); }
  /** Interrupt caller-owned promises while retaining every native resource until its own cleanup. */
  #wait<T>(pending: T | PromiseLike<T>, signal = this.#lifetime.signal): Promise<T> {
    const value = guarded(async () => await pending); // Observe and sanitize late rejections even after the lifetime wins.
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return; settled = true;
        try { unlink(signal, cancel); } catch { reject(new StoreError("store-operation-failed")); return; }
        action();
      };
      const cancel = () => { finish(() => { reject(new StoreError(aborted(this.#lifetime.signal) ? "git-not-initialized" : "git-pack-deadline")); }); };
      try { if (aborted(signal)) cancel(); else listen(signal, cancel); } catch { finish(() => { reject(new StoreError("store-operation-failed")); }); }
      value.then((value) => { finish(() => { resolve(value); }); }, (error: unknown) => { finish(() => { reject(error instanceof StoreError ? error : new StoreError("store-operation-failed")); }); });
    });
  }
  #operation<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void; const completed = new Promise<void>((resolve) => { release = resolve; }); this.#operations.add(completed);
    return guarded(async () => { this.#alive(); return await operation(); }).finally(() => { this.#operations.delete(completed); release(); });
  }
  read(): Promise<StoreSnapshot> { return this.#operation(() => this.#read()); }
  async #read(): Promise<StoreSnapshot> {
    this.#initialize();
    const remote = this.#must(["ls-remote", "--refs", this.#remote, this.#ref], undefined, undefined, 1024);
    const row = remote.toString("ascii").trim();
    if (row === "") return snapshot(this.#repositoryId, null, [], () => Promise.reject(new StoreError("store-file-missing")));
    if (!new RegExp(`^[a-f0-9]{40}\\t${this.#ref.replaceAll(".", "\\.")}$`).test(row)) refuse("git-ref-invalid");
    const current = row.slice(0, 40); await this.#fetchPack(current);
    const rows = this.#must(["ls-tree", "-rzl", current], undefined, undefined, 16 * 1024 * 1024).toString("utf8").split("\0").filter(Boolean);
    const objects = new Map<string, string>(); const files: { path: string; bytes: number }[] = [];
    for (const entry of rows) {
      const match = /^100644 blob ([a-f0-9]{40})\s+(\d+)\t([^\0]+)$/.exec(entry);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || objects.has(match[3])) refuse("git-tree-mode-refused");
      objects.set(match[3], match[1]); files.push({ path: match[3], bytes: Number(match[2]) });
    }
    listing(files);
    return snapshot(this.#repositoryId, current, files, (path) => {
      const object = objects.get(path); if (object === undefined) refuse("store-file-missing");
      return Promise.resolve(this.#must(["cat-file", "blob", object], undefined, undefined, path.endsWith(".json") ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes));
    });
  }
  #tree(files: ReadonlyMap<string, Uint8Array>): string {
    interface Directory { files: Map<string, string>; directories: Map<string, Directory> }
    const root: Directory = { files: new Map(), directories: new Map() };
    for (const [path, bytes] of files) {
      const parts = path.split("/"); const name = parts.pop(); if (name === undefined) refuse("store-path-refused"); let dir = root;
      for (const part of parts) { let child = dir.directories.get(part); if (child === undefined) { child = { files: new Map(), directories: new Map() }; dir.directories.set(part, child); } dir = child; }
      dir.files.set(name, this.#oid(["hash-object", "-w", "--stdin", "--no-filters"], bytes));
    }
    const make = (directory: Directory): string => {
      const records: string[] = [];
      for (const [name, child] of directory.directories) records.push(`040000 tree ${make(child)}\t${name}\0`);
      for (const [name, object] of directory.files) records.push(`100644 blob ${object}\t${name}\0`);
      return this.#oid(["mktree", "-z"], records.sort().join(""));
    }; return make(root);
  }
  cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult> { return this.#operation(() => this.#cas(expectedTip, cloneCandidate(candidate))); }
  async #cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult> {
    tip(expectedTip); if (expectedTip !== null && !OID.test(expectedTip)) refuse("lease-invalid"); await validateCandidate(this.#repositoryId, candidate);
    const before = await this.#read(); if (before.tip !== expectedTip) return { status: "conflict" }; await immutableBeforeWrite(before, candidate);
    const environment = this.#environment; if (environment === undefined) refuse("git-not-initialized");
    const seconds = Math.floor(Date.parse(candidate.metadata.timestamp) / 1000);
    Object.assign(environment, { GIT_AUTHOR_NAME: "PixelWatch", GIT_AUTHOR_EMAIL: "pixelwatch@example.invalid", GIT_COMMITTER_NAME: "PixelWatch", GIT_COMMITTER_EMAIL: "pixelwatch@example.invalid", GIT_AUTHOR_DATE: `${String(seconds)} +0000`, GIT_COMMITTER_DATE: `${String(seconds)} +0000` });
    const next = this.#oid(["commit-tree", this.#tree(candidate.files)], "PixelWatch store transaction\n");
    await this.#wait(this.#checkpoint?.({ point: "before-push", expectedTip, newTip: next })); this.#alive();
    let result: GitResult;
    try { result = this.#exec(["push", "--porcelain", `--force-with-lease=${this.#ref}:${expectedTip ?? ""}`, this.#remote, `${next}:${this.#ref}`], undefined, undefined, 64 * 1024); }
    catch { return { status: "unknown", attemptedTip: next }; } // Even a local post-push diagnostic cannot establish refusal at the remote.
    const outcome: CasResult = result.ok ? { status: "accepted", tip: next } : !result.interrupted && result.stdout.toString("utf8").includes("[rejected]") ? { status: "conflict" } : { status: "unknown", attemptedTip: next };
    try { await this.#wait(this.#checkpoint?.({ point: "after-push", expectedTip, newTip: next, result: outcome.status })); } catch { return { status: "unknown", attemptedTip: next }; }
    return outcome;
  }
  /** Terminal and idempotent: await this before removing an isolated test remote. */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    let completed!: () => void; let failed!: (error: unknown) => void;
    this.#closing = new Promise<void>((resolve, reject) => { completed = resolve; failed = reject; });
    this.#lifetime.abort();
    void guarded(async () => {
      await Promise.all([...this.#operations]);
      if (this.#root === undefined) return;
      const target = resolve(this.#root); const rel = relative(this.#temporaryParent, target);
      if (isAbsolute(rel) || !/^pixelwatch-store-client-[A-Za-z0-9_-]+$/.test(rel) || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) refuse("git-cleanup-refused");
      rmSync(target, { recursive: true, force: true }); this.#root = undefined; this.#gitDir = undefined; this.#hooks = undefined; this.#empty = undefined; this.#environment = undefined;
    }).then(completed, failed);
    return this.#closing;
  }
}

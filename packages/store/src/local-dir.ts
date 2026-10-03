import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, fstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { candidateDigest, cloneCandidate, identity, immutableBeforeWrite, listing, snapshot, tip, validateCandidate } from "./validate.ts";
import { guarded, refuse, STORE_LIMITS, StoreError, type CasResult, type StoreAdapter, type StoreCandidate, type StoreIdentity, type StoreSnapshot } from "./types.ts";

export interface LocalDirOptions extends StoreIdentity { readonly directory: string }
const POINTER = ".pixelwatch-tip";
const LOCK = ".pixelwatch-lock";
/** Local durable snapshots and atomic pointer publication. Old immutable snapshots remain readable. */
export class LocalDirStore implements StoreAdapter {
  readonly #root: string;
  readonly #repositoryId: string;
  constructor(options: LocalDirOptions) { identity(options); this.#repositoryId = options.repositoryId; this.#root = resolve(options.directory); }
  #assertDirectory(dir: string): void {
    const rel = relative(this.#root, dir); if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) refuse("local-path-refused");
    // Every existing ancestor is checked, including those above the selected root.
    for (let current = dir; ; current = dirname(current)) {
      if (existsSync(current)) { const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("local-link-refused"); }
      const parent = dirname(current); if (parent === current) break;
    }
    if (existsSync(dir) && realpathSync(dir).toLowerCase() !== resolve(dir).toLowerCase()) refuse("local-link-refused");
  }
  #readFile(path: string, maxBytes: number): Uint8Array {
    this.#assertDirectory(dirname(path)); const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) refuse("local-file-refused");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const after = fstatSync(fd);
      if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) refuse("local-file-changed");
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
  #current(): string | null {
    this.#assertDirectory(this.#root);
    if (!existsSync(this.#root)) return null;
    const entries = readdirSync(this.#root).sort();
    if (!entries.includes(POINTER)) {
      // A newly created root is empty, or only owns the lock acquired by this writer.
      if (entries.some((entry) => entry !== LOCK)) refuse("unmarked-store"); return null;
    }
    if (entries.some((entry) => entry !== POINTER && entry !== LOCK && entry !== "versions")) refuse("unmarked-store");
    const value = Buffer.from(this.#readFile(join(this.#root, POINTER), 65)).toString("ascii");
    if (!/^[0-9a-f]{64}$/.test(value)) refuse("local-tip-invalid");
    return value;
  }
  #files(version: string): { path: string; bytes: number }[] {
    this.#assertDirectory(version); const files: { path: string; bytes: number }[] = [];
    const visit = (dir: string, prefix: string) => {
      this.#assertDirectory(dir);
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name); const path = `${prefix}${name}`; const stat = lstatSync(full);
        if (stat.isSymbolicLink()) refuse("local-link-refused");
        if (stat.isDirectory()) {
          if (!/^(?:data|data\/v1|data\/v1\/runs|data\/v1\/runs\/(?:[1-9][0-9]{0,18}-a[1-9][0-9]{0,18}|import-[a-f0-9]{64})|blobs|blobs\/[a-f0-9]{2}|derived|derived\/[a-f0-9]{2})$/.test(path)) refuse("store-path-refused");
          visit(full, `${path}/`);
        } else {
          if (!stat.isFile() || stat.nlink !== 1) refuse("local-file-refused"); files.push({ path, bytes: stat.size });
          if (files.length > STORE_LIMITS.maxFiles) refuse("store-files-limit");
        }
      }
    };
    visit(version, ""); listing(files); return files;
  }
  read(): Promise<StoreSnapshot> { return guarded(() => this.#read()); }
  async #read(): Promise<StoreSnapshot> {
    const current = this.#current();
    if (current === null) return snapshot(this.#repositoryId, null, [], () => Promise.reject(new StoreError("store-file-missing")));
    const version = join(this.#root, "versions", current); const files = this.#files(version);
    return snapshot(this.#repositoryId, current, files, (path) => Promise.resolve(this.#readFile(join(version, ...path.split("/")), path.endsWith(".json") ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes)));
  }
  cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult> { return guarded(() => this.#cas(expectedTip, cloneCandidate(candidate))); }
  async #cas(expectedTip: string | null, candidate: StoreCandidate): Promise<CasResult> {
    tip(expectedTip); await validateCandidate(this.#repositoryId, candidate);
    // Refuse unrelated existing content before acquiring/writing a lock.
    this.#current(); this.#assertDirectory(this.#root); mkdirSync(this.#root, { recursive: true });
    const lock = join(this.#root, LOCK); let fd: number;
    try { fd = openSync(lock, "wx"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return refuse("local-lock-failed");
      const stat = lstatSync(lock); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse("local-link-refused"); return { status: "conflict" };
    }
    let staging: string | undefined;
    try {
      const before = await this.read(); if (before.tip !== expectedTip) return { status: "conflict" };
      await immutableBeforeWrite(before, candidate);
      const next = candidateDigest(candidate); const versions = join(this.#root, "versions"); this.#assertDirectory(versions); mkdirSync(versions, { recursive: true });
      const target = join(versions, next);
      staging = join(versions, `.pending-${next}`);
      if (existsSync(staging)) refuse("local-pending-exists");
      mkdirSync(staging);
      for (const [path, bytes] of candidate.files) {
        const full = join(staging, ...path.split("/")); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes, { flag: "wx", mode: 0o600 });
      }
      if (existsSync(target)) {
        const prior = await snapshot(this.#repositoryId, next, this.#files(target), (path) => Promise.resolve(this.#readFile(join(target, ...path.split("/")), path.endsWith(".json") ? STORE_LIMITS.maxJsonBytes : STORE_LIMITS.maxPngBytes)));
        if (prior.files.length !== candidate.files.size) refuse("local-version-conflict");
        for (const [path, bytes] of candidate.files) if (!Buffer.from(await prior.readFile(path)).equals(Buffer.from(bytes))) refuse("local-version-conflict");
      } else { renameSync(staging, target); staging = undefined; }
      const pointer = join(this.#root, `.pending-tip-${next}`);
      writeFileSync(pointer, next, { flag: "wx", mode: 0o600 }); renameSync(pointer, join(this.#root, POINTER));
      return { status: "accepted", tip: next };
    } finally {
      if (staging !== undefined) this.#removeStaging(staging);
      closeSync(fd); rmSync(lock);
    }
  }
  #removeStaging(path: string): void {
    const parent = resolve(this.#root, "versions"); const target = resolve(path); const rel = relative(parent, target);
    if (isAbsolute(rel) || rel.startsWith("..") || !/^\.pending-[a-f0-9]{64}$/.test(rel)) refuse("local-cleanup-refused");
    this.#assertDirectory(parent); if (lstatSync(target).isSymbolicLink()) refuse("local-cleanup-refused"); rmSync(target, { recursive: true, force: true });
  }
}

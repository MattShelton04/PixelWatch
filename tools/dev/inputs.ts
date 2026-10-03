// Local inputs for `pixelwatch-dev compare` (M1.8, ADR 0014). Input directories are hostile,
// exactly like artifacts (01 §4.3), and this is the only file that reads them:
//
// - Nothing is followed: a symbolic link or junction anywhere (the root included) is refused, and
//   every file is opened with O_NOFOLLOW where the platform has it, then checked with fstat to be
//   the same regular file, of the same size, that the scan saw.
// - Only a root and its direct children (and a part directory's direct children) are read, so
//   nothing outside the given roots is reached.
// - Phase 1 scans with lstat alone and enforces the 02 §5 count and size limits for every input
//   before phase 2 reads a single byte.
// - The layout is strict: anything that isn't a part is refused, never skipped.
//
// It does no validation of its own beyond that. A part directory is packed, file for file, into a
// stored ZIP, and every part goes through the same ingestArtifacts path as the publisher's
// artifacts: ZIP profile, names, bundle.json, identity, files and PNG decoding (M1.4, ADR 0008).
//
// Messages never echo an input-derived name: entries are named by position in name order, and
// only names that already match the 02 §6 artifact-name pattern are printed.
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { INGEST_LIMITS } from "../../packages/core/src/index.ts";
import {
  type Revision,
  compareCodePoints,
  formatArtifactName,
  parseArtifactName,
  parseDocument,
} from "../../packages/schemas/src/index.ts";
import { buildZip } from "../zip-corpus/zip-builder.ts";

export type InputErrorCode =
  | "input-not-found"
  | "input-unreadable"
  | "input-not-directory"
  | "input-link"
  | "input-special-file"
  | "input-nested-directory"
  | "input-extra-entry"
  | "input-wrong-side"
  | "input-too-many-entries"
  | "input-too-large"
  | "input-changed"
  | "input-bundle-invalid"
  | "input-no-parts"
  | "input-mixed-attempts"
  | "input-shard-conflict"
  | "input-unexpected-part"
  | "config-invalid";

/** A refused input. Messages are fixed text, numbers, `<base>`/`<head>`/`<config>` and validated part names. */
export class InputError extends Error {
  readonly code: InputErrorCode;

  constructor(code: InputErrorCode, message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

function fail(code: InputErrorCode, message: string): never {
  throw new InputError(code, message);
}

const BUNDLE = "bundle.json";
/** Entries listed per directory before giving up: the 02 §5 per-ingestion entry limit. */
const MAX_LISTED = INGEST_LIMITS.maxEntries;
/** Stored-ZIP overhead per entry: local header, central record and two copies of the name (≤ 255 bytes). */
const ZIP_ENTRY_OVERHEAD = 30 + 46 + 2 * 255;
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Lists a directory's names; tests substitute one that permutes the order. */
export type ListDir = (path: string, limit: number) => Promise<string[]>;

export const listDir: ListDir = async (path, limit) => {
  const names: string[] = [];
  const dir = await opendir(path);
  try {
    for await (const entry of dir) {
      names.push(entry.name);
      if (names.length > limit) break;
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  return names;
};

/** lstat identity, as bigints: Windows file IDs don't fit a double. */
interface Stat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}

interface ScannedFile extends Stat {
  /** Entry name inside the part (untrusted until the ingress checks it). */
  readonly name: string;
  readonly path: string;
  /** For messages: `<head>`, or `<head>, part <validated name>`, plus the entry position. */
  readonly where: string;
}

type ScannedPart =
  | { readonly kind: "zip"; readonly name: string; readonly file: ScannedFile }
  | {
      readonly kind: "dir";
      readonly revision: Revision;
      /** Undefined for a bare part directory: the name then comes from its bundle.json. */
      readonly name: string | undefined;
      readonly where: string;
      readonly files: readonly ScannedFile[];
    };

export interface SideSpec {
  readonly revision: Revision;
  /** The path the user gave. Never printed. */
  readonly root: string;
}

/** One part, ready for ingestArtifacts. `name` matches the 02 §6 artifact-name pattern. */
export interface LocalPart {
  readonly name: string;
  readonly zip: Uint8Array;
}

function fsError(error: unknown, where: string): never {
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ENOTDIR") fail("input-not-found", `${where} doesn't exist`);
  if (code === "ELOOP") fail("input-link", `${where} is a symbolic link; links are never followed`);
  fail("input-unreadable", `${where} can't be read (${typeof code === "string" && /^E[A-Z]{1,20}$/.test(code) ? code : "unknown error"})`);
}

async function statOf(path: string, where: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    return fsError(error, where);
  }
}

async function names(path: string, where: string, list: ListDir): Promise<string[]> {
  let listed: string[];
  try {
    listed = await list(path, MAX_LISTED);
  } catch (error) {
    return fsError(error, where);
  }
  if (listed.length > MAX_LISTED) fail("input-too-many-entries", `${where} has more than ${String(MAX_LISTED)} entries`);
  return listed.sort(compareCodePoints);
}

function entryAt(where: string, index: number): string {
  return `${where}, entry ${String(index + 1)} in name order`;
}

/** lstat of a direct child: never a link, never anything but a file or directory. */
async function childStat(path: string, where: string) {
  const st = await statOf(path, where);
  if (st.isSymbolicLink()) fail("input-link", `${where} is a symbolic link or junction; links are never followed`);
  if (!st.isFile() && !st.isDirectory()) fail("input-special-file", `${where} is neither a regular file nor a directory`);
  // A second hard link can be a file outside the root under a name inside it.
  if (st.isFile() && st.nlink > 1n) fail("input-link", `${where} has more than one hard link; linked files are never read`);
  return st;
}

function capFor(name: string): bigint {
  return BigInt(name === BUNDLE ? INGEST_LIMITS.maxJsonBytes : INGEST_LIMITS.maxPngBytes);
}

/** A part directory: regular files only, each within its 02 §5 size limit. */
async function scanPartDir(path: string, where: string, list: ListDir): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  for (const [index, name] of (await names(path, where, list)).entries()) {
    const at = entryAt(where, index);
    const child = join(path, name);
    const st = await childStat(child, at);
    if (st.isDirectory()) fail("input-nested-directory", `${at} is a directory; a part holds only bundle.json and its PNGs`);
    if (st.size > capFor(name)) fail("input-too-large", `${at} is ${String(st.size)} bytes; the limit for it is ${String(capFor(name))}`);
    files.push({ name, path: child, where: at, dev: st.dev, ino: st.ino, size: st.size });
  }
  if (packedSize(files) > BigInt(INGEST_LIMITS.maxArchiveBytes)) fail("input-too-large", `${where} packs to more than ${String(INGEST_LIMITS.maxArchiveBytes)} bytes`);
  return files;
}

/** A side root: one part directory (it holds bundle.json), or a directory of named parts. */
async function scanSide(side: SideSpec, list: ListDir): Promise<ScannedPart[]> {
  const where = `<${side.revision}>`;
  const st = await statOf(side.root, where);
  if (st.isSymbolicLink()) fail("input-link", `${where} is a symbolic link or junction; links are never followed`);
  if (!st.isDirectory()) fail("input-not-directory", `${where} must be a directory`);
  const listed = await names(side.root, where, list);
  if (listed.includes(BUNDLE)) return [{ kind: "dir", revision: side.revision, name: undefined, where, files: await scanPartDir(side.root, where, list) }];

  const parts: ScannedPart[] = [];
  for (const [index, name] of listed.entries()) {
    const at = entryAt(where, index);
    const child = join(side.root, name);
    const cst = await childStat(child, at);
    const artifactName = cst.isDirectory() ? name : name.endsWith(".zip") ? name.slice(0, -4) : "";
    const identity = parseArtifactName(artifactName);
    if (identity === undefined) {
      fail("input-extra-entry", `${at} is not a part: expected <artifact name>/, <artifact name>.zip or a bundle.json`);
    }
    // From here on the name matches the artifact-name pattern, so it may be printed.
    if (identity.revision !== side.revision) fail("input-wrong-side", `part ${artifactName} is a ${identity.revision} part inside ${where}`);
    if (cst.isDirectory()) {
      parts.push({ kind: "dir", revision: side.revision, name: artifactName, where: `${where}, part ${artifactName}`, files: await scanPartDir(child, `${where}, part ${artifactName}`, list) });
    } else {
      if (cst.size > BigInt(INGEST_LIMITS.maxArchiveBytes)) fail("input-too-large", `part ${artifactName}.zip is ${String(cst.size)} bytes; the limit is ${String(INGEST_LIMITS.maxArchiveBytes)}`);
      parts.push({ kind: "zip", name: artifactName, file: { name, path: child, where: `part ${artifactName}.zip`, dev: cst.dev, ino: cst.ino, size: cst.size } });
    }
  }
  return parts;
}

/** An upper bound on a part directory's stored ZIP: its files plus per-entry headers and the end record. */
function packedSize(files: readonly ScannedFile[]): bigint {
  return files.reduce((sum, f) => sum + f.size + BigInt(ZIP_ENTRY_OVERHEAD), 22n);
}

function bytesOf(part: ScannedPart): bigint {
  return part.kind === "zip" ? part.file.size : packedSize(part.files);
}

/** Phase 1: lstat only. Every 02 §5 count and size limit holds before any byte is read. */
async function scanAll(sides: readonly SideSpec[], list: ListDir): Promise<ScannedPart[]> {
  const parts: ScannedPart[] = [];
  for (const side of sides) parts.push(...(await scanSide(side, list)));
  if (parts.length === 0) fail("input-no-parts", "the inputs hold no parts");
  if (parts.length > INGEST_LIMITS.maxArtifacts) fail("input-too-many-entries", `more than ${String(INGEST_LIMITS.maxArtifacts)} parts`);
  const entries = parts.reduce((sum, p) => sum + (p.kind === "dir" ? p.files.length : 0), 0);
  if (entries > INGEST_LIMITS.maxEntries) fail("input-too-many-entries", `the part directories hold more than ${String(INGEST_LIMITS.maxEntries)} files`);
  const total = parts.reduce((sum, p) => sum + bytesOf(p), 0n);
  if (total > BigInt(INGEST_LIMITS.maxCompressedBytes)) fail("input-too-large", `the inputs total more than ${String(INGEST_LIMITS.maxCompressedBytes)} bytes`);
  return parts;
}

async function readAll(handle: FileHandle, expected: Stat, where: string): Promise<Uint8Array> {
  const st = await handle.stat({ bigint: true });
  if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino || st.size !== expected.size) {
    fail("input-changed", `${where} changed between scanning and reading`);
  }
  const out = new Uint8Array(Number(expected.size));
  let at = 0;
  while (at < out.byteLength) {
    const { bytesRead } = await handle.read(out, at, out.byteLength - at, at);
    if (bytesRead === 0) fail("input-changed", `${where} shrank while it was read`);
    at += bytesRead;
  }
  const { bytesRead } = await handle.read(new Uint8Array(1), 0, 1, at);
  if (bytesRead !== 0) fail("input-changed", `${where} grew while it was read`);
  return out;
}

/** Phase 2: one file, opened without following links and held to the size the scan saw. */
export async function readScanned(path: string, expected: Stat, where: string): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return fsError(error, where);
  }
  try {
    return await readAll(handle, expected, where);
  } finally {
    await handle.close();
  }
}

/**
 * The artifact name of a bare part directory (a side root holding bundle.json): the side's
 * revision plus the attempt, provider and shard its bundle.json states, read with the same strict
 * parser the ingress uses. The ingress still checks that identity against the name.
 */
function nameFromBundle(bytes: Uint8Array, revision: Revision, where: string): string {
  const parsed = parseDocument("bundle", bytes);
  if (!parsed.ok) fail("input-bundle-invalid", `${where}: bundle.json is invalid (${parsed.issue.code.replace(/[^a-z0-9-]/g, "?")})`);
  const { attempt, providerId, shard } = parsed.value;
  return formatArtifactName({ attempt, revision, providerId, shard });
}

function packDir(files: readonly ScannedFile[], contents: ReadonlyMap<string, Uint8Array>): Uint8Array {
  // bundle.json first, then the rest in name order: the same bytes whatever the listing order.
  const ordered = [...files].sort((a, b) => (a.name === BUNDLE ? -1 : b.name === BUNDLE ? 1 : compareCodePoints(a.name, b.name)));
  return buildZip({
    entries: ordered.map((f) => ({ name: Buffer.from(f.name, "utf8"), data: contents.get(f.path) ?? new Uint8Array(0), method: 0, descriptor: false })),
  });
}

/** Scans every side, then reads and packs each part. Parts come back sorted by name. */
export async function readInputs(sides: readonly SideSpec[], list: ListDir = listDir): Promise<LocalPart[]> {
  const scanned = await scanAll(sides, list);
  const parts: LocalPart[] = [];
  for (const [i, part] of scanned.entries()) {
    if (part.kind === "zip") {
      parts.push({ name: part.name, zip: await readScanned(part.file.path, part.file, part.file.where) });
      continue;
    }
    const contents = new Map<string, Uint8Array>();
    for (const file of part.files) contents.set(file.path, await readScanned(file.path, file, file.where));
    let name = part.name;
    if (name === undefined) {
      const bundle = part.files.find((f) => f.name === BUNDLE);
      if (bundle === undefined) throw new Error(`scanned part ${String(i)} lost its bundle.json`);
      name = nameFromBundle(contents.get(bundle.path) ?? new Uint8Array(0), part.revision, part.where);
    }
    parts.push({ name, zip: packDir(part.files, contents) });
  }
  return parts.sort((a, b) => compareCodePoints(a.name, b.name));
}

/** The adopter's config.json, read like any other hostile file (≤ 1 MiB, no links). */
export async function readConfigBytes(path: string): Promise<Uint8Array> {
  const where = "<config>";
  const st = await statOf(path, where);
  if (st.isSymbolicLink()) fail("input-link", `${where} is a symbolic link or junction; links are never followed`);
  if (!st.isFile()) fail("input-special-file", `${where} must be a regular file`);
  if (st.size > BigInt(INGEST_LIMITS.maxJsonBytes)) fail("input-too-large", `${where} is ${String(st.size)} bytes; the limit is ${String(INGEST_LIMITS.maxJsonBytes)}`);
  return readScanned(path, st, where);
}

// Trusted ZIP reader for capture artifacts (02 §5; ADR 0008; threat-model R4.3-08, R4.3-10).
// Part of the trusted computing base: our own code on node:zlib, no third-party reader.
//
// The accepted profile is the layout GitHub's upload-artifact writes, and nothing looser:
// single disk; stored or deflate; no encryption, ZIP64, extra fields, comments, links or
// special files; flat ASCII names from a two-pattern allowlist (`bundle.json`, `<viewId>.<variantId>.png`); entries contiguous from offset 0
// up to the central directory, which the end record immediately follows. Data descriptors
// (general-purpose bit 3) are accepted because upload-artifact sets them on every entry. Data is
// always located by the central record's compressed size, never by scanning for a descriptor,
// and the descriptor must be the signed 16-byte form that repeats the central CRC and sizes.
//
// `openZip` checks the structure, names and layout without inflating anything, and charges every
// entry's declared size to the shared per-ingestion budget. `readEntry` then inflates one entry
// into a buffer of exactly that size (each capped at 1 MiB for bundle.json, 32 MiB for a PNG) and
// refuses it the moment inflation passes the declared size, ends short, leaves trailing data or
// fails its CRC. A lying header therefore can't hide expansion: the budget counts the declared
// sizes, and inflation is held to them.
//
// No worker: parsing is linear in the entry count (≤ 4096), inflation is async and stops between
// pieces when the signal aborts, and memory is bounded by construction (ADR 0008).
import { crc32, createInflateRaw } from "node:zlib";
import { UNIT_FILE_PATTERN } from "@pixelwatch/schemas";
import { IngressError, type IngressErrorCode } from "./errors.ts";
import { INGEST_LIMITS, type IngestBudget } from "./limits.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const DESCRIPTOR_SIZE = 16;

/** Encryption: traditional (0), strong (6), encrypted central directory (13). */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;
/** Deflate options (1, 2), data descriptor (3), UTF-8 names (11). Anything else is refused. */
const ALLOWED_FLAGS = 0x0002 | 0x0004 | 0x0008 | 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const METHOD_AES = 99;
/** 2.0: deflate. ZIP64 needs 4.5, AES 5.1. */
const MAX_VERSION_NEEDED = 20;
const HOST_DOS = 0;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** MS-DOS attributes: volume label (0x08), directory (0x10). */
const DOS_SPECIAL = 0x08 | 0x10;

/** Inflate output piece size. A bomb is stopped at most one piece past its limit. */
const INFLATE_CHUNK = 64 * 1024;

const BUNDLE_NAME = "bundle.json";

export interface ZipEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  /** Declared uncompressed size; readEntry holds inflation to exactly this. */
  readonly size: number;
  /** Offset of the entry's compressed data in the archive. */
  readonly dataOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  /** In archive order. */
  readonly entries: readonly ZipEntry[];
}

export interface ZipOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ExtractOptions {
  /** Allocates the entry buffer. Defaults to `new Uint8Array(n)`; tests use it to observe allocation. */
  readonly allocate?: (bytes: number) => Uint8Array;
  readonly signal?: AbortSignal | undefined;
}

export interface CentralRecord {
  readonly index: number;
  readonly nameBytes: Uint8Array;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export interface CentralDirectory {
  readonly records: readonly CentralRecord[];
  readonly offset: number;
}

function fail(code: IngressErrorCode, detail: string): never {
  throw new IngressError(code, detail);
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) fail("ingest-aborted", "ingestion cancelled");
}

class Reader {
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(at: number): number {
    return this.view.getUint16(at, true);
  }

  u32(at: number): number {
    return this.view.getUint32(at, true);
  }
}

/**
 * Stage 1: the end record and the central directory. Checks framing, ZIP64, disks, the entry
 * count (drawn from the shared budget before any record is parsed) and every central record.
 */
export function readCentralDirectory(bytes: Uint8Array, budget: IngestBudget): CentralDirectory {
  if (bytes.byteLength > INGEST_LIMITS.maxArchiveBytes) {
    fail("zip-archive-too-large", `archive is ${String(bytes.byteLength)} bytes; the limit is ${String(INGEST_LIMITS.maxArchiveBytes)}`);
  }
  const length = bytes.byteLength;
  if (length < EOCD_SIZE) fail("zip-eocd", "no end-of-central-directory record");
  const r = new Reader(bytes);
  let eocd = -1;
  for (let at = length - EOCD_SIZE; at >= Math.max(0, length - EOCD_SIZE - 0xffff); at--) {
    if (r.u32(at) === SIG_EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) fail("zip-eocd", "no end-of-central-directory record");
  if (r.u16(eocd + 20) !== 0) fail("zip-comment", "the archive has a comment");
  if (eocd + EOCD_SIZE !== length) fail("zip-trailing-bytes", `${String(length - eocd - EOCD_SIZE)} bytes after the end-of-central-directory record`);

  const disk = r.u16(eocd + 4);
  const centralDisk = r.u16(eocd + 6);
  const entriesOnDisk = r.u16(eocd + 8);
  const total = r.u16(eocd + 10);
  const centralSize = r.u32(eocd + 12);
  const offset = r.u32(eocd + 16);
  if (eocd >= 20 && r.u32(eocd - 20) === SIG_ZIP64_LOCATOR) fail("zip64", "ZIP64 end-of-central-directory locator");
  if ([disk, centralDisk, entriesOnDisk, total].includes(0xffff) || centralSize === 0xffffffff || offset === 0xffffffff) {
    fail("zip64", "ZIP64 sentinel in the end-of-central-directory record");
  }
  const centralEnd = offset + centralSize;
  if (centralEnd + 4 <= eocd && r.u32(centralEnd) === SIG_ZIP64_EOCD) fail("zip64", "ZIP64 end-of-central-directory record");
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== total) fail("zip-multi-disk", "the archive spans more than one disk");
  budget.addEntries(total);
  if (centralEnd !== eocd) fail("zip-central-directory", "the central directory doesn't end where the end record begins");

  const records: CentralRecord[] = [];
  let p = offset;
  for (let index = 0; index < total; index++) {
    if (p + CENTRAL_SIZE > eocd || r.u32(p) !== SIG_CENTRAL) fail("zip-central-directory", `central record ${String(index)} is missing or truncated`);
    const nameLength = r.u16(p + 28);
    const extraLength = r.u16(p + 30);
    const commentLength = r.u16(p + 32);
    const end = p + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (end > eocd) fail("zip-central-directory", `central record ${String(index)} runs past the central directory`);
    const nameBytes = bytes.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLength);
    const extra = bytes.subarray(p + CENTRAL_SIZE + nameLength, p + CENTRAL_SIZE + nameLength + extraLength);
    records.push(
      checkRecord(index, nameBytes, extra, {
        madeBy: r.u16(p + 4),
        versionNeeded: r.u16(p + 6),
        flags: r.u16(p + 8),
        method: r.u16(p + 10),
        crc32: r.u32(p + 16),
        compressedSize: r.u32(p + 20),
        size: r.u32(p + 24),
        commentLength,
        diskStart: r.u16(p + 34),
        externalAttrs: r.u32(p + 38),
        localOffset: r.u32(p + 42),
      }),
    );
    p = end;
  }
  if (p !== eocd) fail("zip-central-directory", "the central directory holds more than the declared records");
  return { records, offset };
}

interface RawRecord {
  madeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  commentLength: number;
  diskStart: number;
  externalAttrs: number;
  localOffset: number;
}

function isBundleName(nameBytes: Uint8Array): boolean {
  return nameBytes.byteLength === BUNDLE_NAME.length && Buffer.from(nameBytes).toString("latin1") === BUNDLE_NAME;
}

function checkRecord(index: number, nameBytes: Uint8Array, extra: Uint8Array, raw: RawRecord): CentralRecord {
  const at = `entry ${String(index)}`;
  if ((raw.flags & ENCRYPTION_FLAGS) !== 0 || raw.method === METHOD_AES) fail("zip-encrypted", `${at} is encrypted`);
  if (raw.compressedSize === 0xffffffff || raw.size === 0xffffffff || raw.localOffset === 0xffffffff || raw.diskStart === 0xffff) {
    fail("zip64", `${at} has a ZIP64 sentinel`);
  }
  if (extra.byteLength > 0) {
    const r = new Reader(extra);
    for (let p = 0; p + 4 <= extra.byteLength; p += 4 + r.u16(p + 2)) {
      if (r.u16(p) === 0x0001) fail("zip64", `${at} has a ZIP64 extra field`);
    }
    fail("zip-extra-field", `${at} has an extra field`);
  }
  if (raw.method !== 0 && raw.method !== 8) fail("zip-method", `${at} uses compression method ${String(raw.method)}; only stored (0) and deflate (8) are accepted`);
  if ((raw.flags & ~ALLOWED_FLAGS) !== 0) fail("zip-flags", `${at} has unsupported general-purpose flags 0x${raw.flags.toString(16)}`);
  if ((raw.versionNeeded & 0xff) > MAX_VERSION_NEEDED) fail("zip-version", `${at} needs ZIP version ${String(raw.versionNeeded & 0xff)}; at most 20 is accepted`);
  if (raw.commentLength !== 0) fail("zip-comment", `${at} has a comment`);
  if (raw.diskStart !== 0) fail("zip-multi-disk", `${at} starts on another disk`);
  const host = raw.madeBy >>> 8;
  if (host !== HOST_DOS && host !== HOST_UNIX) fail("zip-host", `${at} was made by host ${String(host)}; only MS-DOS (0) and Unix (3) attributes are interpreted`);
  if (host === HOST_UNIX) {
    const type = (raw.externalAttrs >>> 16) & S_IFMT;
    if (type === S_IFLNK) fail("zip-link", `${at} is a symbolic link`);
    if (type !== 0 && type !== S_IFREG) fail("zip-special-file", `${at} is not a regular file (mode type 0o${type.toString(8)})`);
  }
  if ((raw.externalAttrs & DOS_SPECIAL) !== 0) fail("zip-special-file", `${at} is a directory or volume label`);
  const cap = isBundleName(nameBytes) ? INGEST_LIMITS.maxJsonBytes : INGEST_LIMITS.maxPngBytes;
  if (raw.size > cap) fail("zip-entry-too-large", `${at} declares ${String(raw.size)} bytes; the limit for it is ${String(cap)}`);
  if (raw.method === 0 && raw.compressedSize !== raw.size) fail("zip-size-mismatch", `${at} is stored but its compressed and uncompressed sizes differ`);
  return {
    index,
    nameBytes,
    versionNeeded: raw.versionNeeded,
    flags: raw.flags,
    method: raw.method === 0 ? 0 : 8,
    crc32: raw.crc32,
    compressedSize: raw.compressedSize,
    size: raw.size,
    localOffset: raw.localOffset,
  };
}

/**
 * Stage 2: entry names. Each name must be flat ASCII without NUL, drive, separator or dot path;
 * the set must have no duplicates or ASCII case-fold collisions; and every name must be exactly
 * `bundle.json` or `<viewId>.<variantId>.png`, with one `bundle.json`. Messages carry indices, never names.
 */
export function checkEntryNames(records: readonly CentralRecord[]): string[] {
  const names = records.map((record) => {
    const at = `entry ${String(record.index)}`;
    const b = record.nameBytes;
    if (b.byteLength === 0) fail("zip-name-empty", `${at} has an empty name`);
    if (b.some((c) => c >= 0x80)) fail("zip-name-encoding", `${at} has a non-ASCII name`);
    const name = Buffer.from(b).toString("latin1");
    if (name.includes("\0")) fail("zip-name-nul", `${at} has a NUL in its name`);
    if (name.startsWith("/") || name.startsWith("\\")) fail("zip-name-absolute", `${at} has an absolute path`);
    if (/^[A-Za-z]:/.test(name)) fail("zip-name-drive", `${at} has a drive prefix`);
    if (name === "." || name === "..") fail("zip-name-dot", `${at} is a dot path`);
    const segments = name.split(/[\\/]/);
    if (segments.includes("..")) fail("zip-name-traversal", `${at} has a parent-directory segment`);
    if (segments.length > 1) fail("zip-name-separator", `${at} has a path separator`);
    return name;
  });
  const exact = new Map<string, number>();
  const folded = new Map<string, number>();
  names.forEach((name, i) => {
    const first = exact.get(name);
    if (first !== undefined) fail("zip-duplicate-name", `entries ${String(first)} and ${String(i)} have the same name`);
    exact.set(name, i);
    const key = name.toLowerCase();
    const collides = folded.get(key);
    if (collides !== undefined) fail("zip-name-collision", `entries ${String(collides)} and ${String(i)} differ only in letter case`);
    folded.set(key, i);
  });
  names.forEach((name, i) => {
    if (name !== BUNDLE_NAME && !UNIT_FILE_PATTERN.test(name)) fail("zip-name-not-allowed", `entry ${String(i)} is neither bundle.json nor a unit PNG name`);
  });
  if (!exact.has(BUNDLE_NAME)) fail("zip-bundle-missing", "the archive has no bundle.json");
  return names;
}

/**
 * Stage 3: local headers and layout. Walks the entries in offset order: each local header must
 * repeat its central record, a descriptor must follow the data when bit 3 is set, and entries
 * must tile the bytes from offset 0 to the central directory with no gap or overlap.
 */
export function checkLayout(bytes: Uint8Array, directory: CentralDirectory, names: readonly string[]): ZipEntry[] {
  const r = new Reader(bytes);
  const limit = directory.offset;
  const order = [...directory.records].sort((a, b) => a.localOffset - b.localOffset || a.index - b.index);
  const entries: ZipEntry[] = [];
  let expected = 0;
  for (const record of order) {
    const at = `entry ${String(record.index)}`;
    const offset = record.localOffset;
    if (offset + LOCAL_SIZE > limit) fail("zip-out-of-range", `${at}'s local header lies outside the entry area`);
    if (offset < expected) fail("zip-overlap", `${at} overlaps the previous entry`);
    if (offset > expected) fail(expected === 0 ? "zip-leading-bytes" : "zip-gap", `${String(offset - expected)} unreferenced bytes before ${at}`);
    if (r.u32(offset) !== SIG_LOCAL) fail("zip-header-mismatch", `${at} has no local header`);
    if (r.u16(offset + 4) !== record.versionNeeded || r.u16(offset + 6) !== record.flags || r.u16(offset + 8) !== record.method) {
      fail("zip-header-mismatch", `${at}'s local header disagrees with its central record (version, flags or method)`);
    }
    const nameLength = r.u16(offset + 26);
    const extraLength = r.u16(offset + 28);
    const dataOffset = offset + LOCAL_SIZE + nameLength;
    if (dataOffset > limit) fail("zip-out-of-range", `${at}'s local name lies outside the entry area`);
    if (!Buffer.from(bytes.subarray(offset + LOCAL_SIZE, dataOffset)).equals(record.nameBytes)) {
      fail("zip-header-mismatch", `${at}'s local name disagrees with its central record`);
    }
    if (extraLength !== 0) fail("zip-extra-field", `${at}'s local header has an extra field`);
    const crc = r.u32(offset + 14);
    const compressedSize = r.u32(offset + 18);
    const size = r.u32(offset + 22);
    const descriptor = (record.flags & FLAG_DESCRIPTOR) !== 0;
    const agrees = (local: number, central: number) => local === central || (descriptor && local === 0);
    if (!agrees(crc, record.crc32) || !agrees(compressedSize, record.compressedSize) || !agrees(size, record.size)) {
      fail("zip-header-mismatch", `${at}'s local CRC or sizes disagree with its central record`);
    }
    const dataEnd = dataOffset + record.compressedSize;
    if (dataEnd > limit) fail("zip-out-of-range", `${at}'s data runs past the entry area`);
    let end = dataEnd;
    if (descriptor) {
      if (dataEnd + DESCRIPTOR_SIZE > limit) fail("zip-data-descriptor", `${at} has no room for its data descriptor`);
      if (
        r.u32(dataEnd) !== SIG_DESCRIPTOR ||
        r.u32(dataEnd + 4) !== record.crc32 ||
        r.u32(dataEnd + 8) !== record.compressedSize ||
        r.u32(dataEnd + 12) !== record.size
      ) {
        fail("zip-data-descriptor", `${at}'s data descriptor is missing, unsigned, or disagrees with its central record`);
      }
      end += DESCRIPTOR_SIZE;
    }
    entries.push({
      name: names[record.index] ?? "",
      method: record.method,
      crc32: record.crc32,
      compressedSize: record.compressedSize,
      size: record.size,
      dataOffset,
    });
    expected = end;
  }
  if (expected !== limit) fail("zip-gap", `${String(limit - expected)} unreferenced bytes before the central directory`);
  return entries;
}

interface InflateOptions {
  readonly sink: (piece: Uint8Array) => void;
  readonly signal?: AbortSignal | undefined;
}

function zlibError(error: unknown): IngressError {
  const code = (error as { code?: unknown }).code;
  if (code === "Z_BUF_ERROR") return new IngressError("zip-deflate-truncated", "deflate stream ends before its final block");
  return new IngressError("zip-deflate", `invalid deflate data (${typeof code === "string" && /^Z_[A-Z_]{1,20}$/.test(code) ? code : "unknown"})`);
}

/** Inflates one entry, enforcing its declared size, the CRC and a clean stream end. */
function inflateEntry(bytes: Uint8Array, entry: ZipEntry, options: InflateOptions): Promise<void> {
  const { sink, signal } = options;
  const raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    checkSignal(signal);
    if (crc32(raw) !== entry.crc32) fail("zip-crc", "stored entry fails its CRC-32");
    sink(raw);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw({ chunkSize: INFLATE_CHUNK });
    let produced = 0;
    let crc = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
        return;
      }
      inflate.destroy();
      reject(error instanceof IngressError ? error : zlibError(error));
    };
    const onAbort = () => {
      finish(new IngressError("ingest-aborted", "ingestion cancelled"));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    inflate.on("data", (piece: Buffer) => {
      if (settled) return;
      if (piece.byteLength > entry.size - produced) {
        finish(new IngressError("zip-inflate-overflow", `entry inflates past the ${String(entry.size)} bytes its header declares`));
        return;
      }
      produced += piece.byteLength;
      crc = crc32(piece, crc);
      sink(piece);
    });
    inflate.on("error", finish);
    inflate.on("end", () => {
      if (produced < entry.size) {
        finish(new IngressError("zip-inflate-short", `entry inflates to ${String(produced)} of the ${String(entry.size)} bytes its header declares`));
      } else if (inflate.bytesWritten !== raw.byteLength) {
        // node:zlib silently ignores input after the stream end; the profile doesn't.
        finish(new IngressError("zip-deflate-trailing", `${String(raw.byteLength - inflate.bytesWritten)} bytes after the deflate stream end`));
      } else if (crc !== entry.crc32) {
        finish(new IngressError("zip-crc", "entry fails its CRC-32"));
      } else {
        finish();
      }
    });
    inflate.end(raw);
  });
}

/** Validates the archive's structure, names and layout, and charges its declared sizes to the budget. */
export function openZip(bytes: Uint8Array, budget: IngestBudget, options: ZipOptions = {}): ZipArchive {
  checkSignal(options.signal);
  const directory = readCentralDirectory(bytes, budget);
  const names = checkEntryNames(directory.records);
  const entries = checkLayout(bytes, directory, names);
  budget.addExpanded(entries.reduce((sum, e) => sum + e.size, 0));
  return { bytes, entries };
}

/** Extracts one entry of an opened archive, holding it to its declared size and CRC. */
export async function readEntry(archive: ZipArchive, name: string, options: ExtractOptions = {}): Promise<Uint8Array> {
  const entry = archive.entries.find((e) => e.name === name);
  if (entry === undefined) fail("zip-entry-missing", "the archive has no such entry");
  const out = (options.allocate ?? ((n: number) => new Uint8Array(n)))(entry.size);
  let at = 0;
  await inflateEntry(archive.bytes, entry, {
    signal: options.signal,
    sink: (piece) => {
      out.set(piece, at);
      at += piece.byteLength;
    },
  });
  return out;
}

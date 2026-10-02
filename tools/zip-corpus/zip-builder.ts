// Test-side ZIP building blocks for the hostile corpus, the ingress tests, the reference check
// and the bench (M1.4). Deliberately naive and written separately from
// packages/core/src/ingest/zip.ts: a test that shares its writer with the reader under test can
// hide shared bugs (07 §2). Never import this from packages/*/src.
//
// By default it writes the layout GitHub's upload-artifact v4 produces (ADR 0008): deflate,
// general-purpose bit 3 with a signed 16-byte data descriptor and zero CRC/sizes in the local
// header, version needed 20, made by 0x032D (Unix), external attributes 0x81A40020 (regular file
// 0644 plus the DOS archive bit), no extra fields, no comments, entries contiguous in
// central-directory order. Every field can be overridden to build a hostile archive.
import { crc32, deflateRawSync } from "node:zlib";

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  u16(value: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value & 0xffff, true);
    return this.bytes(b);
  }

  u32(value: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    return this.bytes(b);
  }

  bytes(b: Uint8Array): this {
    this.parts.push(b);
    this.length += b.byteLength;
    return this;
  }

  done(): Uint8Array {
    return concat(this.parts);
  }
}

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_DESCRIPTOR = 0x08074b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

/** upload-artifact v4's values (ADR 0008). */
export const GITHUB_MADE_BY = 0x032d;
export const GITHUB_EXTERNAL_ATTRS = 0x81a40020;
const DOS_TIME = 0x5d3c;
const DOS_DATE = 0x5b41;

export interface EntrySpec {
  /** Entry name, or raw name bytes. */
  name: string | Uint8Array;
  /** Uncompressed content. */
  data: Uint8Array;
  /** 0 (stored) or 8 (deflate, the default). Other values are written as given. */
  method?: number;
  /** Replaces the compressed bytes (the CRC and sizes still describe `data`). */
  compressed?: Uint8Array;
  /** Data descriptor form: signed 16 bytes (true, the default), none (false), unsigned 12 bytes or ZIP64 24 bytes. */
  descriptor?: boolean | "unsigned" | "zip64";
  /** General-purpose flags in both headers. Bit 3 is added when a descriptor is written. */
  flags?: number;
  localFlags?: number;
  versionNeeded?: number;
  localVersionNeeded?: number;
  versionMadeBy?: number;
  externalAttrs?: number;
  /** Overrides of the central (and, unless overridden there, local and descriptor) fields. */
  crc?: number;
  compressedSize?: number;
  size?: number;
  localMethod?: number;
  localName?: Uint8Array;
  /** Local CRC/sizes; default 0 with a descriptor, else the central values. */
  localCrc?: number;
  localCompressedSize?: number;
  localSize?: number;
  descriptorCrc?: number;
  extra?: Uint8Array;
  localExtra?: Uint8Array;
  comment?: Uint8Array;
  diskStart?: number;
  /** Absolute local-header offset written in the central record (default: where it was written). */
  centralOffset?: number;
  /** Central offset relative to another entry's local header, for overlapping entries. */
  centralOffsetFrom?: { entry: number; plus: number };
}

export interface ArchiveSpec {
  entries: EntrySpec[];
  /** Bytes before the first local header (a self-extractor stub or polyglot prefix). */
  prefix?: Uint8Array;
  /** Bytes written after entry i's data (and descriptor). */
  gapAfter?: ReadonlyMap<number, Uint8Array>;
  /** Bytes between the last entry and the central directory (counted in the CD offset). */
  beforeCentral?: Uint8Array;
  /** A ZIP64 end-of-central-directory record and locator before the EOCD. */
  zip64Record?: boolean;
  zip64Locator?: boolean;
  /** EOCD field overrides. */
  eocd?: { disk?: number; centralDisk?: number; entriesOnDisk?: number; totalEntries?: number; centralSize?: number; centralOffset?: number };
  comment?: Uint8Array;
  /** Bytes after the EOCD record. */
  trailing?: Uint8Array;
}

export function extraField(id: number, data: Uint8Array): Uint8Array {
  return new Writer().u16(id).u16(data.byteLength).bytes(data).done();
}

interface Written {
  spec: EntrySpec;
  name: Uint8Array;
  offset: number;
  crc: number;
  compressedSize: number;
  size: number;
  flags: number;
  method: number;
}

export function buildZip(spec: ArchiveSpec): Uint8Array {
  const out = new Writer();
  if (spec.prefix !== undefined) out.bytes(spec.prefix);
  const written: Written[] = [];

  spec.entries.forEach((entry, i) => {
    const name = typeof entry.name === "string" ? ascii(entry.name) : entry.name;
    const method = entry.method ?? 8;
    const compressed = entry.compressed ?? (method === 8 ? deflateRawSync(entry.data) : entry.data);
    const descriptor = entry.descriptor ?? true;
    const flags = (entry.flags ?? 0) | (descriptor === false ? 0 : 0x08);
    const crc = entry.crc ?? crc32(entry.data);
    const compressedSize = entry.compressedSize ?? compressed.byteLength;
    const size = entry.size ?? entry.data.byteLength;
    const offset = out.length;
    const localExtra = entry.localExtra ?? entry.extra ?? new Uint8Array(0);
    const localName = entry.localName ?? name;
    out
      .u32(SIG_LOCAL)
      .u16(entry.localVersionNeeded ?? entry.versionNeeded ?? 20)
      .u16(entry.localFlags ?? flags)
      .u16(entry.localMethod ?? method)
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(entry.localCrc ?? (descriptor === false ? crc : 0))
      .u32(entry.localCompressedSize ?? (descriptor === false ? compressedSize : 0))
      .u32(entry.localSize ?? (descriptor === false ? size : 0))
      .u16(localName.byteLength)
      .u16(localExtra.byteLength)
      .bytes(localName)
      .bytes(localExtra)
      .bytes(compressed);
    const descriptorCrc = entry.descriptorCrc ?? crc;
    if (descriptor === true) out.u32(SIG_DESCRIPTOR).u32(descriptorCrc).u32(compressedSize).u32(size);
    else if (descriptor === "unsigned") out.u32(descriptorCrc).u32(compressedSize).u32(size);
    else if (descriptor === "zip64") out.u32(SIG_DESCRIPTOR).u32(descriptorCrc).u32(compressedSize).u32(0).u32(size).u32(0);
    const gap = spec.gapAfter?.get(i);
    if (gap !== undefined) out.bytes(gap);
    written.push({ spec: entry, name, offset, crc, compressedSize, size, flags, method });
  });

  if (spec.beforeCentral !== undefined) out.bytes(spec.beforeCentral);
  const centralOffset = out.length;
  for (const w of written) {
    const e = w.spec;
    const extra = e.extra ?? new Uint8Array(0);
    const comment = e.comment ?? new Uint8Array(0);
    out
      .u32(SIG_CENTRAL)
      .u16(e.versionMadeBy ?? GITHUB_MADE_BY)
      .u16(e.versionNeeded ?? 20)
      .u16(w.flags)
      .u16(w.method)
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(w.crc)
      .u32(w.compressedSize)
      .u32(w.size)
      .u16(w.name.byteLength)
      .u16(extra.byteLength)
      .u16(comment.byteLength)
      .u16(e.diskStart ?? 0)
      .u16(0)
      .u32(e.externalAttrs ?? GITHUB_EXTERNAL_ATTRS)
      .u32(e.centralOffsetFrom === undefined ? (e.centralOffset ?? w.offset) : (written[e.centralOffsetFrom.entry]?.offset ?? 0) + e.centralOffsetFrom.plus)
      .bytes(w.name)
      .bytes(extra)
      .bytes(comment);
  }
  const centralSize = out.length - centralOffset;
  const eocd = spec.eocd ?? {};
  const total = eocd.totalEntries ?? written.length;
  if (spec.zip64Record === true) {
    out
      .u32(SIG_ZIP64_EOCD)
      .u32(44)
      .u32(0)
      .u32(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u32(total)
      .u32(0)
      .u32(total)
      .u32(0)
      .u32(centralSize)
      .u32(0)
      .u32(centralOffset)
      .u32(0);
  }
  if (spec.zip64Locator === true) out.u32(SIG_ZIP64_LOCATOR).u32(0).u32(centralOffset + centralSize).u32(0).u32(1);
  const comment = spec.comment ?? new Uint8Array(0);
  out
    .u32(SIG_EOCD)
    .u16(eocd.disk ?? 0)
    .u16(eocd.centralDisk ?? 0)
    .u16(eocd.entriesOnDisk ?? total)
    .u16(total)
    .u32(eocd.centralSize ?? centralSize)
    .u32(eocd.centralOffset ?? centralOffset)
    .u16(comment.byteLength)
    .bytes(comment);
  if (spec.trailing !== undefined) out.bytes(spec.trailing);
  return out.done();
}

/** A deterministic unit image name `v<i>.desktop.png` for index `i`. */
export function pngName(i: number): string {
  return `v${String(i)}.desktop.png`;
}

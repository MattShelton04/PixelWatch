// Generates testdata/zip/hostile/: the M1.4 hostile ZIP corpus (02 §5, threat-model R4.3-08 and
// R4.3-10). Each archive breaks one rule of the accepted ZIP profile (ADR 0008); manifest.json
// names the IngressError code the trusted reader must reject it with, its class, and why. The
// files are committed so the corpus is fixed even if this script or Node's zlib output changes.
//
//   node tools/zip-corpus/generate.ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { type ArchiveSpec, type EntrySpec, ascii, buildZip, concat, extraField, pngName } from "./zip-builder.ts";

export const HOSTILE_DIR = fileURLToPath(new URL("../../testdata/zip/hostile/", import.meta.url));

/** Classes the threat model (R4.3-08, R4.3-10) and 07 §6 name; the tests require each one. */
export const REQUIRED_CLASSES = [
  "traversal",
  "absolute",
  "drive",
  "separator",
  "duplicate",
  "case-collision",
  "link",
  "special-file",
  "zip64",
  "encryption",
  "method",
  "header-mismatch",
  "descriptor",
  "overlap",
  "entry-count-bomb",
  "deflate-bomb",
  "trailing",
  "extra-file",
] as const;

export interface HostileCase {
  name: string;
  code: string;
  class: string;
  why: string;
  bytes: Uint8Array;
}

const MiB = 1024 * 1024;
const BUNDLE: EntrySpec = { name: "bundle.json", data: ascii('{"schemaVersion":1}') };
/** Not a real PNG: the archive layer never looks inside entries. */
function png(i: number, overrides: Partial<EntrySpec> = {}): EntrySpec {
  return { name: pngName(i), data: Uint8Array.from({ length: 64 }, (_, k) => (k * 7 + i) & 0xff), ...overrides };
}
function zip(...entries: EntrySpec[]): Uint8Array {
  return buildZip({ entries });
}
function archive(spec: Partial<ArchiveSpec>, ...entries: EntrySpec[]): Uint8Array {
  return buildZip({ ...spec, entries });
}
const unix = (mode: number) => (mode << 16) >>> 0;

export function hostileCorpus(): HostileCase[] {
  const cases: HostileCase[] = [];
  const add = (name: string, code: string, cls: string, why: string, bytes: Uint8Array) => {
    cases.push({ name, code, class: cls, why, bytes });
  };
  const valid = zip(BUNDLE, png(1));

  // Entry names: traversal, absolute and drive paths, separators, dot names, NUL, encoding.
  add("name-traversal-dotdot", "zip-name-traversal", "traversal", "entry ../<unit>.png", zip(BUNDLE, png(1, { name: `../${pngName(1)}` })));
  add("name-traversal-backslash", "zip-name-traversal", "traversal", "entry ..\\<unit>.png", zip(BUNDLE, png(1, { name: `..\\${pngName(1)}` })));
  add("name-traversal-inner", "zip-name-traversal", "traversal", "entry a/../<unit>.png", zip(BUNDLE, png(1, { name: `a/../${pngName(1)}` })));
  add("name-absolute-slash", "zip-name-absolute", "absolute", "entry /<unit>.png", zip(BUNDLE, png(1, { name: `/${pngName(1)}` })));
  add("name-absolute-backslash", "zip-name-absolute", "absolute", "entry \\<unit>.png", zip(BUNDLE, png(1, { name: `\\${pngName(1)}` })));
  add("name-unc", "zip-name-absolute", "absolute", "entry \\\\server\\share\\<unit>.png", zip(BUNDLE, png(1, { name: `\\\\server\\share\\${pngName(1)}` })));
  add("name-drive-relative", "zip-name-drive", "drive", "entry C:<unit>.png", zip(BUNDLE, png(1, { name: `C:${pngName(1)}` })));
  add("name-drive-absolute", "zip-name-drive", "drive", "entry C:\\<unit>.png", zip(BUNDLE, png(1, { name: `C:\\${pngName(1)}` })));
  add("name-nested", "zip-name-separator", "separator", "entry dir/<unit>.png", zip(BUNDLE, png(1, { name: `dir/${pngName(1)}` })));
  add("name-directory-entry", "zip-name-separator", "separator", "a directory entry u/", zip(BUNDLE, { name: "u/", data: new Uint8Array(0), method: 0 }));
  add("name-dot", "zip-name-dot", "name", "entry .", zip(BUNDLE, png(1, { name: "." })));
  add("name-dotdot", "zip-name-dot", "name", "entry ..", zip(BUNDLE, png(1, { name: ".." })));
  add("name-nul", "zip-name-nul", "name", "entry bundle.json\\0.png", zip(BUNDLE, png(1, { name: "bundle.json\0.png" })));
  add("name-non-ascii", "zip-name-encoding", "name", "UTF-8 entry name bundlé.json with flag bit 11", zip(png(1), { ...BUNDLE, name: Buffer.from("bundlé.json", "utf8"), flags: 0x800 }));
  add("name-empty", "zip-name-empty", "name", "empty entry name", zip(BUNDLE, png(1, { name: "" })));

  // Duplicates and case-fold collisions, rejected before anything is extracted.
  add("duplicate-bundle", "zip-duplicate-name", "duplicate", "two bundle.json entries", zip(BUNDLE, BUNDLE, png(1)));
  add("duplicate-png", "zip-duplicate-name", "duplicate", "the same <unit>.png twice", zip(BUNDLE, png(1), png(1)));
  add("case-collision-bundle", "zip-name-collision", "case-collision", "bundle.json and BUNDLE.JSON", zip(BUNDLE, { ...BUNDLE, name: "BUNDLE.JSON" }, png(1)));
  add("case-collision-png", "zip-name-collision", "case-collision", "<unit>.png and <UNIT>.PNG", zip(BUNDLE, png(0xabc), png(0xabc, { name: pngName(0xabc).toUpperCase() })));

  // Anything but bundle.json and <viewId>.<variantId>.png (R4.3-10).
  for (const [file, why] of [
    ["index.html", "HTML"],
    ["image.svg", "SVG"],
    ["app.js", "JavaScript"],
    ["style.css", "CSS"],
    ["data.xml", "XML"],
    ["app.js.map", "a source map"],
    ["network.har", "a HAR"],
    ["trace.zip", "a Playwright trace"],
    ["notes.txt", "an attachment"],
  ] as const) {
    add(`extra-file-${file.replaceAll(".", "-")}`, "zip-name-not-allowed", "extra-file", `${why} entry ${file} next to valid entries`, zip(BUNDLE, png(1), { name: file, data: ascii("<x/>") }));
  }
  add("extra-file-no-variant", "zip-name-not-allowed", "extra-file", "<view>.png without a variant", zip(BUNDLE, png(1, { name: "home.png" })));
  add("extra-file-upper-case", "zip-name-not-allowed", "extra-file", "<View>.<variant>.png with an upper-case ID, on its own", zip(BUNDLE, png(1, { name: "Home.desktop.png" })));
  add("bundle-missing", "zip-bundle-missing", "extra-file", "PNG entries without bundle.json", zip(png(1), png(2)));

  // Links and special files.
  add("symlink-unix", "zip-link", "link", "Unix mode 0120777 (symlink)", zip(BUNDLE, png(1, { externalAttrs: unix(0o120777) })));
  add("special-directory-mode", "zip-special-file", "special-file", "Unix mode 040755 (directory)", zip(BUNDLE, png(1, { externalAttrs: unix(0o040755) })));
  add("special-fifo-mode", "zip-special-file", "special-file", "Unix mode 010644 (FIFO)", zip(BUNDLE, png(1, { externalAttrs: unix(0o010644) })));
  add("special-char-device-mode", "zip-special-file", "special-file", "Unix mode 020644 (character device)", zip(BUNDLE, png(1, { externalAttrs: unix(0o020644) })));
  add("special-dos-directory", "zip-special-file", "special-file", "MS-DOS host, directory attribute", zip(BUNDLE, png(1, { versionMadeBy: 0x0014, externalAttrs: 0x10 })));
  add("special-dos-volume", "zip-special-file", "special-file", "MS-DOS host, volume-label attribute", zip(BUNDLE, png(1, { versionMadeBy: 0x0014, externalAttrs: 0x08 })));
  add("host-ntfs", "zip-host", "special-file", "made by host 10 (NTFS), whose attributes aren't interpreted", zip(BUNDLE, png(1, { versionMadeBy: 0x0a14 })));

  // ZIP64 in every place it can be signalled.
  add("zip64-locator", "zip64", "zip64", "ZIP64 end record and locator before the EOCD", archive({ zip64Record: true, zip64Locator: true }, BUNDLE, png(1)));
  add("zip64-record", "zip64", "zip64", "ZIP64 end record without a locator", archive({ zip64Record: true }, BUNDLE, png(1)));
  add("zip64-extra-field", "zip64", "zip64", "ZIP64 extended-information extra field (0x0001)", zip(BUNDLE, png(1, { extra: extraField(0x0001, new Uint8Array(16)) })));
  add("zip64-size-sentinel", "zip64", "zip64", "central sizes 0xFFFFFFFF", zip(BUNDLE, png(1, { compressedSize: 0xffffffff, size: 0xffffffff })));
  add("zip64-count-sentinel", "zip64", "zip64", "EOCD entry count 0xFFFF", archive({ eocd: { totalEntries: 0xffff } }, BUNDLE, png(1)));
  add("zip64-offset-sentinel", "zip64", "zip64", "EOCD central-directory offset 0xFFFFFFFF", archive({ eocd: { centralOffset: 0xffffffff } }, BUNDLE, png(1)));

  // Encryption, methods, flags, versions.
  add("encrypted-traditional", "zip-encrypted", "encryption", "flag bit 0 (traditional PKWARE encryption)", zip(BUNDLE, png(1, { flags: 0x01 })));
  add("encrypted-strong", "zip-encrypted", "encryption", "flag bit 6 (strong encryption)", zip(BUNDLE, png(1, { flags: 0x40 })));
  add("encrypted-central-directory", "zip-encrypted", "encryption", "flag bit 13 (encrypted central directory)", zip(BUNDLE, png(1, { flags: 0x2000 })));
  add("encrypted-aes", "zip-encrypted", "encryption", "method 99 (WinZip AES)", zip(BUNDLE, png(1, { method: 99 })));
  for (const [method, label] of [[9, "deflate64"], [12, "bzip2"], [14, "lzma"], [93, "zstd"]] as const) {
    add(`method-${label}`, "zip-method", "method", `method ${String(method)} (${label})`, zip(BUNDLE, png(1, { method })));
  }
  add("version-needed-45", "zip-version", "method", "version needed to extract 4.5", zip(BUNDLE, png(1, { versionNeeded: 45 })));
  add("flags-patched-data", "zip-flags", "method", "flag bit 5 (compressed patched data)", zip(BUNDLE, png(1, { flags: 0x20 })));

  // Extra fields and comments: nothing outside the entry data may carry content.
  add("extra-unix-ids", "zip-extra-field", "extra-field", "Info-ZIP Unix UID/GID extra field (0x7875)", zip(BUNDLE, png(1, { extra: extraField(0x7875, Uint8Array.of(1, 4, 0, 0, 0, 0, 4, 0, 0, 0, 0)) })));
  add("extra-unicode-path", "zip-extra-field", "extra-field", "Info-ZIP Unicode path extra field (0x7075) naming ../evil.html", zip(BUNDLE, png(1, { extra: extraField(0x7075, concat([Uint8Array.of(1, 0, 0, 0, 0), ascii("../evil.html")])) })));
  add("extra-timestamp", "zip-extra-field", "extra-field", "extended timestamp extra field (0x5455)", zip(BUNDLE, png(1, { extra: extraField(0x5455, Uint8Array.of(1, 0, 0, 0, 0)) })));
  add("extra-local-only", "zip-extra-field", "extra-field", "an extra field in the local header only", zip(BUNDLE, png(1, { localExtra: extraField(0xcafe, ascii("hidden")) })));
  add("comment-entry", "zip-comment", "comment", "an entry comment", zip(BUNDLE, png(1, { comment: ascii("<script>") })));
  add("comment-archive", "zip-comment", "comment", "an archive comment", archive({ comment: ascii("<html>") }, BUNDLE, png(1)));

  // Multi-disk.
  add("multi-disk-eocd", "zip-multi-disk", "framing", "EOCD disk number 1", archive({ eocd: { disk: 1 } }, BUNDLE, png(1)));
  add("multi-disk-entries-on-disk", "zip-multi-disk", "framing", "entries on this disk 1 of 2", archive({ eocd: { entriesOnDisk: 1 } }, BUNDLE, png(1)));
  add("multi-disk-entry", "zip-multi-disk", "framing", "entry starts on disk 1", zip(BUNDLE, png(1, { diskStart: 1 })));

  // Framing: the archive must be exactly entries, central directory and EOCD.
  add("eocd-missing", "zip-eocd", "framing", "the last 22 bytes (EOCD) cut off", valid.subarray(0, valid.length - 22));
  add("eocd-empty-file", "zip-eocd", "framing", "empty file", new Uint8Array(0));
  add("eocd-not-a-zip", "zip-eocd", "framing", "a PNG signature and IHDR, no ZIP structure", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0));
  add("trailing-bytes", "zip-trailing-bytes", "trailing", "garbage after the EOCD", archive({ trailing: ascii("<script>alert(1)</script>") }, BUNDLE, png(1)));
  add("trailing-one-byte", "zip-trailing-bytes", "trailing", "one byte after the EOCD", archive({ trailing: Uint8Array.of(0) }, BUNDLE, png(1)));
  add("leading-sfx-stub", "zip-leading-bytes", "trailing", "an executable stub before the first local header", archive({ prefix: concat([ascii("MZ"), new Uint8Array(126)]) }, BUNDLE, png(1)));
  add("leading-png-polyglot", "zip-leading-bytes", "trailing", "a PNG prefix (polyglot)", archive({ prefix: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) }, BUNDLE, png(1)));
  add("gap-between-entries", "zip-gap", "trailing", "unreferenced bytes between two entries", archive({ gapAfter: new Map([[0, ascii("<svg onload=alert(1)>")]]) }, BUNDLE, png(1)));
  add("gap-before-central", "zip-gap", "trailing", "unreferenced bytes before the central directory", archive({ beforeCentral: ascii("<html>") }, BUNDLE, png(1)));
  add("overlap-shared-offset", "zip-overlap", "overlap", "two central records point at one local header", zip(BUNDLE, png(1), png(2, { centralOffsetFrom: { entry: 1, plus: 0 } })));
  add("overlap-inside-data", "zip-overlap", "overlap", "a central record points into another entry's data", zip(BUNDLE, png(1), png(2, { centralOffsetFrom: { entry: 1, plus: 40 } })));
  add("central-directory-out-of-range", "zip-central-directory", "framing", "central-directory offset past the end of the file", archive({ eocd: { centralOffset: 0x7fffffff } }, BUNDLE, png(1)));
  add("central-directory-count", "zip-central-directory", "framing", "EOCD declares 3 entries, the directory holds 2", archive({ eocd: { totalEntries: 3 } }, BUNDLE, png(1)));
  add("central-directory-size", "zip-central-directory", "framing", "central-directory size one byte too large", patchU32(valid, valid.length - 10, readU32(valid, valid.length - 10) + 1));
  add("local-offset-out-of-range", "zip-out-of-range", "framing", "local-header offset past the central directory", zip(BUNDLE, png(1, { centralOffset: 0x7fffffff })));
  add("data-out-of-range", "zip-out-of-range", "framing", "compressed size runs past the central directory", zip(BUNDLE, png(1, { compressedSize: 0x00ffffff })));

  // Central and local headers must agree.
  add("mismatch-local-signature", "zip-header-mismatch", "header-mismatch", "local-header signature corrupted", patch(valid, 0, Uint8Array.of(0x50, 0x4b, 0x05, 0x06)));
  add("mismatch-name", "zip-header-mismatch", "header-mismatch", "local name index.html, central name <unit>.png", zip(BUNDLE, png(1, { localName: ascii("index.html") })));
  add("mismatch-method", "zip-header-mismatch", "header-mismatch", "local method 0, central method 8", zip(BUNDLE, png(1, { localMethod: 0 })));
  add("mismatch-flags", "zip-header-mismatch", "header-mismatch", "local flags add bit 11", zip(BUNDLE, png(1, { localFlags: 0x0808 })));
  add("mismatch-version", "zip-header-mismatch", "header-mismatch", "local version needed 10, central 20", zip(BUNDLE, png(1, { localVersionNeeded: 10 })));
  add("mismatch-sizes", "zip-header-mismatch", "header-mismatch", "no descriptor; local size differs from central", zip(BUNDLE, png(1, { descriptor: false, localSize: 1 })));
  add("mismatch-crc-with-descriptor", "zip-header-mismatch", "header-mismatch", "descriptor flag set but the local CRC is neither 0 nor the central CRC", zip(BUNDLE, png(1, { localCrc: 0x12345678 })));

  // Data descriptors: only the signed 16-byte form, matching the central record.
  add("descriptor-unsigned", "zip-data-descriptor", "descriptor", "12-byte descriptor without its signature", zip(BUNDLE, png(1, { descriptor: "unsigned" })));
  add("descriptor-crc", "zip-data-descriptor", "descriptor", "descriptor CRC differs from the central CRC", zip(BUNDLE, png(1, { descriptorCrc: 0xdeadbeef })));
  add("descriptor-zip64", "zip-data-descriptor", "descriptor", "24-byte ZIP64 descriptor", zip(BUNDLE, png(1, { descriptor: "zip64" })));
  add("descriptor-missing", "zip-data-descriptor", "descriptor", "flag bit 3 set but no descriptor follows the data", zip(png(1, { descriptor: false, flags: 0x08, localCrc: 0, localCompressedSize: 0, localSize: 0 }), BUNDLE));

  // Entry data.
  const data = png(1).data;
  const deflated = deflateRawSync(data);
  add("crc-mismatch", "zip-crc", "crc", "CRC-32 in every header differs from the data", zip(BUNDLE, png(1, { crc: 0x01020304 })));
  add("deflate-invalid", "zip-deflate", "deflate", "deflate block type 3 (invalid)", zip(BUNDLE, png(1, { compressed: Uint8Array.of(0xff, 0xff, 0xff, 0xff) })));
  add("deflate-truncated", "zip-deflate-truncated", "deflate", "deflate stream cut before its final block ends", zip(BUNDLE, png(1, { compressed: deflated.subarray(0, deflated.length - 4) })));
  add("deflate-trailing", "zip-deflate-trailing", "deflate", "bytes after the deflate stream end, inside the entry", zip(BUNDLE, png(1, { compressed: concat([deflated, ascii("<html>")]) })));
  add("stored-size-mismatch", "zip-size-mismatch", "deflate", "stored entry whose sizes differ", zip(BUNDLE, png(1, { method: 0, size: data.length + 1 })));
  add("inflate-short", "zip-inflate-short", "deflate", "header claims 10 more bytes than the entry inflates to", zip(BUNDLE, png(1, { size: data.length + 10 })));

  // Bombs. Budgets count actual inflated bytes; header sizes only give early refusals.
  add("bomb-lying-header", "zip-inflate-overflow", "deflate-bomb", "header claims 1 KiB; the entry inflates to 64 MiB of zeros", zip(BUNDLE, png(1, { data: new Uint8Array(64 * MiB), size: 1024 })));
  add("bomb-declared-png", "zip-entry-too-large", "deflate-bomb", "a PNG entry declaring 33 MiB (over the 32 MiB PNG limit)", zip(BUNDLE, png(1, { size: 33 * MiB })));
  add("bomb-declared-bundle", "zip-entry-too-large", "deflate-bomb", "bundle.json declaring 2 MiB (over the 1 MiB JSON limit)", zip({ ...BUNDLE, size: 2 * MiB }, png(1)));
  add("bomb-expanded-total", "zip-expanded-total", "deflate-bomb", "17 honest 32 MiB PNG entries: 544 MiB, past the 512 MiB per-ingestion budget counted from inflated bytes", zip(BUNDLE, ...Array.from({ length: 17 }, (_, i) => png(i + 1, { data: new Uint8Array(32 * MiB) }))));
  add("bomb-entry-count", "zip-too-many-entries", "entry-count-bomb", "EOCD declares 5000 entries (over 4096 per ingestion)", archive({ eocd: { totalEntries: 5000 } }, BUNDLE, png(1)));

  return cases;
}

function patch(bytes: Uint8Array, offset: number, values: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out.set(values, offset);
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function patchU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  new DataView(out.buffer).setUint32(offset, value, true);
  return out;
}

export interface Manifest {
  comment: string;
  cases: { file: string; code: string; class: string; why: string }[];
}

export function manifest(cases: HostileCase[]): Manifest {
  return {
    comment: "Generated by tools/zip-corpus/generate.ts. Each archive must be rejected by the trusted ZIP reader with `code` (ADR 0008).",
    cases: cases.map((c) => ({ file: `${c.name}.zip`, code: c.code, class: c.class, why: c.why })),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cases = hostileCorpus();
  mkdirSync(HOSTILE_DIR, { recursive: true });
  for (const file of readdirSync(HOSTILE_DIR)) if (file.endsWith(".zip")) rmSync(join(HOSTILE_DIR, file));
  for (const c of cases) writeFileSync(join(HOSTILE_DIR, `${c.name}.zip`), c.bytes);
  writeFileSync(join(HOSTILE_DIR, "manifest.json"), `${JSON.stringify(manifest(cases), null, 2)}\n`);
  const bytes = cases.reduce((sum, c) => sum + c.bytes.byteLength, 0);
  console.log(`wrote ${String(cases.length)} files (${String(bytes)} bytes) to testdata/zip/hostile/`);
}

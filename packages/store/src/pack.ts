import { createHash } from "node:crypto";
import { fstatSync, readSync, writeSync } from "node:fs";
import { inflateSync, type Inflate } from "node:zlib";
import { refuse, STORE_LIMITS } from "./types.ts";

export const MAX_PACK_OBJECTS = 2 * STORE_LIMITS.maxFiles + 1024;
export function indexReservation(objects: number): number { return 36 * objects + 1064; }
function packet(text: string): string { return `${(text.length + 4).toString(16).padStart(4, "0")}${text}`; }
export function uploadRequest(want: string): Buffer {
  if (!/^[a-f0-9]{40}$/.test(want)) refuse("git-object-invalid");
  return Buffer.from(`${packet(`want ${want} no-progress ofs-delta\n`)}${packet("deepen 1\n")}0000${packet("done\n")}`);
}
/** Stateless v0: a bounded shallow update, NAK, and un-multiplexed non-thin pack. */
export class PackReceiver {
  readonly #fd: number; readonly #want: string; readonly #maximum: number; readonly #objects: number;
  #state: "shallow" | "nak" | "header" | "pack" = "shallow";
  #pending = Buffer.alloc(64); #filled = 0; #needed = 4; #shallow = false; #count = 0; #bytes = 0;
  constructor(options: { fd: number; want: string; maxBytes: number; maxObjects: number }) {
    this.#fd = options.fd; this.#want = options.want; this.#maximum = options.maxBytes; this.#objects = options.maxObjects;
    if (!Number.isSafeInteger(this.#maximum) || this.#maximum < 32 || this.#maximum > STORE_LIMITS.maxTreeBytes || !Number.isSafeInteger(this.#objects) || this.#objects < 1 || this.#objects > MAX_PACK_OBJECTS) refuse("git-pack-limit");
  }
  write(chunk: Uint8Array): void {
    for (let at = 0; at < chunk.byteLength;) {
      if (this.#state === "pack") { this.#append(chunk.subarray(at)); return; }
      const take = Math.min(this.#needed - this.#filled, chunk.byteLength - at); this.#pending.set(chunk.subarray(at, at + take), this.#filled); this.#filled += take; at += take;
      if (this.#filled !== this.#needed) continue;
      if (this.#state === "header") {
        const version = this.#pending.readUInt32BE(4); this.#count = this.#pending.readUInt32BE(8);
        if (this.#pending.toString("ascii", 0, 4) !== "PACK" || (version !== 2 && version !== 3)) refuse("git-pack-header-invalid");
        if (this.#count < 1 || this.#count > this.#objects) refuse("git-pack-objects-limit");
        this.#state = "pack"; this.#append(this.#pending.subarray(0, 12)); continue;
      }
      if (this.#needed === 4) {
        const header = this.#pending.toString("ascii", 0, 4); if (!/^[a-f0-9]{4}$/.test(header)) refuse("git-pack-negotiation-invalid");
        const length = Number.parseInt(header, 16);
        if (length === 0 && this.#state === "shallow") { this.#state = "nak"; this.#filled = 0; continue; }
        if (length < 5 || length > 64) refuse("git-pack-negotiation-invalid"); this.#needed = length; continue;
      }
      const line = this.#pending.toString("ascii", 4, this.#needed);
      if (this.#state === "shallow") { if (this.#shallow || (line !== `shallow ${this.#want}` && line !== `shallow ${this.#want}\n`)) refuse("git-pack-negotiation-invalid"); this.#shallow = true; this.#filled = 0; this.#needed = 4; }
      else { if (line !== "NAK\n") refuse("git-pack-negotiation-invalid"); this.#state = "header"; this.#filled = 0; this.#needed = 12; }
    }
  }
  #append(bytes: Uint8Array): void {
    if (bytes.byteLength > this.#maximum - this.#bytes) refuse("git-pack-limit");
    for (let at = 0; at < bytes.byteLength;) { const count = writeSync(this.#fd, bytes, at, bytes.byteLength - at); if (count <= 0) refuse("git-pack-write-failed"); at += count; }
    this.#bytes += bytes.byteLength;
  }
  finish(): { bytes: number; objects: number; shallow: boolean } {
    if (this.#state !== "pack" || this.#bytes < 32) refuse("git-pack-truncated"); return { bytes: this.#bytes, objects: this.#count, shallow: this.#shallow };
  }
}

/** Before Git sees a pack, bound every raw and delta-result expansion. No reconstructed pool is retained. */
export function validatePack(fd: number, options: { maxExpandedBytes?: number } = {}): { objects: number; expandedBytes: number } {
  const maximum = options.maxExpandedBytes ?? STORE_LIMITS.maxTreeBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > STORE_LIMITS.maxTreeBytes) refuse("git-pack-expanded-limit");
  const length = fstatSync(fd).size; if (length < 32 || length > STORE_LIMITS.maxTreeBytes) refuse("git-pack-limit");
  const read = (position: number, bytes: number): Buffer => { if (position < 0 || position + bytes > length) refuse("git-pack-truncated"); const out = Buffer.alloc(bytes); if (readSync(fd, out, 0, bytes, position) !== bytes) refuse("git-pack-truncated"); return out; };
  const header = read(0, 12); const count = header.readUInt32BE(8);
  if (header.toString("ascii", 0, 4) !== "PACK" || ![2, 3].includes(header.readUInt32BE(4)) || count < 1 || count > MAX_PACK_OBJECTS) refuse("git-pack-header-invalid");
  const checksum = createHash("sha1"); for (let at = 0; at < length - 20;) { const chunk = read(at, Math.min(64 * 1024, length - 20 - at)); checksum.update(chunk); at += chunk.byteLength; }
  if (!checksum.digest().equals(read(length - 20, 20))) refuse("git-pack-checksum-invalid");
  let position = 12; let expandedBytes = 0; let inflatedBytes = 0;
  const objects = new Map<number, { bytes: number; depth: number }>();
  const byte = (): number => { const value = read(position++, 1)[0]; if (value === undefined || position > length - 20) refuse("git-pack-truncated"); return value; };
  for (let n = 0; n < count; n++) {
    const start = position; const first = byte(); const type = (first >> 4) & 7; let size = first & 15; let b = first; let scale = 16;
    while ((b & 128) !== 0) { b = byte(); size += (b & 127) * scale; scale *= 128; if (!Number.isSafeInteger(size) || size > STORE_LIMITS.maxPngBytes || scale > Number.MAX_SAFE_INTEGER) refuse("git-pack-object-limit"); }
    if (size > STORE_LIMITS.maxPngBytes) refuse("git-pack-object-limit");
    if (type !== 1 && type !== 2 && type !== 3 && type !== 6) refuse("git-pack-object-type-refused");
    let base: { bytes: number; depth: number } | undefined;
    if (type === 6) {
      b = byte(); let distance = b & 127;
      while ((b & 128) !== 0) { b = byte(); distance = (distance + 1) * 128 + (b & 127); if (!Number.isSafeInteger(distance) || distance > start) refuse("git-pack-delta-offset-invalid"); }
      base = objects.get(start - distance); if (base === undefined || base.depth >= 50) refuse("git-pack-delta-offset-invalid");
    }
    const available = Math.min(length - 20 - position, STORE_LIMITS.maxPngBytes + 64 * 1024);
    let raw: Buffer; let consumed: number;
    for (let window = Math.min(1024, available);;) {
      try {
        const result = inflateSync(read(position, window), { maxOutputLength: Math.max(1, size), info: true }) as unknown as { buffer: Buffer; engine: Inflate };
        raw = result.buffer; consumed = result.engine.bytesWritten; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "Z_BUF_ERROR" || window >= available) refuse("git-pack-inflate-invalid"); window = Math.min(window * 2, available);
      }
    }
    if (raw.byteLength !== size || consumed < 1 || consumed > available) refuse("git-pack-inflate-invalid"); position += consumed;
    inflatedBytes += raw.byteLength; if (inflatedBytes > maximum) refuse("git-pack-expanded-limit");
    const resultBytes = base === undefined ? size : deltaSize(raw, base.bytes);
    expandedBytes += resultBytes; if (expandedBytes > maximum) refuse("git-pack-expanded-limit");
    objects.set(start, { bytes: resultBytes, depth: base === undefined ? 0 : base.depth + 1 });
  }
  if (position !== length - 20) refuse("git-pack-tail-invalid"); return { objects: count, expandedBytes };
}
function deltaSize(raw: Uint8Array, baseBytes: number): number {
  let at = 0;
  const byte = (): number => { const value = raw[at++]; if (value === undefined) refuse("git-pack-delta-truncated"); return value; };
  const variable = (): number => { let result = 0; let scale = 1; let b: number; do { b = byte(); result += (b & 127) * scale; scale *= 128; if (!Number.isSafeInteger(result) || result > STORE_LIMITS.maxPngBytes || scale > Number.MAX_SAFE_INTEGER) refuse("git-pack-delta-limit"); } while ((b & 128) !== 0); return result; };
  if (variable() !== baseBytes) refuse("git-pack-delta-base-invalid"); const resultBytes = variable(); let produced = 0;
  while (at < raw.byteLength) {
    const operation = byte(); let bytes: number;
    if ((operation & 128) !== 0) {
      let offset = 0; bytes = 0;
      for (let n = 0; n < 4; n++) if ((operation & (1 << n)) !== 0) offset += byte() * 2 ** (8 * n);
      for (let n = 0; n < 3; n++) if ((operation & (1 << (4 + n))) !== 0) bytes += byte() * 2 ** (8 * n);
      if (bytes === 0) bytes = 65536; if (offset + bytes > baseBytes) refuse("git-pack-delta-copy-invalid");
    } else { bytes = operation; if (bytes === 0 || at + bytes > raw.byteLength) refuse("git-pack-delta-literal-invalid"); at += bytes; }
    produced += bytes; if (produced > resultBytes) refuse("git-pack-delta-result-invalid");
  }
  if (produced !== resultBytes) refuse("git-pack-delta-result-invalid"); return resultBytes;
}

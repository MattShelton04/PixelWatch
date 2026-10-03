import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PackReceiver, uploadRequest, validatePack } from "../src/pack.ts";

const WANT = "a".repeat(40);
function packet(text: string): Buffer { return Buffer.from(`${(text.length + 4).toString(16).padStart(4, "0")}${text}`); }
function pack(objects = 1): Buffer { const bytes = Buffer.alloc(12); bytes.write("PACK"); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(objects, 8); return bytes; }
function fixture(maxBytes = 40, maxObjects = 4) {
  const root = mkdtempSync(join(tmpdir(), "pixelwatch-store-pack-")); const fd = openSync(join(root, "bounded.pack"), "wx+");
  return { root, fd, receiver: new PackReceiver({ fd, want: WANT, maxBytes, maxObjects }), close: () => { closeSync(fd); rmSync(root, { recursive: true, force: true }); } };
}
function object(type: number, data: Uint8Array, declared = data.byteLength): Buffer {
  const header: number[] = []; let size = declared; let first = type * 16 + size % 16; size = Math.floor(size / 16);
  while (size > 0) { header.push(first | 128); first = size % 128; size = Math.floor(size / 128); } header.push(first);
  return Buffer.concat([Buffer.from(header), deflateSync(data)]);
}
function complete(entries: readonly Uint8Array[]): Buffer { const body = Buffer.concat([pack(entries.length), ...entries]); return Buffer.concat([body, createHash("sha1").update(body).digest()]); }
function variable(value: number): Buffer { const bytes: number[] = []; do { let b = value % 128; value = Math.floor(value / 128); if (value > 0) b |= 128; bytes.push(b); } while (value > 0); return Buffer.from(bytes); }
describe("bounded Git pack reception (M2.2)", () => {
  it("writes fragmented shallow depth-one negotiation only after the pack header is validated", () => {
    const f = fixture();
    try {
      const bytes = Buffer.concat([packet(`shallow ${WANT}\n`), Buffer.from("0000"), packet("NAK\n"), pack(), Buffer.alloc(20)]);
      for (const byte of bytes) f.receiver.write(Uint8Array.of(byte));
      expect(f.receiver.finish()).toEqual({ bytes: 32, objects: 1, shallow: true }); expect(fstatSync(f.fd).size).toBe(32);
      expect(uploadRequest(WANT).toString()).toBe(`${packet(`want ${WANT} no-progress ofs-delta\n`).toString()}${packet("deepen 1\n").toString()}0000${packet("done\n").toString()}`);
    } finally { f.close(); }
  });
  it("refuses an overflowing pack chunk before writing any excess byte", () => {
    const f = fixture();
    try {
      f.receiver.write(Buffer.concat([Buffer.from("0000"), packet("NAK\n"), pack(), Buffer.alloc(20)]));
      expect(fstatSync(f.fd).size).toBe(32); expect(() => { f.receiver.write(Buffer.alloc(9)); }).toThrow("git-pack-limit"); expect(fstatSync(f.fd).size).toBe(32);
    } finally { f.close(); }
  });
  it("refuses excessive object counts malformed negotiation and truncation before indexing", () => {
    for (const bytes of [Buffer.concat([Buffer.from("0000"), packet("NAK\n"), pack(5)]), Buffer.concat([packet(`shallow ${"b".repeat(40)}\n`), Buffer.from("0000")]), Buffer.from("ffff"), Buffer.concat([Buffer.from("0000"), packet("ERR fake-canary-token\n")])]) {
      const f = fixture(); try { expect(() => { f.receiver.write(bytes); }).toThrow(); expect(fstatSync(f.fd).size).toBe(0); } finally { f.close(); }
    }
    const f = fixture(); try { f.receiver.write(Buffer.concat([Buffer.from("0000"), packet("NAK\n"), pack().subarray(0, 8)])); expect(() => f.receiver.finish()).toThrow("git-pack-truncated"); } finally { f.close(); }
  });
  it("checks raw declared sizes and compressed bombs before trusted Git indexing", () => {
    for (const [entry, code] of [[object(3, Uint8Array.of(1), 33_554_433), "git-pack-object-limit"], [object(3, Buffer.alloc(1024 * 1024), 8), "git-pack-inflate-invalid"]] as const) {
      const f = fixture(); try { writeSync(f.fd, complete([entry])); expect(() => validatePack(f.fd)).toThrow(code); } finally { f.close(); }
    }
  });
  it("checks delta result expansion copy ranges and aggregate limits before indexing", () => {
    // First object starts at 12; delta starts after it; encode OFS backward distance (<128).
    const base = object(3, Uint8Array.of(1)); const distance = base.byteLength;
    for (const delta of [Buffer.concat([variable(1), variable(33_554_433)]), Buffer.from([1, 1, 0x91, 2, 1]), Buffer.from([1, 1, 0])]) {
      const deflated = object(6, delta); const withOffset = Buffer.concat([deflated.subarray(0, 1), Uint8Array.of(distance), deflated.subarray(1)]);
      const f = fixture(); try { writeSync(f.fd, complete([base, withOffset])); expect(() => validatePack(f.fd)).toThrow(/git-pack-delta-/); } finally { f.close(); }
    }
    const f = fixture(); try { writeSync(f.fd, complete([object(3, Buffer.alloc(4)), object(3, Buffer.alloc(4))])); expect(() => validatePack(f.fd, { maxExpandedBytes: 7 })).toThrow("git-pack-expanded-limit"); } finally { f.close(); }
  });
  it("validates a bounded full object and OFS delta without retaining reconstructed data", () => {
    const base = object(3, Uint8Array.of(1)); const delta = object(6, Uint8Array.of(1, 1, 0x90, 1));
    const withOffset = Buffer.concat([delta.subarray(0, 1), Uint8Array.of(base.byteLength), delta.subarray(1)]);
    const f = fixture(); try { writeSync(f.fd, complete([base, withOffset])); expect(validatePack(f.fd)).toEqual({ objects: 2, expandedBytes: 2 }); } finally { f.close(); }
  });
  it("refuses thin or reference deltas tags excessive delta depth and instruction expansion", () => {
    for (const type of [4, 7]) { const f = fixture(); try { writeSync(f.fd, complete([object(type, Uint8Array.of(1))])); expect(() => validatePack(f.fd)).toThrow("git-pack-object-type-refused"); } finally { f.close(); } }
    const entries = [object(3, Uint8Array.of(1))];
    for (let n = 0; n < 51; n++) { const last = entries.at(-1); if (last === undefined) throw new Error("fixture base"); const delta = object(6, Uint8Array.of(1, 1, 0x90, 1)); entries.push(Buffer.concat([delta.subarray(0, 1), Uint8Array.of(last.byteLength), delta.subarray(1)])); }
    const deep = fixture(); try { writeSync(deep.fd, complete(entries)); expect(() => validatePack(deep.fd)).toThrow("git-pack-delta-offset-invalid"); } finally { deep.close(); }
    const base = object(3, Uint8Array.of(1)); const delta = object(6, Uint8Array.of(1, 1, 1, 7)); const instruction = fixture();
    try { writeSync(instruction.fd, complete([base, Buffer.concat([delta.subarray(0, 1), Uint8Array.of(base.byteLength), delta.subarray(1)])])); expect(() => validatePack(instruction.fd, { maxExpandedBytes: 4 })).toThrow("git-pack-expanded-limit"); } finally { instruction.close(); }
  });
  it("refuses high-bit aliases of Git packet and PACK headers before indexing", () => {
    const clean = Buffer.concat([Buffer.from("0000"), packet("NAK\n"), pack(), Buffer.alloc(20)]);
    for (const offset of [0, 8, 12]) {
      const bytes = Buffer.from(clean); const original = bytes[offset]; if (original === undefined) throw new Error("fixture byte"); bytes[offset] = original | 128;
      const f = fixture(); try { expect(() => { f.receiver.write(bytes); }).toThrow(offset === 12 ? "git-pack-header-invalid" : "git-pack-negotiation-invalid"); expect(fstatSync(f.fd).size).toBe(0); } finally { f.close(); }
    }
    const shallow = Buffer.concat([packet(`shallow ${WANT}`), Buffer.from("0000"), packet("NAK\n"), pack(), Buffer.alloc(20)]); shallow[4] = "s".charCodeAt(0) | 128;
    const f = fixture(); try { expect(() => { f.receiver.write(shallow); }).toThrow("git-pack-negotiation-invalid"); expect(fstatSync(f.fd).size).toBe(0); } finally { f.close(); }
    const body = Buffer.concat([pack(), object(3, Uint8Array.of(1))]); for (let n = 0; n < 4; n++) body[n] = (body[n] ?? 0) | 128;
    const encoded = Buffer.concat([body, createHash("sha1").update(body).digest()]); const alias = fixture();
    try { writeSync(alias.fd, encoded); expect(() => validatePack(alias.fd)).toThrow("git-pack-header-invalid"); } finally { alias.close(); }
  });
});

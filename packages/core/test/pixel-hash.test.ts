// Pixel hash (02 §3, 07 §2). The fixed vectors in testdata/pixel-hash/vectors.json were computed
// by an independent Python implementation (tools/prototype-goldens/record.py), not by this code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PIXEL_HASH_DOMAIN, normalizeRgba, pixelHash, type RawPixels } from "../src/pixel-hash.ts";

interface Vector {
  id: string;
  description: string;
  width: number;
  height: number;
  channels: 3 | 4;
  data: string;
  sha256: string;
  message?: string;
}

interface Relation {
  kind: "equal" | "distinct";
  ids: string[];
  why: string;
}

const file = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "testdata", "pixel-hash", "vectors.json"), "utf8"),
) as { vectors: Vector[]; relations: Relation[] };

function raw(v: Vector): RawPixels {
  return { width: v.width, height: v.height, channels: v.channels, data: Buffer.from(v.data, "hex") };
}

const byId = new Map(file.vectors.map((v) => [v.id, v]));

describe("pixel hash fixed vectors", () => {
  it.each(file.vectors.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    expect(pixelHash(raw(v))).toBe(v.sha256);
  });

  it("pins the exact pre-hash bytes of at least one vector", () => {
    const pinned = file.vectors.filter((v) => v.message !== undefined);
    expect(pinned.length).toBeGreaterThan(0);
    for (const v of pinned) {
      const message = Buffer.from(v.message ?? "", "hex");
      const header = Buffer.alloc(8);
      header.writeUInt32BE(v.width, 0);
      header.writeUInt32BE(v.height, 4);
      const expected = Buffer.concat([Buffer.from(PIXEL_HASH_DOMAIN, "utf8"), header, normalizeRgba(raw(v))]);
      expect(message.equals(expected)).toBe(true);
      expect(createHash("sha256").update(message).digest("hex")).toBe(v.sha256);
    }
  });

  it.each(file.relations.map((r) => [r.why, r] as const))("relation: %s", (_why, r) => {
    const recorded = r.ids.map((id) => byId.get(id)?.sha256);
    expect(recorded.every((h) => h !== undefined)).toBe(true);
    const computed = r.ids.map((id) => pixelHash(raw(byId.get(id) as Vector)));
    expect(computed).toEqual(recorded);
    expect(new Set(recorded).size).toBe(r.kind === "equal" ? 1 : r.ids.length);
  });

  it("covers every case 02 §3 names", () => {
    const covered = file.relations.map((r) => r.why).join(" | ");
    for (const topic of ["dimension byte order", "hidden RGB under alpha 0", "alpha 1", "alpha 254", "RGB vs RGBA", "same byte count"]) {
      expect(covered).toContain(topic);
    }
  });
});

describe("pixel hash properties", () => {
  const image = fc
    .record({ width: fc.integer({ min: 1, max: 6 }), height: fc.integer({ min: 1, max: 6 }) })
    .chain(({ width, height }) =>
      fc.record({
        width: fc.constant(width),
        height: fc.constant(height),
        channels: fc.constant(4 as const),
        data: fc.uint8Array({ minLength: width * height * 4, maxLength: width * height * 4 }),
      }),
    );

  it("ignores RGB under alpha 0", () => {
    fc.assert(
      fc.property(image, fc.nat(), fc.integer({ min: 0, max: 255 }), (img, at, value) => {
        const pixel = at % (img.width * img.height);
        const data = Uint8Array.from(img.data);
        data[pixel * 4 + 3] = 0;
        const before = pixelHash({ ...img, data });
        data[pixel * 4] = value;
        data[pixel * 4 + 1] = 255 - value;
        return pixelHash({ ...img, data }) === before;
      }),
    );
  });

  it("changes when any visible channel changes", () => {
    fc.assert(
      fc.property(image, fc.nat(), fc.integer({ min: 0, max: 3 }), (img, at, channel) => {
        const pixel = at % (img.width * img.height);
        const data = Uint8Array.from(img.data);
        if (channel < 3 && data[pixel * 4 + 3] === 0) data[pixel * 4 + 3] = 1;
        const before = pixelHash({ ...img, data });
        const index = pixel * 4 + channel;
        data[index] = ((data[index] ?? 0) + 1) % 256;
        return pixelHash({ ...img, data }) !== before;
      }),
    );
  });

  it("treats RGB as RGBA with alpha 255", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), fc.uint8Array({ minLength: 75, maxLength: 75 }), (w, h, bytes) => {
        const rgb = bytes.subarray(0, w * h * 3);
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          rgba.set(rgb.subarray(i * 3, i * 3 + 3), i * 4);
          rgba[i * 4 + 3] = 255;
        }
        return pixelHash({ width: w, height: h, channels: 3, data: rgb }) === pixelHash({ width: w, height: h, channels: 4, data: rgba });
      }),
    );
  });

  it("normalizes without touching the input", () => {
    const data = Uint8Array.of(9, 8, 7, 0, 1, 2, 3, 4);
    expect([...normalizeRgba({ width: 2, height: 1, channels: 4, data })]).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
    expect([...data]).toEqual([9, 8, 7, 0, 1, 2, 3, 4]);
  });
});

describe("pixel hash input checks", () => {
  const ok = (width: number, height: number, channels: 3 | 4 = 4): RawPixels => ({
    width,
    height,
    channels,
    data: new Uint8Array(width * height * channels),
  });

  it("rejects dimensions outside 1–16383 and more than 16,000,000 pixels", () => {
    expect(() => pixelHash({ ...ok(1, 1), width: 0 })).toThrow(/width/);
    expect(() => pixelHash({ ...ok(1, 1), height: 16384 })).toThrow(/height/);
    expect(() => pixelHash({ ...ok(1, 1), width: 1.5 })).toThrow(/width/);
    expect(() => pixelHash({ width: 16383, height: 1000, channels: 4, data: new Uint8Array(0) })).toThrow(/pixels/);
  });

  it("rejects a data length that doesn't match the dimensions", () => {
    expect(() => pixelHash({ ...ok(2, 2), data: new Uint8Array(15) })).toThrow(/bytes/);
    expect(() => pixelHash({ ...ok(2, 2, 3), data: new Uint8Array(16) })).toThrow(/bytes/);
  });

  it("rejects channel counts other than 3 and 4", () => {
    expect(() => pixelHash({ ...ok(1, 1), channels: 2 as 4 })).toThrow(/channels/);
  });
});

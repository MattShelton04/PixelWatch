// Canonical blob pool (M1.2; 03 §§3–4; threat-model R4.3-09). Blobs are named by pixel hash and
// hold the canonical re-encoding; an existing blob is reused and never overwritten.
import { describe, expect, it } from "vitest";
import { type BlobPool, blobPath, storeBlob } from "../src/blob-pool.ts";
import { type RawPixels, pixelHash } from "../src/pixel-hash.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import { PngWorker } from "../src/png/isolated.ts";

/** An in-memory pool that, like the store adapters, refuses to overwrite and records every call. */
class MemoryPool implements BlobPool {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: string[] = [];

  has(path: string): Promise<boolean> {
    this.calls.push(`has ${path}`);
    return Promise.resolve(this.files.has(path));
  }

  add(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`add ${path}`);
    if (this.files.has(path)) throw new Error(`overwrite of ${path}`);
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve();
  }
}

const rgba = (data: number[], width = 2): RawPixels => ({ width, height: data.length / 4 / width, channels: 4, data: Uint8Array.from(data) });
const IMAGE = rgba([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 1, 2, 3, 0]);

describe("blob paths (03 §3)", () => {
  it("names a blob blobs/<first two hex>/<pixel hash>.png", () => {
    const hash = pixelHash(IMAGE);
    expect(blobPath(hash)).toBe(`blobs/${hash.slice(0, 2)}/${hash}.png`);
  });

  it("rejects a name that isn't 64 lowercase hex", () => {
    for (const bad of ["", "ab", "A".repeat(64), `${"a".repeat(63)}g`, `../${"a".repeat(61)}`, `${"a".repeat(64)}\n`, "a".repeat(65)]) {
      expect(() => blobPath(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe("storing canonical blobs (M1.2)", () => {
  it("writes a new blob named by its pixel hash as canonical PNG", async () => {
    const pool = new MemoryPool();
    const stored = await storeBlob(pool, IMAGE);
    const hash = pixelHash(IMAGE);
    expect(stored).toEqual({ pixelHash: hash, path: blobPath(hash), reused: false });
    const written = pool.files.get(stored.path);
    expect(written).toBeDefined();
    if (written === undefined) return;
    expect(Buffer.from(written).equals(Buffer.from(encodePng(IMAGE)))).toBe(true);
    expect(pixelHash(await decodePng(written))).toBe(hash);
  });

  it("stores two uploads that differ only in RGB under alpha 0 as one blob, with that RGB zeroed", async () => {
    const pool = new MemoryPool();
    const a = await storeBlob(pool, rgba([1, 2, 3, 255, 200, 100, 50, 0]));
    const b = await storeBlob(pool, rgba([1, 2, 3, 255, 9, 9, 9, 0]));
    expect(b.path).toBe(a.path);
    expect([a.reused, b.reused]).toEqual([false, true]);
    expect(pool.calls.filter((c) => c.startsWith("add"))).toHaveLength(1);
    const blob = pool.files.get(a.path);
    expect(blob).toBeDefined();
    if (blob !== undefined) expect([...(await decodePng(blob)).data]).toEqual([1, 2, 3, 255, 0, 0, 0, 0]);
  });

  it("reuses an existing blob without reading or overwriting it", async () => {
    const pool = new MemoryPool();
    const hash = pixelHash(IMAGE);
    const existing = Uint8Array.of(1, 2, 3);
    pool.files.set(blobPath(hash), existing);
    expect(await storeBlob(pool, IMAGE)).toEqual({ pixelHash: hash, path: blobPath(hash), reused: true });
    expect(pool.calls).toEqual([`has ${blobPath(hash)}`]);
    expect(pool.files.get(blobPath(hash))).toBe(existing);
  });

  it("encodes through a PngWorker codec", async () => {
    const worker = new PngWorker();
    try {
      const pool = new MemoryPool();
      const first = await storeBlob(pool, IMAGE, worker);
      const second = await storeBlob(pool, IMAGE, worker);
      expect([first.reused, second.reused]).toEqual([false, true]);
      const blob = pool.files.get(first.path);
      expect(blob).toBeDefined();
      if (blob !== undefined) expect(Buffer.from(blob).equals(Buffer.from(encodePng(IMAGE)))).toBe(true);
    } finally {
      await worker.close();
    }
  });

  it("refuses pixels outside 02 §5 before touching the pool", async () => {
    const pool = new MemoryPool();
    await expect(storeBlob(pool, { width: 0, height: 1, channels: 4, data: new Uint8Array(0) })).rejects.toThrow(RangeError);
    expect(pool.calls).toEqual([]);
  });
});

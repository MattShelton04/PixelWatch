// Canonical blob pool (M1.2; 03 §§3–4; threat-model R4.3-09). Blobs are named by pixel hash,
// existing blobs are revalidated against their name and never overwritten, and a corrupt named
// blob is an error, never silently replaced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPng } from "../../../tools/png-corpus/png-builder.ts";
import { BlobError, type BlobPool, blobPath, storeBlob, verifyBlob } from "../src/blob-pool.ts";
import { type RawPixels, pixelHash } from "../src/pixel-hash.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import { PngWorker } from "../src/png/isolated.ts";

const TESTDATA = join(import.meta.dirname, "..", "..", "..", "testdata");

/** An in-memory pool that, like the store adapters, refuses to overwrite and records every call. */
class MemoryPool implements BlobPool {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  /** Simulates another writer creating the blob between our read and our create. */
  raceWith: Uint8Array | undefined;

  read(path: string): Promise<Uint8Array | undefined> {
    this.calls.push(`read ${path}`);
    return Promise.resolve(this.files.get(path));
  }

  create(path: string, bytes: Uint8Array): Promise<"created" | "exists"> {
    this.calls.push(`create ${path}`);
    if (this.raceWith !== undefined) {
      this.files.set(path, this.raceWith);
      this.raceWith = undefined;
    }
    if (this.files.has(path)) return Promise.resolve("exists");
    this.files.set(path, Uint8Array.from(bytes));
    return Promise.resolve("created");
  }
}

const rgba = (data: number[], width = 2): RawPixels => ({ width, height: data.length / 4 / width, channels: 4, data: Uint8Array.from(data) });
const IMAGE = rgba([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 1, 2, 3, 0]);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof BlobError) return error.code;
    throw error;
  }
}

describe("blob paths (03 §3)", () => {
  it("names a blob blobs/<first two hex>/<pixel hash>.png", () => {
    const hash = pixelHash(IMAGE);
    expect(blobPath(hash)).toBe(`blobs/${hash.slice(0, 2)}/${hash}.png`);
  });

  it("rejects a name that isn't 64 lowercase hex", () => {
    for (const bad of ["", "ab", "A".repeat(64), `${"a".repeat(63)}g`, `../${"a".repeat(61)}`, `${"a".repeat(64)}\n`, "a".repeat(65)]) {
      expect(() => blobPath(bad), JSON.stringify(bad)).toThrow(BlobError);
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
    expect(pool.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    const blob = pool.files.get(a.path);
    expect(blob).toBeDefined();
    if (blob !== undefined) expect([...(await decodePng(blob)).data]).toEqual([1, 2, 3, 255, 0, 0, 0, 0]);
  });

  it("reuses an existing valid blob and never overwrites it", async () => {
    const pool = new MemoryPool();
    const hash = pixelHash(IMAGE);
    // A different but valid encoding of the same pixels (another encoder, filter and level).
    const existing = buildPng(2, 2, 4, Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 0, 0, 0, 0]), { filters: () => 4, level: 1 });
    expect(Buffer.from(existing).equals(Buffer.from(encodePng(IMAGE)))).toBe(false);
    pool.files.set(blobPath(hash), existing);
    const stored = await storeBlob(pool, IMAGE);
    expect(stored).toEqual({ pixelHash: hash, path: blobPath(hash), reused: true });
    expect(pool.calls).toEqual([`read ${blobPath(hash)}`]);
    expect(pool.files.get(blobPath(hash))).toBe(existing);
  });

  it("fails on a corrupt named blob and writes nothing", async () => {
    const hash = pixelHash(IMAGE);
    const other = encodePng(rgba([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 1, 2, 3, 1]));
    const canonical = encodePng(IMAGE);
    const corrupt: [string, Uint8Array][] = [
      ["garbage", Uint8Array.from("not a png at all", (c) => c.charCodeAt(0))],
      ["empty", new Uint8Array(0)],
      ["valid PNG of other pixels", other],
      ["truncated canonical PNG", canonical.subarray(0, canonical.length - 13)],
      ["hostile PNG (inflate bomb)", readFileSync(join(TESTDATA, "png", "hostile", "bomb-1x1-1mib.png"))],
      ["canonical PNG plus a trailing byte", Uint8Array.from([...canonical, 0])],
    ];
    for (const [label, bytes] of corrupt) {
      const pool = new MemoryPool();
      pool.files.set(blobPath(hash), bytes);
      expect(await code(storeBlob(pool, IMAGE)), label).toBe("blob-corrupt");
      expect(pool.calls, label).toEqual([`read ${blobPath(hash)}`]);
      expect(pool.files.get(blobPath(hash)), label).toBe(bytes);
    }
  });

  it("verifies the winner after losing a create race", async () => {
    const hash = pixelHash(IMAGE);
    const pool = new MemoryPool();
    pool.raceWith = encodePng(IMAGE);
    expect(await storeBlob(pool, IMAGE)).toEqual({ pixelHash: hash, path: blobPath(hash), reused: true });
    expect(pool.calls).toEqual([`read ${blobPath(hash)}`, `create ${blobPath(hash)}`, `read ${blobPath(hash)}`]);

    const corrupt = new MemoryPool();
    corrupt.raceWith = Uint8Array.of(1, 2, 3);
    expect(await code(storeBlob(corrupt, IMAGE))).toBe("blob-corrupt");
  });

  it("encodes and verifies through a PngWorker codec", async () => {
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

describe("verifying named blobs", () => {
  it("accepts any in-profile encoding of the named pixels", async () => {
    const hash = pixelHash(IMAGE);
    await expect(verifyBlob(hash, encodePng(IMAGE))).resolves.toBeUndefined();
    const rgbOnly = rgba([5, 6, 7, 255, 8, 9, 10, 255]);
    await expect(verifyBlob(pixelHash(rgbOnly), buildPng(2, 1, 3, Uint8Array.of(5, 6, 7, 8, 9, 10)))).resolves.toBeUndefined();
  });

  it("names the cause when a blob is corrupt", async () => {
    const hash = pixelHash(IMAGE);
    const error = await verifyBlob(hash, Uint8Array.of(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlobError);
    expect((error as BlobError).code).toBe("blob-corrupt");
    expect((error as BlobError).message).toContain(hash);
    expect(await code(verifyBlob(hash, encodePng(rgba([0, 0, 0, 255], 1))))).toBe("blob-corrupt");
    expect(await code(verifyBlob("nothex", encodePng(IMAGE)))).toBe("blob-name");
  });
});

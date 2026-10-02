// Restricted PNG codec (M1.1; 02 §5; threat-model R4.2-08, R4.3-08, R4.3-09). The independent
// decoder is fast-png (test toolchain only; it inflates with fflate, not node:zlib). The test-side
// encoder in tools/png-corpus/png-builder.ts is written separately from src/png/.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { normalizePng } from "@pixelwatch/schemas";
import fc from "fast-check";
import { decode as fastPngDecode } from "fast-png";
import { describe, expect, it } from "vitest";
import { IEND, buildPng, chunk, concat, filterScanlines, ihdr, png } from "../../../tools/png-corpus/png-builder.ts";
import { type TinyCase, paintTinyImage } from "../../../tools/prototype-goldens/tiny-cases.ts";
import { type RawPixels, normalizeRgba, pixelHash } from "../src/pixel-hash.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import { PngError } from "../src/png/errors.ts";
import { PngWorker } from "../src/png/isolated.ts";
import { MAX_PIXELS, MAX_PNG_BYTES } from "../src/png/limits.ts";

const TESTDATA = join(import.meta.dirname, "..", "..", "..", "testdata");
const read = (...parts: string[]): Uint8Array => readFileSync(join(TESTDATA, ...parts));
const json = (...parts: string[]): unknown => JSON.parse(readFileSync(join(TESTDATA, ...parts), "utf8"));
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** The code a rejected promise carries, or "ok". */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof PngError) return error.code;
    throw error;
  }
}

/** fast-png's view of an 8-bit RGB/RGBA PNG as tightly packed bytes. */
function independent(bytes: Uint8Array): RawPixels {
  const image = fastPngDecode(bytes);
  if (image.depth !== 8 || (image.channels !== 3 && image.channels !== 4)) throw new Error("fast-png: not 8-bit RGB/RGBA");
  return { width: image.width, height: image.height, channels: image.channels, data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) };
}

function expectSamePixels(actual: RawPixels, expected: RawPixels, label: string): void {
  expect({ width: actual.width, height: actual.height, channels: actual.channels }, label).toEqual({
    width: expected.width,
    height: expected.height,
    channels: expected.channels,
  });
  expect(Buffer.from(actual.data).equals(Buffer.from(expected.data)), `${label}: pixel bytes`).toBe(true);
}

function chunkTypes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let pos = 8; pos < bytes.byteLength; pos += 12 + view.getUint32(pos)) {
    types.push(String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)));
  }
  return types;
}

const image = (maxSide: number) =>
  fc
    .record({ width: fc.integer({ min: 1, max: maxSide }), height: fc.integer({ min: 1, max: maxSide }), channels: fc.constantFrom(3 as const, 4 as const) })
    .chain(({ width, height, channels }) =>
      fc.record({
        width: fc.constant(width),
        height: fc.constant(height),
        channels: fc.constant(channels),
        // Few distinct values, so neighbouring pixels collide and Paeth/Average ties happen.
        data: fc.uint8Array({ minLength: width * height * channels, maxLength: width * height * channels }).map((d) => d.map((v) => (v % 7 === 0 ? 0 : v % 5 === 0 ? 255 : v))),
      }),
    );

interface HostileManifest {
  cases: { file: string; code: string; why: string }[];
}

describe("hostile PNG corpus (02 §5)", () => {
  const manifest = json("png", "hostile", "manifest.json") as HostileManifest;

  it("rejects every hostile PNG with its code, allocating at most the header-sized output", async () => {
    for (const c of manifest.cases) {
      const bytes = read("png", "hostile", c.file);
      const started = performance.now();
      const sizes: number[] = [];
      const allocate = (n: number) => {
        sizes.push(n);
        return new Uint8Array(n);
      };
      expect(await outcome(decodePng(bytes, { allocate })), `${c.file}: ${c.why}`).toBe(c.code);
      // Structural failures allocate nothing; inflate failures only the output the checked header sized.
      expect(sizes.length, `${c.file}: allocations`).toBeLessThanOrEqual(1);
      for (const n of sizes) expect(n, `${c.file}: output size`).toBeLessThanOrEqual(MAX_PIXELS * 4);
      expect(performance.now() - started, `${c.file}: rejection time`).toBeLessThan(5_000);
    }
  });

  it("covers every class of hostile input the threat model names", () => {
    const codes = new Set(manifest.cases.map((c) => c.code));
    for (const code of [
      "signature", "truncated", "chunk-length", "chunk-type", "chunk-crc", "ihdr-first", "ihdr-length", "ihdr-duplicate",
      "iend-length", "trailing-bytes", "idat-missing", "dimensions", "too-many-pixels", "color-type", "bit-depth",
      "compression-method", "filter-method", "interlace", "chunk-disallowed", "filter-type", "zlib", "inflate-truncated",
      "zlib-trailing", "inflate-short", "inflate-overflow",
    ]) {
      expect(codes, code).toContain(code);
    }
    const names = manifest.cases.map((c) => c.file);
    for (const name of ["ihdr-duplicate.png", "iend-duplicate.png", "crc-idat.png", "filter-5-first-row.png", "bomb-4000x4000-rgba.png", "trailing-byte.png", "dims-max-u32.png", "interlace-adam7.png", "chunk-tEXt-before-idat.png"]) {
      expect(names, name).toContain(name);
    }
  });

  it("lists every committed corpus file in the manifest exactly once", () => {
    const files = readdirSync(join(TESTDATA, "png", "hostile")).filter((f) => f.endsWith(".png")).sort();
    const listed = manifest.cases.map((c) => c.file).sort();
    expect(listed).toEqual(files);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("rejects input over 32 MiB before parsing it", async () => {
    const huge = new Uint8Array(MAX_PNG_BYTES + 1);
    huge.set(read("comparator", "crops", "crops", "36287837535-config-injector-base.png"));
    expect(await outcome(decodePng(huge))).toBe("too-large");
  });

  it("bounds error messages and keeps hostile bytes out of them", async () => {
    const bad = png(ihdr({ width: 2, height: 2 }), chunk("IDAT", new Uint8Array(4000).fill(0x3c)), IEND);
    try {
      await decodePng(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PngError);
      const message = (error as PngError).message;
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2048);
      expect(message).not.toContain("<<<<");
    }
  });
});

describe("decoding real screenshots", () => {
  interface Crops {
    crops: { id: string; sides: Record<"base" | "head", { file: string; fileSha256: string; pixelHash: string; width: number; height: number }> }[];
  }
  const crops = (json("comparator", "crops", "crops.json") as Crops).crops.flatMap((c) =>
    (["base", "head"] as const).map((side) => ({ path: ["comparator", "crops", c.sides[side].file], ...c.sides[side] })),
  );
  const pr123 = json("comparator", "propertyscope-pr123", "prototype.json") as {
    views: { id: string; inputs: Partial<Record<"base" | "head", { fileSha256: string; pixelHash: string; width: number; height: number }>> }[];
  };
  const f1 = pr123.views.find((v) => v.id === "f1-overview-error")?.inputs.head;
  const recorded = [
    ...crops,
    ...(f1 === undefined ? [] : [{ path: ["prototypes", "propertyscope-36405830015", "visual-head-fixture", "f1-overview-error.png"], ...f1 }]),
  ];
  const all = [
    ...recorded.map((r) => r.path),
    ["prototypes", "tracepilot-36314265418", "visual-head-1", "not-found.png"],
  ];

  it("decodes real screenshots to the same RGBA as an independent decoder", async () => {
    expect(all).toHaveLength(8);
    for (const path of all) {
      const bytes = read(...path);
      expectSamePixels(await decodePng(bytes), independent(bytes), path.join("/"));
    }
  });

  it("matches the pixel hashes the prototype recorded with Pillow", async () => {
    expect(recorded).toHaveLength(7);
    for (const r of recorded) {
      const bytes = read(...r.path);
      expect(createHash("sha256").update(bytes).digest("hex"), `${r.path.join("/")} is the recorded file`).toBe(r.fileSha256);
      const decoded = await decodePng(bytes);
      expect([decoded.width, decoded.height]).toEqual([r.width, r.height]);
      expect(pixelHash(decoded), r.path.join("/")).toBe(r.pixelHash);
    }
  });
});

describe("PngSuite cross-check (07 §2)", () => {
  const expected = json("pngsuite", "expected.json") as { cases: { file: string; expect: string; why: string }[] };

  it("gives every PngSuite file its expected outcome", async () => {
    const files = readdirSync(join(TESTDATA, "pngsuite")).filter((f) => f.endsWith(".png")).sort();
    expect(expected.cases.map((c) => c.file).sort()).toEqual(files);
    for (const c of expected.cases) {
      const bytes = read("pngsuite", c.file);
      expect(await outcome(decodePng(bytes)), `${c.file}: ${c.why}`).toBe(c.expect);
      if (c.expect === "ok") expectSamePixels(await decodePng(bytes), independent(bytes), c.file);
    }
    // Every corrupt x* file is rejected.
    expect(expected.cases.filter((c) => c.file.startsWith("x") && c.expect === "ok")).toEqual([]);
  });

  it("decodes every PngSuite image that fits after converter normalization exactly like fast-png", async () => {
    let compared = 0;
    for (const c of expected.cases) {
      const normalized = normalizePng(read("pngsuite", c.file));
      if (!normalized.ok) continue;
      expectSamePixels(await decodePng(normalized.png), independent(normalized.png), c.file);
      compared++;
    }
    // f0x/z0x/basn/bgan/… 8-bit RGB(A) files: well over the 10 that fit untouched.
    expect(compared).toBeGreaterThanOrEqual(30);
  });
});

describe("decoder against an independent decoder (07 §2)", () => {
  it("agrees with fast-png on random images, filters and IDAT splits", async () => {
    await fc.assert(
      fc.asyncProperty(image(24), fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 24 }), fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 6 }), async (img, filters, split) => {
        const bytes = buildPng(img.width, img.height, img.channels, img.data, { filters: (y) => filters[y % filters.length] ?? 0, split });
        const decoded = await decodePng(bytes);
        expectSamePixels(decoded, independent(bytes), "random");
        expectSamePixels(decoded, img, "input");
      }),
      { numRuns: 300 },
    );
  });

  it("decodes the extreme shapes 16383×1, 1×16383 and 1×1", async () => {
    for (const [width, height, channels] of [[16383, 1, 4], [1, 16383, 3], [1, 1, 3], [1, 1, 4]] as const) {
      const data = Uint8Array.from({ length: width * height * channels }, (_, i) => (i * 31) & 0xff);
      for (const filter of [0, 1, 2, 3, 4]) {
        const bytes = buildPng(width, height, channels, data, { filters: () => filter });
        expectSamePixels(await decodePng(bytes), { width, height, channels, data }, `${String(width)}×${String(height)} filter ${String(filter)}`);
      }
    }
  });

  it("accepts zero-length IDAT chunks inside the IDAT run", async () => {
    const data = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    const stream = deflateSync(filterScanlines(2, 2, 3, data, () => 1));
    const [first, second] = [stream.subarray(0, 5), stream.subarray(5)];
    const bytes = png(ihdr({ width: 2, height: 2 }), chunk("IDAT"), chunk("IDAT", first), chunk("IDAT"), chunk("IDAT", second), chunk("IDAT"), IEND);
    expectSamePixels(await decodePng(bytes), { width: 2, height: 2, channels: 3, data }, "zero-length IDATs");
  });

  it("decodes a stream split into 200,000 one-byte IDAT chunks", async () => {
    const width = 1000;
    const height = 200;
    const data = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 13) & 0xff);
    const stream = deflateSync(filterScanlines(width, height, 3, data, (y) => y % 5), { level: 0 });
    expect(stream.byteLength).toBeGreaterThan(200_000);
    const bytes = concat([png(ihdr({ width, height })), ...Array.from(stream, (b) => chunk("IDAT", Uint8Array.of(b))), IEND]);
    const started = performance.now();
    const decoded = await decodePng(bytes);
    const elapsed = performance.now() - started;
    expectSamePixels(decoded, { width, height, channels: 3, data }, "one-byte IDATs");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("allocates only the output buffer", async () => {
    const data = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => i);
    const sizes: number[] = [];
    const decoded = await decodePng(buildPng(5, 3, 4, data, { filters: (y) => y + 2 }), {
      allocate: (n) => {
        sizes.push(n);
        return new Uint8Array(n);
      },
    });
    expect(sizes).toEqual([5 * 3 * 4]);
    expect([...decoded.data]).toEqual([...data]);
  });
});

describe("canonical encoder (03 §4)", () => {
  it("encodes output that fits the profile and round-trips the normalized pixels", async () => {
    await fc.assert(
      fc.asyncProperty(image(20), async (img) => {
        const encoded = encodePng(img);
        // The independent M0.3 converter-side profile check passes it through unchanged.
        const profile = normalizePng(encoded);
        expect(profile.ok).toBe(true);
        if (profile.ok) expect(Buffer.from(profile.png).equals(Buffer.from(encoded))).toBe(true);
        expect(chunkTypes(encoded).filter((t) => t !== "IDAT")).toEqual(["IHDR", "IEND"]);
        const decoded = await decodePng(encoded);
        expect(pixelHash(decoded)).toBe(pixelHash(img));
        expect(Buffer.from(normalizeRgba(decoded)).equals(Buffer.from(normalizeRgba(img)))).toBe(true);
        expectSamePixels(independent(encoded), decoded, "fast-png reads the canonical PNG");
      }),
      { numRuns: 200 },
    );
  });

  it("never echoes uploaded bytes that carry extra chunks", async () => {
    const data = Uint8Array.from({ length: 4 * 4 * 3 }, (_, i) => i * 5);
    const upload = buildPng(4, 4, 3, data, {
      before: [chunk("iCCP", concat([Uint8Array.of(0x69, 0, 0), new Uint8Array(8)])), chunk("tEXt", Uint8Array.of(0x6b, 0, 0x76))],
      after: [chunk("tEXt", Uint8Array.of(0x6b, 0, 0x77))],
    });
    // The trusted decoder refuses the upload outright…
    expect(await outcome(decodePng(upload))).toBe("chunk-disallowed");
    // …and the publisher never stores the bytes it was given, even once they're in the profile.
    const stripped = normalizePng(upload);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    const canonical = encodePng(await decodePng(stripped.png));
    expect(Buffer.from(canonical).equals(Buffer.from(upload))).toBe(false);
    expect(Buffer.from(canonical).includes(Buffer.from("tEXt"))).toBe(false);
    expect(Buffer.from(canonical).includes(Buffer.from("iCCP"))).toBe(false);
    expect(chunkTypes(canonical).filter((t) => t !== "IDAT")).toEqual(["IHDR", "IEND"]);
  });

  it("writes RGB when every pixel is opaque, RGBA otherwise, and zeroes RGB under alpha 0", async () => {
    const opaque = encodePng({ width: 2, height: 1, channels: 4, data: Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 255) });
    expect(await decodePng(opaque)).toMatchObject({ channels: 3, data: Uint8Array.of(1, 2, 3, 4, 5, 6) });
    const hidden = encodePng({ width: 2, height: 1, channels: 4, data: Uint8Array.of(9, 8, 7, 0, 4, 5, 6, 128) });
    expect(await decodePng(hidden)).toMatchObject({ channels: 4, data: Uint8Array.of(0, 0, 0, 0, 4, 5, 6, 128) });
  });

  it("is deterministic for the same pixels", () => {
    const data = Uint8Array.from({ length: 64 * 64 * 4 }, (_, i) => (i * 7) & 0xff);
    const img: RawPixels = { width: 64, height: 64, channels: 4, data };
    expect(Buffer.from(encodePng(img)).equals(Buffer.from(encodePng(img)))).toBe(true);
  });

  it("rejects pixel buffers outside 02 §5", () => {
    expect(() => encodePng({ width: 0, height: 1, channels: 3, data: new Uint8Array(0) })).toThrow(PngError);
    expect(() => encodePng({ width: 2, height: 2, channels: 4, data: new Uint8Array(15) })).toThrow(PngError);
    expect(() => encodePng({ width: 4001, height: 4000, channels: 3, data: new Uint8Array(0) })).toThrow(PngError);
  });

  it("matches the independent Python pixel hashes of the tiny cases after encode and decode", async () => {
    const { cases } = json("comparator", "tiny", "cases.json") as { cases: TinyCase[] };
    const recording = json("comparator", "tiny", "prototype.json") as { cases: Record<string, { sides: Partial<Record<"base" | "head", { pixelHash: string }>> }> };
    let checked = 0;
    for (const c of cases) {
      for (const side of ["base", "head"] as const) {
        const spec = c[side];
        if (spec.state !== "captured") continue;
        const decoded = await decodePng(encodePng({ width: spec.image.width, height: spec.image.height, channels: 4, data: paintTinyImage(spec.image) }));
        expect(pixelHash(decoded), `${c.id}/${side}`).toBe(recording.cases[c.id]?.sides[side]?.pixelHash);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("worker isolation (02 §5)", () => {
  const sample = read("comparator", "crops", "crops", "36301239732-rich-tool-view-full-base.png");

  it("decodes and encodes in a worker exactly as in-process", async () => {
    const worker = new PngWorker();
    try {
      const inWorker = await worker.decode(sample);
      expectSamePixels(inWorker, await decodePng(sample), "decode");
      expect(Buffer.from(await worker.encode(inWorker)).equals(Buffer.from(encodePng(inWorker)))).toBe(true);
      // The caller's buffers are copied, never detached.
      expect(sample.byteLength).toBeGreaterThan(0);
      expect(inWorker.data.byteLength).toBe(inWorker.width * inWorker.height * inWorker.channels);
    } finally {
      await worker.close();
    }
  });

  it("sends only the view's bytes, not its whole backing buffer", async () => {
    const worker = new PngWorker();
    try {
      const padded = new Uint8Array(sample.byteLength + 64);
      padded.set(sample, 32);
      const view = padded.subarray(32, 32 + sample.byteLength);
      expectSamePixels(await worker.decode(view), await decodePng(sample), "subarray input");
      expect(padded.byteLength).toBe(sample.byteLength + 64);
    } finally {
      await worker.close();
    }
  });

  it("rejects hostile input inside the worker with the same code", async () => {
    const worker = new PngWorker();
    try {
      for (const file of ["bomb-4000x4000-rgba.png", "crc-idat.png", "filter-255-last-row.png"]) {
        expect(await outcome(worker.decode(read("png", "hostile", file))), file).toBe(await outcome(decodePng(read("png", "hostile", file))));
      }
      expectSamePixels(await worker.decode(sample), await decodePng(sample), "still usable after rejections");
    } finally {
      await worker.close();
    }
  });

  it("runs one job at a time", async () => {
    const worker = new PngWorker({ workerUrl: fixture("probe-worker.ts") });
    try {
      const results = await Promise.all([1, 2, 3, 4].map(() => worker.decode(sample) as Promise<unknown>));
      expect(results).toEqual([1, 1, 1, 1]);
    } finally {
      await worker.close();
    }
  });

  it("terminates a job that exceeds its timeout, then recovers", async () => {
    const worker = new PngWorker({ workerUrl: fixture("hang-worker.ts") });
    try {
      expect(await outcome(worker.decode(sample, { timeoutMs: 200 }))).toBe("timeout");
      expect(await outcome(worker.decode(sample, { timeoutMs: 200 }))).toBe("timeout");
    } finally {
      await worker.close();
    }
  });

  it("rejects an aborted job", async () => {
    const worker = new PngWorker({ workerUrl: fixture("hang-worker.ts") });
    try {
      const controller = new AbortController();
      const job = worker.decode(sample, { signal: controller.signal });
      setTimeout(() => { controller.abort(); }, 50);
      expect(await outcome(job)).toBe("aborted");
      const early = new AbortController();
      early.abort();
      expect(await outcome(worker.decode(sample, { signal: early.signal }))).toBe("aborted");
    } finally {
      await worker.close();
    }
  });

  it("reports a worker crash as an error", async () => {
    const worker = new PngWorker({ workerUrl: fixture("crash-worker.ts") });
    try {
      expect(await outcome(worker.decode(sample))).toBe("worker-crash");
      expect(await outcome(worker.decode(sample))).toBe("worker-crash");
    } finally {
      await worker.close();
    }
  });
});

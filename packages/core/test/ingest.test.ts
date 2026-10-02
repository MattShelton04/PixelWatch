// Ingestion end to end (M1.4; 02 §§5–6; ADR 0008): archives from the test-side ZIP writer go in,
// side states backed by canonical blobs come out. Every captured image passes the bounded decoder;
// a bad part is rejected on its own, and only budgets, cancellation and codec isolation refuse the
// whole ingestion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Bundle, unitFileName } from "@pixelwatch/schemas";
import { afterAll, describe, expect, it } from "vitest";
import { type BlobCodec, blobPath } from "../src/blob-pool.ts";
import { IngressError } from "../src/ingest/errors.ts";
import { ingestArtifacts } from "../src/ingest/ingest.ts";
import { partKeyString } from "../src/ingest/select.ts";
import type { ArtifactInput, IngestInput, Ingestion } from "../src/ingest/types.ts";
import { pixelHash } from "../src/pixel-hash.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import { PngError } from "../src/png/errors.ts";
import { PngWorker } from "../src/png/isolated.ts";
import { ascii, pngName } from "../../../tools/zip-corpus/zip-builder.ts";
import { type PartSpec, VARIANT, artifact, config, memoryPool, tinyPng } from "./ingest-fixtures.ts";

const TESTDATA = join(import.meta.dirname, "..", "..", "..", "testdata");
const hostileZip = (file: string) => readFileSync(join(TESTDATA, "zip", "hostile", file));
const hostilePng = (file: string) => readFileSync(join(TESTDATA, "png", "hostile", file));

const worker = new PngWorker();
afterAll(() => worker.close());

const head = (units: PartSpec["units"], shard: [number, number] = [1, 1], providerId = "p"): PartSpec => ({ attempt: "7", revision: "head", providerId, shard, units });

function ingest(artifacts: readonly ArtifactInput[], extra: Partial<IngestInput> = {}): Promise<Ingestion> {
  return ingestArtifacts({ config: config([["p", 1]]), attempt: "7", baseline: "none", artifacts, pool: memoryPool(), ...extra });
}

async function refusal(promise: Promise<unknown>): Promise<IngressError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IngressError) return error;
    throw error;
  }
  throw new Error("the ingestion was not refused");
}

describe("ingestion", () => {
  it("takes dimensions from decoding, never from bundle.json", async () => {
    const png = tinyPng(5, 3, 7);
    const spec = head([{ viewId: "home", state: "captured", png }]);
    const claims = (bundle: unknown) => {
      const b = bundle as { units: { geometry?: unknown }[] };
      if (b.units[0] !== undefined) b.units[0].geometry = { mode: "viewport", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 };
      return b;
    };
    for (const codec of [undefined, worker]) {
      const pool = memoryPool();
      const ingestion = await ingest([artifact(spec, { edit: claims })], { pool, ...(codec === undefined ? {} : { codec }) });
      const unit = ingestion.units[0];
      const pixels = await decodePng(png);
      expect(unit?.head).toEqual({ state: "captured", pixelHash: pixelHash(pixels), width: 3, height: 7 });
      // The claim survives only as an untrusted detail.
      expect(unit?.details.head?.geometry).toMatchObject({ viewport: { width: 1280, height: 720 } });
      // The stored blob is the canonical re-encoding, not the uploaded file.
      const blob = pool.blobs.get(blobPath(pixelHash(pixels)));
      expect(blob).toEqual(encodePng(pixels));
      expect(pool.blobs.size).toBe(1);
    }
  });

  it("rejects a part whose PNG fails the bounded decoder", async () => {
    const config2 = config([["p", 2]]);
    const good = artifact(head([{ viewId: "a", state: "captured" }], [1, 2]));
    for (const [png, code] of [
      [hostilePng("dims-65536.png"), "dimensions"],
      [hostilePng("bomb-4000x4000-rgba.png"), "inflate-overflow"],
      [ascii("<svg onload=alert(1)>"), "signature"],
    ] as const) {
      for (const codec of [undefined, worker]) {
        const bad = artifact(head([{ viewId: "b", state: "captured", png }], [2, 2]));
        const ingestion = await ingest([good, bad], { config: config2, ...(codec === undefined ? {} : { codec }) });
        const part = ingestion.parts.find((p) => partKeyString(p) === "head/p/2");
        expect(part).toMatchObject({ status: "rejected", diagnostic: { code: "part-image-invalid" } });
        expect(part?.diagnostic?.message).toContain(`(${code})`);
        // The rejected part's catalog is unknown, so "b" isn't declared at all.
        expect(ingestion.units.map((u) => [u.viewId, u.head.state])).toEqual([["a", "captured"]]);
        expect(ingestion.coverage.status).toBe("incomplete");
      }
    }
  });

  it("rejects identity mismatches between name, bundle.json, attempt and config", async () => {
    const cfg = config([
      ["p", 2],
      ["q", 1],
    ]);
    const units = [{ viewId: "home", state: "failed" as const }];
    const spec = head(units, [1, 2]);
    const edits: [string, (b: Bundle) => Bundle][] = [
      ["attempt", (b) => ({ ...b, attempt: "8" })],
      ["revision", (b) => ({ ...b, revision: "base" })],
      ["providerId", (b) => ({ ...b, providerId: "q" })],
      ["shard", (b) => ({ ...b, shard: { index: 2, count: 2 } })],
      ["shard", (b) => ({ ...b, shard: { index: 1, count: 1 } })],
    ];
    for (const [field, edit] of edits) {
      const ingestion = await ingest([artifact(spec, { edit })], { config: cfg });
      const part = ingestion.parts.find((p) => partKeyString(p) === "head/p/1");
      expect(part, field).toMatchObject({ status: "rejected", diagnostic: { code: "part-identity" } });
      expect(part?.diagnostic?.message).toContain(field);
    }
    // A name whose count differs from the config's shards is no expected part at all.
    const ingestion = await ingest([artifact(head(units, [1, 3]))], { config: cfg });
    expect(ingestion.ignored).toMatchObject([{ reason: "unexpected-part" }]);
    expect(ingestion.parts.every((p) => p.status === "not-received")).toBe(true);
  });

  it("rejects a part whose files and captured units differ", async () => {
    const spec = head([
      { viewId: "a", state: "captured" },
      { viewId: "b", state: "absent" },
    ]);
    const fileA = unitFileName({ viewId: "a", variantId: VARIANT });
    const fileB = unitFileName({ viewId: "b", variantId: VARIANT });
    const cases: [ArtifactInput, string][] = [
      [artifact(spec), "valid"],
      // The captured unit's file is gone; the absent unit has one; an unrelated PNG rides along.
      [artifact(spec, { drop: [fileA] }), "part-file-missing"],
      [artifact(spec, { extra: [{ name: fileB, data: tinyPng(2) }] }), "part-extra-file"],
      [artifact(spec, { extra: [{ name: pngName(7), data: tinyPng(2) }] }), "part-extra-file"],
      [artifact(spec, { extra: [{ name: "index.html", data: ascii("<script>") }] }), "zip-name-not-allowed"],
      [artifact(spec, { drop: ["bundle.json"] }), "zip-bundle-missing"],
    ];
    for (const [input, code] of cases) {
      const ingestion = await ingest([input]);
      const part = ingestion.parts[0];
      if (code === "valid") expect(part?.status).toBe("valid");
      else expect(part, code).toMatchObject({ status: "rejected", diagnostic: { code } });
    }
  });

  it("never opens artifacts of another attempt", async () => {
    let decodes = 0;
    const codec: BlobCodec = {
      decode: (bytes) => {
        decodes++;
        return decodePng(bytes);
      },
      encode: encodePng,
    };
    const mine = artifact(head([{ viewId: "a", state: "captured" }]));
    const theirs = (attempt: string, file: string, id: string): ArtifactInput => ({ artifactName: `pixelwatch-b1-a${attempt}-head-p-s1-of1`, artifactId: id, zip: hostileZip(file) });
    const ingestion = await ingest([theirs("6", "bomb-expanded-total.zip", "1"), mine, theirs("8", "bomb-entry-count.zip", "2"), theirs("70", "overlap-shared-offset.zip", "3")], { codec });
    expect(ingestion.ignored.map((i) => [i.artifactId, i.reason])).toEqual([
      ["1", "other-attempt"],
      ["2", "other-attempt"],
      ["3", "other-attempt"],
    ]);
    expect(ingestion.parts.map((p) => [p.status, p.artifacts.map((a) => a.artifactId)])).toEqual([["valid", [mine.artifactId]]]);
    expect(decodes).toBe(1);
    expect(ingestion.coverage.status).toBe("complete-declared");
  });

  it("refuses the whole ingestion when a budget is exceeded", async () => {
    const cfg = config([["p", 2]]);
    const sibling = artifact(head([{ viewId: "a", state: "captured" }], [1, 2]));
    const as = (file: string): ArtifactInput => ({ artifactName: "pixelwatch-b1-a7-head-p-s2-of2", artifactId: "77", zip: hostileZip(file) });
    for (const [file, code] of [
      ["bomb-expanded-total.zip", "zip-expanded-total"],
      ["bomb-entry-count.zip", "zip-too-many-entries"],
    ] as const) {
      for (const order of [
        [sibling, as(file)],
        [as(file), sibling],
      ]) {
        const error = await refusal(ingest(order, { config: cfg }));
        expect(error).toMatchObject({ code, scope: "ingestion" });
      }
    }
    // A part-scope bomb only rejects its part (its placeholder bundle.json is read, and refused, first).
    const lying = await ingest([sibling, as("bomb-lying-header.zip")], { config: cfg });
    expect(lying.parts.map((p) => p.status)).toEqual(["valid", "rejected"]);

    // Cancellation and a failing PNG worker refuse it too: they say nothing about the part.
    const controller = new AbortController();
    controller.abort();
    expect(await refusal(ingest([sibling], { config: cfg, signal: controller.signal }))).toMatchObject({ code: "ingest-aborted", scope: "ingestion" });
    const crashing: BlobCodec = { decode: () => Promise.reject(new PngError("worker-crash", "gone")), encode: encodePng };
    expect(await refusal(ingest([sibling], { config: cfg, codec: crashing }))).toMatchObject({ code: "ingest-codec", scope: "ingestion" });

    // More than 1024 artifacts listed for one attempt.
    const many = Array.from({ length: 1025 }, (_, i): ArtifactInput => ({ artifactName: `other-${String(i)}`, artifactId: String(i + 1), zip: new Uint8Array() }));
    expect(await refusal(ingest(many))).toMatchObject({ code: "ingest-too-many-artifacts", scope: "ingestion" });
  });
});

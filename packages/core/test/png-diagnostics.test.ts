import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalBytes } from "@pixelwatch/schemas";
import { ingestArtifacts } from "../src/ingest/ingest.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import { PngError, type PngErrorCode } from "../src/png/errors.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { artifact, config, memoryPool } from "./ingest-fixtures.ts";

const part = () => artifact({revision: "head", providerId: "p", shard: [1, 1], units: [{viewId: "home", state: "captured"}]});
function poison(error: Error): void {Object.assign(error, {message: CANARY_TOKEN, stack: SIGNED_URL, cause: new Error(`${CANARY_TOKEN} ${SIGNED_URL}`)});}
async function failure(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown; try {await operation;} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(Error); const error = caught as Error;
  assertNoSecrets([String(error), JSON.stringify(error), error.stack ?? "", inspect(error, {depth: 10, getters: false})]);
  expect(error.cause).toBeUndefined(); return error;
}
describe("private PNG diagnostics at injected codec boundaries", () => {
  it("persisted image refusals authenticate the original PNG code without reading poisoned fields", async () => {
    const pool = memoryPool(); const error = new PngError("dimensions", "checked dimensions"); poison(error); let getters = 0; let reached = 0;
    for (const name of ["code", "detail", "message", "stack", "cause"]) Object.defineProperty(error, name, {get() {getters++; throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}});
    const result = await ingestArtifacts({config: config([["p", 1]]), attempt: "1", baseline: "none", artifacts: [part()], pool,
      deadline: new AbortController().signal, codec: {decode: () => {reached++; return Promise.reject(error);}, encode: encodePng}});
    expect(result.parts[0]).toMatchObject({status: "rejected", diagnostic: {code: "part-image-invalid", message: "unit 0's image is outside the PNG profile (dimensions)"}});
    expect({getters, reached, blobs: pool.blobs.size}).toEqual({getters: 0, reached: 1, blobs: 0}); assertNoSecrets([canonicalBytes(result)]);
  });
  it("encoder isolation errors refuse ingestion without exposing mutated fields or causes", async () => {
    const pool = memoryPool(); const error = new PngError("worker-crash", "worker failed"); poison(error); Object.assign(error, {code: CANARY_TOKEN, detail: SIGNED_URL}); let reached = 0;
    const caught = await failure(ingestArtifacts({config: config([["p", 1]]), attempt: "1", baseline: "none", artifacts: [part()], pool,
      deadline: new AbortController().signal, codec: {decode: decodePng, encode: () => {reached++; throw error;}}}));
    expect(caught).toMatchObject({code: "ingest-codec", scope: "ingestion"}); expect({reached, blobs: pool.blobs.size}).toEqual({reached: 1, blobs: 0});
  });
  it("unrecognized decoder exceptions and diagnostic proxies refuse without invoking traps", async () => {
    let traps = 0; let reached = 0;
    const proxy = new Proxy(new PngError("dimensions", "checked"), {get() {traps++; throw new Error(CANARY_TOKEN);}, getPrototypeOf() {traps++; throw new Error(SIGNED_URL);}});
    for (const error of [new Error(`${CANARY_TOKEN} ${SIGNED_URL}`), proxy]) {
      const pool = memoryPool(); const caught = await failure(ingestArtifacts({config: config([["p", 1]]), attempt: "1", baseline: "none", artifacts: [part()], pool,
        deadline: new AbortController().signal, codec: {decode: () => {reached++; return Promise.reject(error);}, encode: encodePng}}));
      expect(caught).toMatchObject({code: "ingest-codec", scope: "ingestion"}); expect(pool.blobs.size).toBe(0);
    }
    expect({traps, reached}).toEqual({traps: 0, reached: 2});
  });
  it("unknown runtime PNG diagnostic codes cannot enter persisted part text", async () => {
    const pool = memoryPool(); let reached = 0;
    const error = new PngError(CANARY_TOKEN as PngErrorCode, SIGNED_URL);
    const caught = await failure(ingestArtifacts({config: config([["p", 1]]), attempt: "1", baseline: "none", artifacts: [part()], pool,
      deadline: new AbortController().signal, codec: {decode: () => {reached++; return Promise.reject(error);}, encode: encodePng}}));
    expect(caught).toMatchObject({code: "ingest-codec", scope: "ingestion"}); expect({reached, blobs: pool.blobs.size}).toEqual({reached: 1, blobs: 0});
  });
});

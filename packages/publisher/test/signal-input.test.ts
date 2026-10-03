import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { parseDocument } from "@pixelwatch/schemas";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { isSignalAborted, onSignalAbort } from "../src/signal-input.ts";
import { admitRun } from "../src/admission.ts";
import { PublisherError } from "../src/types.ts";

function hook(name: string): symbol {
  let value: object | null = AbortSignal.prototype;
  while (value !== null) {
    const symbol = Object.getOwnPropertySymbols(value).find(key => key.description === name);
    if (symbol !== undefined) return symbol;
    value = Object.getPrototypeOf(value) as object | null;
  }
  throw new Error("signal-native-hook-unavailable");
}
describe("native publisher signal boundary", () => {
  it("rejects nonboolean native aborted storage before any adapter read or CAS", async () => {
    const parsed = parseDocument("run",readFileSync(new URL("../../../testdata/schemas/run/valid/no-usable-artifact.json",import.meta.url)));
    if (!parsed.ok) throw new Error("signal-fixture-invalid");
    for (const value of [0,null,"false",1]) {
      const controller = new AbortController(); const key = Object.getOwnPropertySymbols(controller.signal).find(symbol => symbol.description === "kAborted");
      if (key === undefined) throw new Error("signal-state-unavailable");
      Object.defineProperty(controller.signal,key,{value}); let reads = 0; let mutations = 0; let caught: unknown;
      try {await admitRun({read() {reads++; throw new Error(CANARY_TOKEN);},cas() {mutations++; throw new Error(SIGNED_URL);}}, {run: parsed.value,blobs: new Map()}, {
        context: {config: {schemaVersion: 1,source: {workflowIds: ["123456"],events: ["push"]},providers: [{id: "fixture",shards: 1}]},configCommit: "3".repeat(40),repository: {repositoryId: parsed.value.source.repositoryId,owner: "owner",name: "repo"},pages: {url: "https://owner.github.io/repo/",host: "owner.github.io"},assets: {release: "0.1.0-rc.1",releaseCommit: "4".repeat(40),script: new Uint8Array([1])}},
        now: "2000-01-01T00:00:00Z",metadata: {timestamp: "2000-01-01T00:00:00Z"},prStates: new Map(),delay: () => Promise.resolve(),jitter: () => 0,signal: controller.signal,
      });} catch (error) {caught = error;}
      expect(caught).toBeInstanceOf(PublisherError); const error = caught as PublisherError;
      assertNoSecrets([String(error),JSON.stringify(error),error.stack ?? ""]); expect(error.code).toBe("admission-signal-invalid"); expect({reads,mutations}).toEqual({reads: 0,mutations: 0});
    }
  });
  it.each([false,true])("failed native listener registration leaves no callback even if remove hook throws %s", removeThrows => {
    const controller = new AbortController(); let original = 0; let failed = 0; let added = 0; let removed = 0;
    controller.signal.addEventListener("abort",() => {original++;});
    Object.defineProperty(controller.signal,hook("kNewListener"),{value() {added++; throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}});
    if (removeThrows) Object.defineProperty(controller.signal,hook("kRemoveListener"),{value() {removed++; throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}});
    let caught: unknown; try {onSignalAbort(controller.signal,() => {failed++;});} catch (error) {caught = error;}
    expect(caught).toBeInstanceOf(TypeError); const error = caught as TypeError;
    assertNoSecrets([String(error),JSON.stringify(error),error.stack ?? ""]); expect(error.cause).toBeUndefined();
    expect(added).toBe(1); expect(getEventListeners(controller.signal,"abort")).toHaveLength(1);
    if (removeThrows) expect(removed).toBe(1);
    controller.abort(); expect(original).toBe(1); expect(failed).toBe(0);
  });
  it("rejects accessor symbol state without invoking it and keeps ordinary native signal behavior", () => {
    const controller = new AbortController(); let received = 0; let accessors = 0;
    const remove = onSignalAbort(controller.signal,() => {received++;}); remove(); controller.abort(); expect(received).toBe(0); expect(isSignalAborted(controller.signal)).toBe(true);
    const other = new AbortController(); Object.defineProperty(other.signal,Symbol("poison"),{get() {accessors++; throw new Error(CANARY_TOKEN);}});
    expect(() => isSignalAborted(other.signal)).toThrow("signal-invalid"); expect(accessors).toBe(0);
  });
});

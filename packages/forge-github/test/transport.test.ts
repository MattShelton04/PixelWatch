import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { FetchTransport, ForgeError, type FetchLike } from "../src/index.ts";

describe("production fetch transport", () => {
  it("fetch and stream failures reconstruct branded errors without invoking caller diagnostic accessors", async () => {
    const canary = "FAKE_FETCH_CALLBACK_CANARY"; const signed = "https://invalid.example/file?sig=FAKE_FETCH_SIGNATURE";
    for (const stage of ["fetch", "stream"]) {
      const supplied = new ForgeError("api-refused"); let accesses = 0; let reached = 0;
      for (const name of ["code", "name", "message", "stack", "cause"]) Object.defineProperty(supplied, name, {configurable: true, get() {accesses++; return canary + signed;}});
      const fetch: FetchLike = () => {
        if (stage === "fetch") {reached++; return Promise.reject(supplied);}
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({start(controller) {reached++; controller.error(supplied);}})));
      };
      let error: unknown; try {await new FetchTransport(fetch).request({method: "GET", url: "https://invalid.example/", headers: {}, maxBytes: 4});} catch (value) {error = value;}
      expect(reached).toBe(1); expect(accesses).toBe(0); expect(error === supplied).toBe(false);
      const raw = inspect(error, {showHidden: true, depth: 8}); expect(raw.includes(canary) || raw.includes(signed)).toBe(false);
      expect(error).toBeInstanceOf(ForgeError); expect((error as ForgeError).code).toBe("api-refused"); expect(Object.hasOwn(error as object, "cause")).toBe(false);
    }
  });
  it("uses manual redirect and cancels streaming overflow rather than buffering the body", async () => {
    let cancelled = false;
    let options: RequestInit | undefined;
    const fetch: FetchLike = (_url, init) => {
      options = init;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
        cancel() { cancelled = true; },
      })));
    };
    await expect(new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: {}, maxBytes: 4 })).rejects.toMatchObject({ code: "response-too-large" });
    expect(options?.redirect).toBe("manual");
    expect(cancelled).toBe(true);
  });

  it("checks Content-Length before consuming and refuses malformed length", async () => {
    for (const length of ["5", "garbage", "-1", "9007199254740992"]) {
      const fetch: FetchLike = () => Promise.resolve(new Response(new Uint8Array(), { headers: { "content-length": length } }));
      await expect(new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: {}, maxBytes: 4 })).rejects.toBeInstanceOf(ForgeError);
    }
  });

  it("sanitizes thrown fetch and stream errors without retaining causes or canary secrets", async () => {
    const secret = "ghs_FAKE_TRANSPORT_CANARY https://blob.invalid/?sig=SIGNED_CANARY";
    const failures: FetchLike[] = [
      () => Promise.reject(new Error(secret)),
      () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        pull(controller) { controller.error(new Error(secret)); },
      }))),
    ];
    for (const fetch of failures) {
      let refusal: unknown;
      try { await new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: { authorization: secret }, maxBytes: 4 }); }
      catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(ForgeError);
      expect(String(refusal) + JSON.stringify(refusal)).not.toContain("CANARY");
      expect((refusal as Error).cause).toBeUndefined();
    }
  });

  it("returns exact bounded bytes and does not follow a redirect itself", async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 302, headers: { location: "https://blob.invalid/file" } }));
    expect(await new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: {}, maxBytes: 3 })).toEqual({ status: 302, headers: { location: "https://blob.invalid/file" }, body: new Uint8Array([1, 2, 3]) });
  });
});

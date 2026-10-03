import { describe, expect, it } from "vitest";
import { FetchTransport, ForgeError, type FetchLike } from "../src/index.ts";

describe("production fetch transport", () => {
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
    const fetch: FetchLike = () => Promise.reject(new Error(secret));
    try { await new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: { authorization: secret }, maxBytes: 4 }); } catch (error) {
      expect(error).toBeInstanceOf(ForgeError);
      expect(String(error) + JSON.stringify(error)).not.toContain("CANARY");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("returns exact bounded bytes and does not follow a redirect itself", async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 302, headers: { location: "https://blob.invalid/file" } }));
    expect(await new FetchTransport(fetch).request({ method: "GET", url: "https://api.github.com/", headers: {}, maxBytes: 3 })).toEqual({ status: 302, headers: { location: "https://blob.invalid/file" }, body: new Uint8Array([1, 2, 3]) });
  });
});

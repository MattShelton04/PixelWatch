import { ForgeError, sanitizeForgeError } from "./errors.ts";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}
export interface HttpTransport { request(request: HttpRequest): Promise<HttpResponse> }
export interface Timing {
  deadline(ms: number): { readonly signal: AbortSignal; dispose(): void };
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Production timing is replaced by virtual timing in deterministic/no-network simulations. */
export class RealTiming implements Timing {
  deadline(ms: number): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, ms);
    return { signal: controller.signal, dispose: () => { clearTimeout(timer); } };
  }
  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) { reject(new ForgeError("request-cancelled")); return; }
      const aborted = (): void => { clearTimeout(timer); reject(new ForgeError("request-cancelled")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** No redirect following and no unbounded Response.arrayBuffer() allocation. */
export class FetchTransport implements HttpTransport {
  readonly #fetch: FetchLike;
  constructor(fetch: FetchLike = globalThis.fetch) { this.#fetch = fetch; }

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) throw new ForgeError("invalid-response");
    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        redirect: "manual",
        ...(request.body === undefined ? {} : { body: new Uint8Array(request.body).buffer }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const length = response.headers.get("content-length");
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))) {
        await response.body?.cancel().catch(() => undefined);
        throw new ForgeError("invalid-response");
      }
      if (length !== null && Number(length) > request.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ForgeError("response-too-large");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader !== undefined) {
        try {
          for (;;) {
            request.signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            const value: unknown = next.value;
            if (!(value instanceof Uint8Array)) throw new ForgeError("invalid-response");
            if (value.byteLength > request.maxBytes - size) throw new ForgeError("response-too-large");
            chunks.push(value);
            size += value.byteLength;
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally { reader.releaseLock(); }
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
    } catch (error) {
      throw sanitizeForgeError(error, request.signal?.aborted === true ? "request-cancelled" : "request-failed");
    }
  }
}

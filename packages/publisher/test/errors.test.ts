import { inspect } from "node:util";
import { expect, it } from "vitest";
import { guarded, PublisherError, sanitizePublisherError } from "../src/types.ts";

const canary = "FAKE_PUBLISHER_ERROR_CANARY";
const signed = "https://invalid.example/file?sig=FAKE_PUBLISHER_SIGNATURE";
async function caught(operation: () => Promise<unknown>): Promise<unknown> {
  try { await guarded(operation); } catch (error) { return error; }
  throw new Error("expected refusal");
}
function safe(error: unknown): void {
  const raw = inspect(error, {showHidden: true, depth: 8});
  expect(raw.includes(canary) || raw.includes(signed)).toBe(false);
  expect(error).toBeInstanceOf(PublisherError);
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

it("publisher rejects arbitrary branded diagnostic codes without retaining callback text", async () => {
  const supplied = new PublisherError(canary + signed);
  const error = await caught(() => Promise.reject(supplied));
  safe(error); expect(error === supplied).toBe(false);
  expect((error as PublisherError).code).toBe("publisher-operation-failed");
});

it("publisher reconstructs known diagnostic codes without mutable message stack cause or accessor aliases", async () => {
  const supplied = new PublisherError("invalid-commit"); let reads = 0;
  for (const name of ["message", "stack", "cause", "code", "name"]) {
    Object.defineProperty(supplied, name, {configurable: true, get() { reads++; return canary + signed; }});
  }
  const error = await caught(() => Promise.reject(supplied));
  safe(error); expect(reads).toBe(0); expect(error === supplied).toBe(false);
  expect((error as PublisherError).code).toBe("invalid-commit");
});

it("publisher does not trust diagnostic fields inherited through error prototypes", async () => {
  const supplied = Object.create(PublisherError.prototype) as PublisherError;
  Object.defineProperty(supplied, "code", {get() { throw new Error(canary + signed); }});
  const error = await caught(() => Promise.reject(supplied));
  safe(error); expect((error as PublisherError).code).toBe("publisher-operation-failed");
});

it("publisher reconstructs only fixed fallback codes and never retains fallback text", () => {
  const error = sanitizePublisherError({}, canary + signed);
  safe(error); expect(error.code).toBe("publisher-operation-failed");
});

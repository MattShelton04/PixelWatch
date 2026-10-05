import { types } from "node:util";
import { ForgeError, LIMITS, sanitizeForgeError } from "./errors.ts";
import type { HttpResponse } from "./transport.ts";

const signalPrototype = AbortSignal.prototype;
const nativeState = Object.getOwnPropertySymbols(new AbortController().signal).find(key => key.description === "kAborted");
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native getter is invoked with Reflect.apply.
const abortedGetter = Object.getOwnPropertyDescriptor(signalPrototype, "aborted")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native methods are invoked with Reflect.apply and an owned receiver.
const addListener = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native methods are invoked with Reflect.apply and an owned receiver.
const removeListener = EventTarget.prototype.removeEventListener;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native getter is invoked with Reflect.apply.
const nativeLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native getter is invoked with Reflect.apply.
const nativeBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native getter is invoked with Reflect.apply.
const nativeTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- The native byte copy ignores callback-owned methods, species and iterators.
const copyBytes = Uint8Array.prototype.set;

/** Only in-process native signals qualify; own string overrides are never consulted. */
export function signalAborted(signal: unknown): boolean {
  try {
    if (typeof signal !== "object" || signal === null || types.isProxy(signal)
      || Object.getPrototypeOf(signal) !== signalPrototype || nativeState === undefined || abortedGetter === undefined
      || typeof Object.getOwnPropertyDescriptor(signal, nativeState)?.value !== "boolean") throw new ForgeError("invalid-response");
    for (const key of Object.getOwnPropertySymbols(signal)) {
      const descriptor = Object.getOwnPropertyDescriptor(signal, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new ForgeError("invalid-response");
    }
    const value: unknown = Reflect.apply(abortedGetter, signal, []);
    if (typeof value !== "boolean") throw new ForgeError("invalid-response");
    return value;
  } catch {throw new ForgeError("request-failed");}
}
export function watchSignal(signal: AbortSignal, listener: () => void): () => void {
  signalAborted(signal);
  // Node's automatic once removal runs a foreign native hook before the callback. Manual
  // unlinking lets the callback settle first and turns removal failures into fixed diagnostics.
  try {Reflect.apply(addListener, signal, ["abort", listener]);} catch {
    // Node can insert the callback before its listener hook throws.
    try {Reflect.apply(removeListener, signal, ["abort", listener]);} catch { /* Native unlink precedes its hook. */ }
    throw new ForgeError("request-failed");
  }
  return () => {try {Reflect.apply(removeListener, signal, ["abort", listener]);} catch {throw new ForgeError("request-failed");}};
}

/** Capture the response tuple and native bytes in the fulfillment callback, before another await. */
export function ownResponse(supplied: unknown): HttpResponse {
  try {
    if (typeof supplied !== "object" || supplied === null || types.isProxy(supplied)) throw new ForgeError("invalid-response");
    const value = supplied as HttpResponse;
    const status = value.status;
    const suppliedHeaders: unknown = value.headers;
    const suppliedBody: unknown = value.body;
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new ForgeError("invalid-response");
    if (typeof suppliedBody !== "object" || suppliedBody === null || types.isProxy(suppliedBody)
      || nativeTag === undefined || nativeLength === undefined || nativeBuffer === undefined
      || Reflect.apply(nativeTag, suppliedBody, []) !== "Uint8Array") throw new ForgeError("invalid-response");
    const length: unknown = Reflect.apply(nativeLength, suppliedBody, []);
    const buffer: unknown = Reflect.apply(nativeBuffer, suppliedBody, []);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || types.isSharedArrayBuffer(buffer)) throw new ForgeError("invalid-response");
    if (length > LIMITS.maxJsonBytes) throw new ForgeError("response-too-large");
    const body = new Uint8Array(length);
    Reflect.apply(copyBytes, body, [suppliedBody]);
    if (typeof suppliedHeaders !== "object" || suppliedHeaders === null || types.isProxy(suppliedHeaders)
      || Array.isArray(suppliedHeaders)) throw new ForgeError("invalid-response");
    const keys = Object.keys(suppliedHeaders);
    if (keys.length > 128) throw new ForgeError("invalid-response");
    const headers: Record<string, string> = Object.create(null) as Record<string, string>;
    let headerBytes = 0;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(suppliedHeaders, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string"
        || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key) || !/^[\x20-\x7e]*$/.test(descriptor.value)) throw new ForgeError("invalid-response");
      const normalized = key.toLowerCase();
      if (Object.hasOwn(headers, normalized)) throw new ForgeError("invalid-response");
      headerBytes += key.length + descriptor.value.length;
      if (headerBytes > 16_384) throw new ForgeError("invalid-response");
      headers[normalized] = descriptor.value;
    }
    const contentLength = headers["content-length"];
    if (contentLength !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) throw new ForgeError("invalid-response");
      if (Number(contentLength) > LIMITS.maxJsonBytes) throw new ForgeError("response-too-large");
    }
    return Object.freeze({status, headers: Object.freeze(headers), body});
  } catch (error) {
    throw sanitizeForgeError(error, "invalid-response");
  }
}

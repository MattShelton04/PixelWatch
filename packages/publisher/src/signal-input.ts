import { types } from "node:util";

const prototype = AbortSignal.prototype;
// Pinned Node stores this boolean under a private own symbol; its getter coerces forged values.
const nativeState = Object.getOwnPropertySymbols(new AbortController().signal).find(key => key.description === "kAborted");
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds captured intrinsics to the checked in-process signal.
const nativeAborted = Object.getOwnPropertyDescriptor(prototype, "aborted")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the EventTarget intrinsic to the checked signal.
const nativeAdd = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the EventTarget intrinsic to the checked signal.
const nativeRemove = EventTarget.prototype.removeEventListener;
const invalid = (): never => {throw new TypeError("pixelwatch-publisher: signal-invalid");};

/** Trusted adapters supply in-process AbortController signals. Node's getter alone accepts proxies/shapes. */
export function isSignalAborted(signal: unknown): boolean {
  try {
    if (typeof signal !== "object" || signal === null || types.isProxy(signal)
      || Object.getPrototypeOf(signal) !== prototype || nativeAborted === undefined) return invalid();
    if (nativeState === undefined || typeof Object.getOwnPropertyDescriptor(signal,nativeState)?.value !== "boolean") return invalid();
    // Node stores state under own symbols; refuse accessors before its getter can execute one.
    for (const key of Object.getOwnPropertySymbols(signal)) {
      const descriptor = Object.getOwnPropertyDescriptor(signal, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return invalid();
    }
    const value: unknown = Reflect.apply(nativeAborted, signal, []);
    if (typeof value !== "boolean") return invalid();
    return value;
  } catch {return invalid();}
}
export function onSignalAbort(signal: AbortSignal, listener: () => void): () => void {
  isSignalAborted(signal);
  try {Reflect.apply(nativeAdd, signal, ["abort", listener, {once: true}]);} catch {
    // EventTarget can insert before a native listener hook throws. Remove the exact callback
    // even when registration reported failure; a throwing removal hook must not expose raw data.
    try {Reflect.apply(nativeRemove, signal, ["abort", listener]);} catch { /* Native unlink precedes its hook. */ }
    return invalid();
  }
  return () => {try {Reflect.apply(nativeRemove, signal, ["abort", listener]);} catch {return invalid();}};
}

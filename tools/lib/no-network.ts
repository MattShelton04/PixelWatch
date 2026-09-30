// Vitest setup file: `pnpm check` must not touch the network (07 §1). Any connection that isn't
// loopback or local IPC throws, so a test that silently depends on the network fails loudly.
import dns from "node:dns";
import net from "node:net";

export class NetworkDisabledError extends Error {
  constructor(target: string) {
    super(`network access is disabled in tests (pnpm check): ${target}`);
    this.name = "NetworkDisabledError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Returns the remote host a `Socket#connect` call targets, or undefined for IPC paths. */
function connectTarget(args: unknown[]): string | undefined {
  // net.connect()/tls.connect() pass pre-normalized arguments as a single [options, callback] array.
  const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === "string") return undefined;
    return typeof options.host === "string" ? options.host : "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined; // IPC path
  return typeof second === "string" ? second : "localhost";
}

// eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied below with the socket as `this`
const originalConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function guardedConnect(
  this: net.Socket,
  ...args: unknown[]
): net.Socket {
  const host = connectTarget(args);
  if (host !== undefined && !isLoopback(host)) throw new NetworkDisabledError(host);
  return originalConnect.apply(this, args);
};

const originalLookup = dns.lookup;
const originalPromisesLookup = dns.promises.lookup;
dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
  if (!isLoopback(hostname)) throw new NetworkDisabledError(`dns lookup ${hostname}`);
  return (originalLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
} as typeof dns.lookup;
dns.promises.lookup = function guardedPromisesLookup(hostname: string, ...rest: unknown[]) {
  if (!isLoopback(hostname)) {
    return Promise.reject(new NetworkDisabledError(`dns lookup ${hostname}`));
  }
  return (originalPromisesLookup as (...a: unknown[]) => Promise<unknown>)(hostname, ...rest);
} as typeof dns.promises.lookup;

globalThis.fetch = (input: unknown) =>
  Promise.reject(
    new NetworkDisabledError(`fetch ${input instanceof Request ? input.url : String(input)}`),
  );

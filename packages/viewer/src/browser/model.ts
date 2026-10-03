import { parseViewerDocument } from "@pixelwatch/schemas/browser";
import type { CapturedSide, Changes, Site } from "@pixelwatch/schemas";

const RELEASE = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})(?:-[0-9A-Za-z.]{1,32})?$/;
const GITHUB_ID = /^[1-9][0-9]{0,18}$/;
const RUN_KEY = /^(?:[1-9][0-9]{0,18}-a[1-9][0-9]{0,18}|import-[a-f0-9]{64})$/;
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}$/;
const MAX_JSON_BYTES = 1024 * 1024;

export interface ViewerBootstrap { readonly canonicalBase: string; readonly observedBase: string; readonly release: string; readonly repositoryId: string; readonly owner: string; readonly repo: string; readonly runKey?: string }
export interface ViewerClock { deadline(milliseconds: number): { readonly signal: AbortSignal; dispose(): void } }
export interface ViewerDependencies { readonly fetch: typeof fetch; readonly clock: ViewerClock }
export interface ViewerModel { readonly site: Site; readonly changes?: Changes }
function fail(): never { throw new Error("PixelWatch viewer: unavailable or incompatible report"); }

function plainPath(path: string): boolean {
  if (path === "/") return true;
  return path.startsWith("/") && path.endsWith("/") && path.slice(1, -1).split("/").every((part) => SEGMENT.test(part) && part !== "." && part !== "..");
}
function url(value: string): URL {
  try {
    const parsed = new URL(value);
    if (value.length > 2048 || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.href !== value || /[^\x21-\x7e]|[\\%]/.test(value)) fail();
    return parsed;
  } catch { return fail(); }
}

/** Bootstrap comes only from generated markup and is still fully checked before a request. */
export function readBootstrap(markers: Readonly<Record<string, string | undefined>>, observedHref: string, compiledRelease: string): ViewerBootstrap {
  const canonicalBase = markers["pwSite"]; const release = markers["pwRelease"]; const repositoryId = markers["pwRepositoryId"];
  const owner = markers["pwOwner"]; const repo = markers["pwRepo"]; const runKey = markers["pwRunKey"];
  if (canonicalBase === undefined || release === undefined || repositoryId === undefined || owner === undefined || repo === undefined
    || !RELEASE.test(compiledRelease) || release !== compiledRelease || !GITHUB_ID.test(repositoryId)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".."
    || (runKey !== undefined && !RUN_KEY.test(runKey))) fail();
  const canonical = url(canonicalBase);
  if (canonical.protocol !== "https:" || canonical.port !== "" || canonical.hash !== "" || canonical.pathname === "/" || !plainPath(canonical.pathname)
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(canonical.hostname)) fail();
  const observed = url(observedHref);
  if (observed.hash !== "") observed.hash = ""; // M2 does not interpret in-run fragment state.
  let path = observed.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
  if (!plainPath(path)) fail();
  if (runKey !== undefined) { const suffix = `runs/${runKey}/`; if (!path.endsWith(suffix)) fail(); path = path.slice(0, -suffix.length); }
  if (!plainPath(path)) fail();
  const observedBase = `${observed.origin}${path}`;
  const loopback = observed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(observed.hostname);
  if (!loopback && observedBase !== canonicalBase) fail();
  return { canonicalBase, observedBase, release, repositoryId, owner, repo, ...(runKey === undefined ? {} : { runKey }) };
}

/** Fixed generated path only; data cannot choose a fetch destination. */
async function readJson(target: string, dependencies: ViewerDependencies): Promise<Uint8Array> {
  const deadline = dependencies.clock.deadline(60_000); const signal = deadline.signal;
  let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { listener = () => { reject(new Error("PixelWatch viewer: unavailable or incompatible report")); }; signal.addEventListener("abort", listener, { once: true }); });
  const race = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
  try {
    if (signal.aborted) fail();
    response = await race(dependencies.fetch(target, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-cache", signal }));
    if (response.status !== 200 || response.body === null) fail();
    const size = response.headers.get("content-length");
    if (size !== null && (!/^(?:0|[1-9][0-9]*)$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > MAX_JSON_BYTES)) fail();
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const part = await race(reader.read()); if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > MAX_JSON_BYTES - total) fail();
      chunks.push(Uint8Array.from(part.value)); total += part.value.byteLength;
    }
    const bytes = new Uint8Array(total); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; } return bytes;
  } catch { return fail(); }
  finally {
    // Cancellation precedes deadline disposal for refused, overflowing and interrupted bodies.
    const stop = reader !== undefined ? reader.cancel() : response?.body?.cancel();
    if (stop !== undefined) await Promise.race([stop.catch(() => {}), cancelled.catch(() => {})]);
    reader?.releaseLock();
    if (listener !== undefined) signal.removeEventListener("abort", listener); deadline.dispose();
  }
}

export async function loadViewerModel(callerBootstrap: ViewerBootstrap, dependencies: ViewerDependencies): Promise<ViewerModel> {
  try {
    const bootstrap = { ...callerBootstrap }; const fetch = dependencies.fetch; const deadline = dependencies.clock.deadline.bind(dependencies.clock);
    const fixed = { fetch, clock: { deadline } };
    const checkedSite = parseViewerDocument("site", await readJson(`${bootstrap.observedBase}site.json`, fixed));
    if (!checkedSite.ok) fail(); const site = checkedSite.value;
    if (site.repositoryId !== bootstrap.repositoryId || site.versions.release !== bootstrap.release || !bootstrap.canonicalBase.endsWith(`/${site.basePath}/`)) fail();
    if (bootstrap.runKey === undefined) return { site };
    const checkedChanges = parseViewerDocument("changes", await readJson(`${bootstrap.observedBase}api/v1/runs/${bootstrap.runKey}/changes.json`, fixed));
    if (!checkedChanges.ok) fail(); const changes = checkedChanges.value;
    if (changes.source.repositoryId !== bootstrap.repositoryId || changes.runKey !== bootstrap.runKey) fail();
    // Refuse a poisoned image namespace before any pair can be rendered or fetched.
    for (const result of changes.results) for (const side of ["base", "head"] as const) {
      const value = result[side]; if (value.state === "captured") imageUrl(bootstrap, value, result.images?.[side]);
    }
    return { site, changes };
  } catch { return fail(); }
}

export function imageUrl(bootstrap: ViewerBootstrap, side: CapturedSide, claimedUrl: string | undefined): string | undefined {
  if (claimedUrl === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(side.pixelHash)) fail();
  const path = `blobs/${side.pixelHash.slice(0, 2)}/${side.pixelHash}.png`;
  if (claimedUrl !== `${bootstrap.canonicalBase}${path}`) fail();
  return `${bootstrap.observedBase}${path}`;
}

export const browserDependencies: ViewerDependencies = { fetch: (value, options) => globalThis.fetch(value, options), clock: { deadline: (milliseconds) => {
  const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, milliseconds);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); } };
} } };

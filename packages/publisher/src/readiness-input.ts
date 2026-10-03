import { createHash } from "node:crypto";
import { API_INDEX, API_SCHEMA_KINDS, LLMS_TXT, PROJECTION_VERSION, apiSchemaPath, appScriptPath, classifyStorePath, generationId, prPointerPath, siteLocation, siteUrls, sizeLimits, type SiteCategory } from "@pixelwatch/core";
import { isGitHubId, parseDocument, parseRunKey, type PrPointer, type Site } from "@pixelwatch/schemas";
import { STORE_LIMITS } from "@pixelwatch/store";
import type { HttpRequest, HttpResponse } from "@pixelwatch/forge-github";
import { captureContext, checkedOid, copyBytes, JSON_BYTES } from "./assembly-input.ts";
import { refuse, type AssembledFile, type ReadinessDependencies, type ReadinessInput, type ReadinessPoll, type ReadinessTarget } from "./types.ts";
import { isSignalAborted, onSignalAbort } from "./signal-input.ts";

// A store has at most maxFiles paths. A run adds at most two generated paths (API/HTML);
// site@1 has at most1001 streams plus1000 pointers; sixteen bounds all fixed files.
// This bounds metadata capture without incorrectly applying the store bound to its served tree.
export const MAX_ASSEMBLED_FILES = 3 * STORE_LIMITS.maxFiles + 2 * 1001 + 16;
const MAX_TARGETS = 1000;
const HASH = /^[0-9a-f]{64}$/;
export const isAborted = isSignalAborted;
export const onAbort = onSignalAbort;
export interface ExpectedBody {
  readonly kind: "site" | "pr-pointer";
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly target?: ReadinessTarget;
}
export interface CapturedReadiness {
  readonly generation: string;
  readonly repositoryId: string;
  readonly prefix: string;
  readonly release: string;
  readonly expected: readonly ExpectedBody[];
  readonly signal?: AbortSignal;
  readonly request: (request: HttpRequest) => Promise<HttpResponse>;
  readonly deadline: (milliseconds: number) => {readonly signal: AbortSignal; dispose(): void};
  readonly delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly checkpoint?: (poll: ReadinessPoll) => Promise<void>;
}
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function ownTarget(target: ReadinessTarget): ReadinessTarget {
  const prNumber = target.prNumber; const runKey = target.runKey; const headSha = target.headSha;
  if (!isGitHubId(prNumber) || typeof runKey !== "string" || parseRunKey(runKey) === undefined) refuse("readiness-input-invalid");
  checkedOid(headSha);
  return {prNumber, runKey, headSha};
}
function ownership(path: string, release: string): {category: SiteCategory; immutable: boolean} | undefined {
  if (path === "index.html") return {category: "html", immutable: false};
  if (path === appScriptPath(release)) return {category: "app", immutable: true};
  if (path === "site.json") return {category: "data", immutable: false};
  if (path === API_INDEX || path === LLMS_TXT || API_SCHEMA_KINDS.some(kind => path === apiSchemaPath(kind))) return {category: "api", immutable: false};
  const stored = classifyStorePath(path);
  if (stored?.kind === "run") return {category: "data", immutable: true};
  if (stored?.kind === "blob") return {category: "blobs", immutable: true};
  if (stored?.kind === "derived") return {category: "derived", immutable: true};
  const stream = /^data\/v1\/streams\/(main|pr-([1-9][0-9]{0,18}))\.json$/.exec(path);
  if (stream !== null && (stream[1] === "main" || isGitHubId(stream[2] ?? ""))) return {category: "data", immutable: false};
  const pointer = /^api\/v1\/pr\/([1-9][0-9]{0,18})\/latest\.json$/.exec(path);
  if (pointer !== null && isGitHubId(pointer[1] ?? "")) return {category: "api", immutable: false};
  const changes = /^api\/v1\/runs\/([^/]+)\/changes\.json$/.exec(path);
  if (changes !== null && parseRunKey(changes[1] ?? "") !== undefined) return {category: "api", immutable: true};
  const entry = /^runs\/([^/]+)\/index\.html$/.exec(path);
  if (entry !== null && parseRunKey(entry[1] ?? "") !== undefined) return {category: "stubs", immutable: false};
  return undefined;
}
export function siteMatches(value: Site, captured: Pick<CapturedReadiness, "generation" | "repositoryId" | "prefix" | "release">): boolean {
  return value.repositoryId === captured.repositoryId && value.basePath === captured.prefix && value.versions.release === captured.release;
}
export function pointerMatches(value: PrPointer, target: ReadinessTarget): boolean {
  return value.prNumber === target.prNumber && value.runKey === target.runKey && value.headSha === target.headSha;
}
/** Capture trusted context assets and selected JSON bodies; nonselected site file bodies stay unused. */
export function captureReadiness(input: ReadinessInput, dependencies: ReadinessDependencies): CapturedReadiness {
  try {
    const sourceContext = input.context; const sourceSite = input.site; const sourceTargets = input.targets; const signal = input.signal;
    const sourceTransport = dependencies.transport; const sourceTiming = dependencies.timing;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured ports are invoked below with their original receiver through Reflect.apply.
    const request = sourceTransport.request;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured ports are invoked below with their original receiver through Reflect.apply.
    const deadline = sourceTiming.deadline;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured ports are invoked below with their original receiver through Reflect.apply.
    const delay = sourceTiming.delay;
    const now = dependencies.now; const checkpoint = dependencies.checkpoint;
    if (typeof request !== "function" || typeof deadline !== "function" || typeof delay !== "function" || typeof now !== "function" || (checkpoint !== undefined && typeof checkpoint !== "function")) refuse("readiness-input-invalid");
    if (signal !== undefined) isAborted(signal);
    const context = captureContext(sourceContext);
    const storeTip = checkedOid(sourceSite.storeTip); const configCommit = checkedOid(sourceSite.configCommit); const releaseCommit = checkedOid(sourceSite.releaseCommit);
    const generation = sourceSite.generation;
    if (typeof generation !== "string" || !HASH.test(generation) || configCommit !== context.configCommit || releaseCommit !== context.assets.releaseCommit
      || generation !== generationId({storeTip, configCommit, releaseCommit, projectionVersion: PROJECTION_VERSION})) refuse("readiness-input-invalid");
    const urls = siteUrls(siteLocation(context.config, context.pages));
    const count = sourceTargets.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TARGETS) refuse("readiness-input-invalid");
    const targets = new Map<string, ReadinessTarget>();
    for (let index = 0; index < count; index++) {
      const source = sourceTargets[index]; if (source === undefined) refuse("readiness-input-invalid");
      const target = ownTarget(source); if (targets.has(target.prNumber)) refuse("readiness-input-invalid"); targets.set(target.prNumber, target);
    }
    const selected = new Set(["site.json", ...[...targets.keys()].map(prPointerPath)]);
    const expected = new Map<string, ExpectedBody>(); const occupied = new Set<string>();
    const hardBytes = sizeLimits(context.config).hardBytes; let selectedBytes = 0;
    const sourceFiles = sourceSite.files; const fileCount = sourceFiles.length;
    if (!Number.isSafeInteger(fileCount) || fileCount < 1 || fileCount > MAX_ASSEMBLED_FILES) refuse("readiness-input-invalid");
    for (let index = 0; index < fileCount; index++) {
      const file = sourceFiles[index] as AssembledFile | null | undefined; if (file === undefined || file === null || typeof file !== "object") refuse("readiness-input-invalid");
      const path = file.path; const category = file.category; const immutable = file.immutable;
      if (typeof path !== "string" || occupied.has(path)) refuse("readiness-input-invalid");
      const owned = ownership(path, context.assets.release);
      if (owned === undefined || owned.category !== category || owned.immutable !== immutable) refuse("readiness-input-invalid");
      occupied.add(path);
      if (!selected.has(path)) continue;
      const supplied = file.bytes; const digest = file.sha256;
      // Copies themselves stay within the existing configured site budget, even if a caller
      // substitutes large valid JSON bodies into an otherwise well-shaped assembled descriptor.
      const bytes = copyBytes(supplied, Math.min(JSON_BYTES, hardBytes - selectedBytes));
      selectedBytes += bytes.byteLength;
      if (typeof digest !== "string" || !HASH.test(digest) || sha256(bytes) !== digest) refuse("readiness-input-invalid");
      const target = [...targets.values()].find(item => path === prPointerPath(item.prNumber));
      expected.set(path, {kind: path === "site.json" ? "site" : "pr-pointer", url: urls.url(path), bytes, sha256: digest, ...(target === undefined ? {} : {target})});
    }
    const siteBody = expected.get("site.json"); if (siteBody === undefined) refuse("readiness-input-invalid");
    const parsedSite = parseDocument("site", siteBody.bytes);
    const identity = {generation, repositoryId: context.repository.repositoryId, prefix: urls.prefix, release: context.assets.release};
    if (!parsedSite.ok || !siteMatches(parsedSite.value, identity) || parsedSite.value.generation !== generation) refuse("readiness-input-invalid");
    const bodies = [siteBody];
    for (const target of targets.values()) {
      const body = expected.get(prPointerPath(target.prNumber)); if (body === undefined) refuse("readiness-input-invalid");
      const parsed = parseDocument("pr-pointer", body.bytes);
      if (!parsed.ok || !pointerMatches(parsed.value, target) || parsed.value.generation !== generation
        || !parsedSite.value.streams.some(stream => stream.streamId === "pr-" + target.prNumber && stream.latest === target.runKey)) refuse("readiness-input-invalid");
      bodies.push(body);
    }
    return {...identity, expected: bodies, ...(signal === undefined ? {} : {signal}),
      request: (value) => Reflect.apply<typeof sourceTransport, [HttpRequest], Promise<HttpResponse>>(request, sourceTransport, [value]),
      deadline: (milliseconds) => Reflect.apply<typeof sourceTiming, [number], ReturnType<typeof deadline>>(deadline, sourceTiming, [milliseconds]),
      delay: (milliseconds, scope) => Reflect.apply<typeof sourceTiming, [number, AbortSignal | undefined], Promise<void>>(delay, sourceTiming, [milliseconds, scope]),
      now: () => Reflect.apply<typeof dependencies, [], number>(now, dependencies, []),
      ...(checkpoint === undefined ? {} : {checkpoint: (poll: ReadinessPoll) => Reflect.apply<typeof dependencies, [ReadinessPoll], Promise<void>>(checkpoint, dependencies, [poll])})};
  } catch {
    // No parser, accessor, context or branded foreign error text escapes input authentication.
    return refuse("readiness-input-invalid");
  }
}

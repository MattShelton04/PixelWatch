import { appScriptPath, classifyStorePath, projectChanges, readStoreTree, siteLocation, siteUrls, sizeLimits, type ProjectionInput, type StoreGraph, type StoreTree } from "@pixelwatch/core";
import { canonicalBytes, isGitHubId, parseDocument, type DocumentKind, type DocumentTypes, type Run, type Store } from "@pixelwatch/schemas";
import { STORE_LIMITS } from "@pixelwatch/store";
import { renderEntry } from "@pixelwatch/viewer";
import { refuse, sanitizePublisherError, type PublisherContext } from "./types.ts";

export const JSON_BYTES = 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds this intrinsic getter to the supplied native view.
const nativeLength = Object.getOwnPropertyDescriptor(typedArrayPrototype,"byteLength")?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds this intrinsic getter to the supplied native view.
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype,Symbol.toStringTag)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply always binds the private native destination.
const nativeSet = NativeUint8Array.prototype.set;
/** Copy internal native bytes, never iterable/species/property claims from a supplied view. */
export function copyBytes(supplied: Uint8Array, maxBytes: number, expectedBytes?: number): Uint8Array {
  return safely(() => {
    if (nativeLength === undefined || nativeTag === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < 0
      || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0))) refuse("byte-array-invalid");
    const tag: unknown = Reflect.apply(nativeTag,supplied,[]);
    const length: unknown = Reflect.apply(nativeLength,supplied,[]);
    if (tag !== "Uint8Array" || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) refuse("byte-array-invalid");
    if (length > maxBytes) refuse("byte-array-limit");
    if (expectedBytes !== undefined && length !== expectedBytes) refuse("stored-file-changed");
    const copied = new NativeUint8Array(length);
    Reflect.apply(nativeSet,copied,[supplied]);
    const copiedLength: unknown = Reflect.apply(nativeLength,copied,[]);
    if (copiedLength !== length || (expectedBytes !== undefined && copiedLength !== expectedBytes)) refuse("stored-file-changed");
    return copied;
  });
}
export function checkedOid(value: string): string {
  if (typeof value !== "string" || !OID.test(value)) refuse("invalid-commit");
  return value;
}
export function safely<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw sanitizePublisherError(error,"publisher-input-invalid"); }
}
export function checkedDocument<K extends DocumentKind>(kind: K, value: DocumentTypes[K]): DocumentTypes[K] {
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > JSON_BYTES) refuse("json-limit");
  const result = parseDocument(kind, bytes);
  if (!result.ok) refuse(result.issue.code === "unsupported-version" ? "unsupported-document-version" : "invalid-document");
  return result.value;
}
/** Own all trusted policy, namespace and executable bytes synchronously. */
export function captureContext(input: PublisherContext): PublisherContext {
  const config = checkedDocument("config", structuredClone(input.config));
  const configCommit = checkedOid(input.configCommit);
  const sourcePages=input.pages;const sourceRepository=input.repository;const sourceAssets=input.assets;
  const pages = { url: sourcePages.url, host: sourcePages.host };
  const repository = { repositoryId: sourceRepository.repositoryId, owner: sourceRepository.owner, name: sourceRepository.name };
  const release = sourceAssets.release; const releaseCommit = checkedOid(sourceAssets.releaseCommit);
  if (!isGitHubId(repository.repositoryId) || typeof repository.owner !== "string" || typeof repository.name !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) || repository.name === "." || repository.name === "..") refuse("repository-invalid");
  appScriptPath(release); siteUrls(siteLocation(config, pages));
  const limits = sizeLimits(config); const supplied = sourceAssets.script;
  let script: Uint8Array;
  try { script=copyBytes(supplied,limits.hardBytes); } catch(error) {
    const safe=sanitizePublisherError(error,"app-invalid");
    if(safe.code==="byte-array-limit")refuse("site-budget-refused");
    refuse("app-invalid");
  }
  if (script.byteLength === 0) refuse("app-invalid");
  return { config, configCommit, pages, repository, assets: { release, releaseCommit, script } };
}
export interface CapturedTree extends StoreTree { readonly store: Store; readonly runs: ReadonlyMap<string, Run> }
/** Complete eager graph validation precedes selection or returned-byte reads. */
export function captureTree(input: StoreTree, repositoryId: string): { tree: CapturedTree; graph: StoreGraph } {
  const store = checkedDocument("store", structuredClone(input.store));
  if (store.repositoryId !== repositoryId) refuse("repository-mismatch");
  const runs = new Map([...input.runs].map(([key, run]) => [key, checkedDocument("run", structuredClone(run))]));
  if (runs.size !== store.runs.length || store.runs.some((entry) => !runs.has(entry.runKey))) refuse("store-graph-invalid");
  const sourceFiles=input.files;const count=sourceFiles.length;
  if(!Number.isSafeInteger(count)||count<0)refuse("store-listing-invalid");
  if (count > STORE_LIMITS.maxFiles) refuse("store-files-limit");
  const files:{path:string;bytes:number}[]=[];
  for(let index=0;index<count;index++){const file=sourceFiles[index];if(file===undefined)refuse("store-listing-invalid");files.push({path:file.path,bytes:file.bytes});}
  let total = 0;
  for (const file of files) {
    const kind = typeof file.path === "string" ? classifyStorePath(file.path) : undefined;
    if (kind === undefined || kind.kind === "grace") refuse("store-path-refused");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) refuse("store-listing-invalid");
    if (file.bytes > (kind.kind === "blob" || kind.kind === "derived" ? STORE_LIMITS.maxPngBytes : JSON_BYTES)) refuse("store-file-limit");
    total += file.bytes; if (total > STORE_LIMITS.maxTreeBytes) refuse("store-tree-limit");
  }
  if (!files.some((file) => file.path === "store.json")) refuse("store-graph-invalid");
  // M2 emits only current data/v1. Grace namespaces and migrations belong to M3.
  const sourceGrace=input.grace;const sourceDerived=input.derived;
  if ((sourceGrace?.length ?? 0) !== 0) refuse("store-path-refused");
  const derived = sourceDerived === undefined ? undefined : new Map([...sourceDerived].map(([key, hashes]) => [key, [...hashes]]));
  const tree: CapturedTree = { store, runs, files, ...(derived === undefined ? {} : { derived }) };
  let graph: StoreGraph;
  try { graph = readStoreTree(tree); } catch { return refuse("store-graph-invalid"); }
  return { tree, graph };
}
export function projection(context: PublisherContext, tree: StoreTree, generation: string): ProjectionInput {
  return { config: context.config, pages: context.pages, store: tree.store, runs: tree.runs, generation, release: context.assets.release };
}
export function entryBytes(context: PublisherContext, run?: Run): Uint8Array {
  const urls = siteUrls(siteLocation(context.config, context.pages));
  return renderEntry({ urls, repository: context.repository, assets: context.assets, ...(run === undefined ? {} : { changes: projectChanges(run, urls) }) });
}

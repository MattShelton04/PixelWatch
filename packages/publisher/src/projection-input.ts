import { types } from "node:util";
import { appScriptPath, classifyStorePath } from "@pixelwatch/core";
import { isGitHubId, type Run } from "@pixelwatch/schemas";
import { STORE_LIMITS, type StoreSnapshot } from "@pixelwatch/store";
import type { DeploymentHistory, EnvironmentMetadata, HttpResponse, PullRequestMetadata, ReportJobIdentity, RepositoryMetadata, Timing } from "@pixelwatch/forge-github";
import { captureSnapshot } from "./admission-input.ts";
import { checkedDocument, checkedOid, copyBytes, JSON_BYTES } from "./assembly-input.ts";
import { isSignalAborted } from "./signal-input.ts";
import { PublisherError, refuse, sanitizePublisherError, type ProjectionPrepareInput, type ProjectionWarning } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/unbound-method -- These intrinsics are always called with their native receiver.
const nativeThen = Promise.prototype.then, nativeMapEach = Map.prototype.forEach;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the checked signal, never a supplied method.
const nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
const nativeArray=Array.isArray;
export function array(value:unknown):boolean{return nativeArray(value);}
function controls(value:string,space=false):boolean {
  for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<(space?33:32)||code===127)return true;}
  return false;
}
export function bind<Args extends unknown[], Result>(receiver: object, operation: (...args: Args) => Result): (...args: Args) => Result {
  if (typeof operation !== "function") refuse("projection-input-invalid");
  return (...args) => Reflect.apply(operation, receiver, args);
}
export function branch(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024
    || !value.isWellFormed() || controls(value,true) || /[~^:?*[\\]/.test(value) || value.includes("..") || value.includes("@{")
    || value.includes("//") || value.endsWith(".") || value.endsWith("/") || value === "@"
    || value.split("/").some(part => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))) refuse("projection-input-invalid");
  return value;
}
export function repository(value: RepositoryMetadata): RepositoryMetadata {
  const repositoryId = value.repositoryId, owner = value.owner, name = value.name, defaultBranch = branch(value.defaultBranch);
  if (!isGitHubId(repositoryId) || typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") refuse("projection-input-invalid");
  return {repositoryId, owner, name, defaultBranch};
}
export function report(value: ReportJobIdentity, defaultBranch?: string): ReportJobIdentity {
  const runId = value.runId, attempt = value.attempt, workflowPath = value.workflowPath, workflowId = value.workflowId;
  const headSha = checkedOid(value.headSha), ref = value.ref, runnerName = value.runnerName;
  if (!isGitHubId(runId) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2147483647
    || typeof workflowPath !== "string" || !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(workflowPath)
    || (workflowId !== undefined && !isGitHubId(workflowId)) || typeof ref !== "string" || !ref.startsWith("refs/heads/")
    || (defaultBranch !== undefined && ref !== `refs/heads/${defaultBranch}`) || typeof runnerName !== "string"
    || runnerName.length === 0 || runnerName.length > 1024 || !runnerName.isWellFormed() || controls(runnerName)) refuse("projection-input-invalid");
  branch(ref.slice(11));
  return {runId, attempt, workflowPath, ...(workflowId === undefined ? {} : {workflowId}), headSha, ref, runnerName};
}
export function prepareInput(value: ProjectionPrepareInput): ProjectionPrepareInput {
  const sourceRepository = value.repository, sourceAssets = value.assets;
  const owned = repository({...sourceRepository, defaultBranch:"main"});
  const release = sourceAssets.release, releaseCommit = checkedOid(sourceAssets.releaseCommit);
  appScriptPath(release);
  const script = copyBytes(sourceAssets.script, STORE_LIMITS.maxTreeBytes);
  if (script.byteLength === 0) refuse("projection-input-invalid");
  return {repository:{repositoryId:owned.repositoryId,owner:owned.owner,name:owned.name},assets:{release,releaseCommit,script},report:report(value.report)};
}
export function environment(value: EnvironmentMetadata, defaultBranch: string): EnvironmentMetadata {
  const environmentId = value.environmentId, observedBranch = value.defaultBranch;
  if (!isGitHubId(environmentId) || observedBranch !== defaultBranch) refuse("projection-pages-setup-required");
  return {environmentId, defaultBranch};
}
export function history(value: DeploymentHistory): DeploymentHistory {
  const current = value.current, deploymentId = current.deploymentId, jobId = current.jobId;
  const states = current.states, prior = value.priorDeploymentIds, complete:unknown=value.complete;
  const stateCount=states.length,priorCount=prior.length;
  if (complete !== true || !isGitHubId(deploymentId) || !isGitHubId(jobId) || !array(states)
    || !Number.isSafeInteger(stateCount) || stateCount < 1 || stateCount > 1024 || !array(prior)
    || !Number.isSafeInteger(priorCount) || priorCount < 0 || priorCount > 1024) refuse("projection-pages-setup-required");
  const copiedStates: DeploymentHistory["current"]["states"][number][] = [];
  for (let index = 0; index < stateCount; index++) {
    const state = states[index];
    if (state === undefined || !["waiting","queued","pending","in_progress","success","failure","error","inactive"].includes(state)) refuse("projection-pages-setup-required");
    copiedStates.push(state);
  }
  const priorDeploymentIds: string[] = [], seen = new Set([deploymentId]);
  for (let index = 0; index < priorCount; index++) {
    const id = prior[index]; if (id === undefined || !isGitHubId(id) || seen.has(id)) refuse("projection-pages-setup-required");
    seen.add(id); priorDeploymentIds.push(id);
  }
  return {current:{deploymentId,jobId,states:copiedStates},priorDeploymentIds,complete:true};
}
export function pullRequest(value: PullRequestMetadata, number: string): PullRequestMetadata {
  const prNumber = value.prNumber, state:unknown = value.state, headSha = value.headSha, headRepositoryId = value.headRepositoryId;
  if (prNumber !== number || !isGitHubId(prNumber) || (state !== "open" && state !== "closed")
    || typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha) || (headRepositoryId !== null && !isGitHubId(headRepositoryId))) refuse("projection-operation-failed");
  return {prNumber,state,headSha,headRepositoryId};
}
export function warnings(value: readonly ProjectionWarning[] | undefined): ProjectionWarning[] {
  if (value === undefined) return [];
  const count=value.length;
  if (!array(value) || !Number.isSafeInteger(count) || count<0 || count > 3) refuse("projection-state-invalid");
  const result: ProjectionWarning[] = [];
  for (let index = 0; index < count; index++) {
    const item = value[index];
    if (item === undefined || !["timing-disposal-failed","store-close-failed","listener-cleanup-failed"].includes(item) || result.includes(item)) refuse("projection-state-invalid");
    result.push(item);
  }
  return result;
}
export function response(value: HttpResponse): {status:number; body:Uint8Array} {
  const status = value.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) refuse("projection-site-ownership-refused");
  return {status,body:copyBytes(value.body,JSON_BYTES)};
}
export function ownSnapshot(value: StoreSnapshot, repositoryId: string): {snapshot: StoreSnapshot; read(path:string):Promise<Uint8Array>} {
  const tip = value.tip, store = checkedDocument("store",value.store), sourceRuns = value.runs, sourceFiles = value.files;
  const count=sourceFiles.length;
  if (!array(sourceFiles) || !Number.isSafeInteger(count) || count<0 || count > STORE_LIMITS.maxFiles) refuse("projection-input-invalid");
  const files: {path:string;bytes:number}[] = [];
  for (let index = 0; index < count; index++) {
    const source = sourceFiles[index]; if (source === undefined) refuse("projection-input-invalid");
    files.push({path:source.path,bytes:source.bytes});
  }
  const runs = new Map<string,Run>();
  Reflect.apply(nativeMapEach,sourceRuns,[(record:Run,key:string) => {
    if (runs.size >= STORE_LIMITS.maxFiles || typeof key !== "string") refuse("projection-input-invalid");
    runs.set(key,checkedDocument("run",record));
  }]);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- bind captures the method once and preserves this exact snapshot receiver.
  const read = bind(value,value.readFile);
  const snapshot = captureSnapshot({tip,store,runs,files,readFile:read},repositoryId);
  // The original method feeds the first private fulfillment reaction, before an async wrapper can expose mutable bytes.
  return {snapshot,read};
}
export function storedKind(path:string): boolean {const kind=classifyStorePath(path)?.kind;return kind === "run" || kind === "blob" || kind === "derived";}
export function observe(pending:Promise<unknown>):void {
  if (!types.isPromise(pending) || Object.getPrototypeOf(pending)!==Promise.prototype) refuse("projection-operation-failed");
  void Reflect.apply(nativeThen,pending,[()=>undefined,()=>undefined]);
}

/** Every foreign promise is observed; private reaction capture precedes the next await. */
export class ProjectionScope {
  readonly signal: AbortSignal;
  readonly warnings: ProjectionWarning[];
  readonly #controller = new AbortController();
  readonly #removers: (()=>void)[] = [];
  readonly #disposers: (()=>void)[] = [];
  #closed = false;
  constructor(timing: Pick<Timing,"deadline">, caller?:AbortSignal, previous:readonly ProjectionWarning[]=[]) {
    this.signal=this.#controller.signal;this.warnings=[...previous];
    try {
      if (caller !== undefined) isSignalAborted(caller);
      const handle=this.deadline(timing,600000);
      for (const source of caller === undefined ? [handle.signal] : [handle.signal,caller]) {
        this.#removers.push(this.listen(source,()=>{this.#controller.abort();}));
        if (isSignalAborted(source)) this.#controller.abort();
      }
    } catch {this.#controller.abort();this.close();refuse("projection-input-invalid");}
  }
  warning(value:ProjectionWarning):void {if (!this.warnings.includes(value)) this.warnings.push(value);}
  check():void {if (isSignalAborted(this.signal)) refuse("projection-cancelled");}
  listen(signal:AbortSignal,listener:()=>void):()=>void {
    isSignalAborted(signal);
    const remove=()=>{try {Reflect.apply(nativeRemove,signal,["abort",listener]);} catch {this.warning("listener-cleanup-failed");}};
    try {Reflect.apply(nativeAdd,signal,["abort",listener]);} catch {remove();refuse("projection-operation-failed");}
    return remove;
  }
  deadline(timing:Pick<Timing,"deadline">,milliseconds:number):{signal:AbortSignal;dispose():void} {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The captured disposer is invoked on the original handle by bind.
    const handle=timing.deadline(milliseconds), operation=bind(handle,handle.dispose);
    let closed=false;
    const dispose=()=>{if (closed) return;closed=true;try {operation();} catch {this.warning("timing-disposal-failed");}};
    this.#disposers.push(dispose);
    try {const signal=handle.signal;isSignalAborted(signal);return {signal,dispose};} catch {dispose();refuse("projection-input-invalid");}
  }
  wait<T,Owned>(operation:()=>Promise<T>,capture:(value:T)=>Owned,late?:(value:T)=>void,signal:AbortSignal=this.signal,failure?:(error:unknown)=>Error,discard?:(value:Owned)=>void,join?:(pending:Promise<T>)=>boolean):Promise<Owned> {
    return new Promise((resolve,reject)=>{
      let settled=false,ownedCompletion=false,remove=()=>{};
      const finish=(error:unknown,value?:Owned,failed=false)=>{
        if (settled) return;settled=true;remove();
        if (failed) {try {reject(failure===undefined?sanitizePublisherError(error,"projection-operation-failed"):failure(error));}catch{reject(new PublisherError("projection-operation-failed"));}}
        else resolve(value as Owned);
      };
      const aborted=()=>{
        // Only the exact current bounded production operation may deliver its received
        // outcome after abort. Its adapter still forbids new requests, guards or retries.
        if(ownedCompletion)remove();else finish(new PublisherError("projection-cancelled"),undefined,true);
      };
      try {
        this.check();if(isSignalAborted(signal))refuse("projection-cancelled");const pending=operation();
        if (!types.isPromise(pending) || Object.getPrototypeOf(pending) !== Promise.prototype) refuse("projection-operation-failed");
        ownedCompletion=join?.(pending)===true;
        Reflect.apply(nativeThen,pending,[(value:T)=>{
          if (settled) {try {late?.(value);} catch { /* Late cleanup errors cannot escape or authorize writes. */ }return;}
          try {
            const owned=capture(value);
            // A foreign getter may synchronously abort while capture acquires the resource.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- capture invokes supplied getters which can synchronously settle through abort.
            if(settled){discard?.(owned);return;}
            finish(undefined,owned);
          } catch(error) {finish(error,undefined,true);}
        },(error:unknown)=>{finish(error,undefined,true);}]);
        remove=this.listen(signal,aborted);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Native listener hooks can synchronously settle during registration.
        if (settled) remove();
        if (isSignalAborted(signal)) aborted();
      } catch(error) {finish(error,undefined,true);}
    });
  }
  close():void {
    if (this.#closed) return;this.#closed=true;
    for (const remove of this.#removers) remove();
    for (const dispose of this.#disposers) dispose();
  }
}

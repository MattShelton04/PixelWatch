import {spawnSync} from "node:child_process";
import {randomInt} from "node:crypto";
import {lstatSync,realpathSync} from "node:fs";
import {devNull} from "node:os";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {performance} from "node:perf_hooks";
import {PngWorker} from "../../../packages/core/src/index.ts";
import {GitHubClient} from "../../../packages/forge-github/src/client.ts";
import {FetchTransport,RealTiming,type HttpTransport,type Timing} from "../../../packages/forge-github/src/transport.ts";
import {GitBranchStore,type GitCheckpoint,type GitPackCheckpoint} from "../../../packages/store/src/git-branch.ts";
import {STORE_LIMITS,type StoreAdapter} from "../../../packages/store/src/types.ts";
import type {StoreDeadline,StoreTiming} from "../../../packages/store/src/transport.ts";
import type {SourceJobResult,MaintenanceResult} from "../../../packages/publisher/src/types.ts";
import {ingestJob} from "../../../packages/publisher/src/ingest-job.ts";
import {maintainStore} from "../../../packages/publisher/src/maintenance.ts";
import {readInvocation} from "./host-input.ts";
import {readBoundedFile} from "./host-files.ts";
import {collectHostPrStates,loadHostPolicy} from "./host-policy.ts";
import {readRuntimeRelease} from "./runtime-release.ts";
import {runHostStage,type HostStageOutcome} from "./host-stages.ts";

declare const __PIXELWATCH_VERSION__:string;
declare const __PIXELWATCH_SOURCE_COMMIT__:string;

/** Trusted direct-JavaScript seams. No action input or environment key selects these ports. */
export interface TrustedEntryTestPorts {
  readonly transport?:HttpTransport;
  readonly timing?:Timing;
  readonly now?:()=>string;
  readonly monotonic?:()=>number;
  readonly jitter?:(attempt:number)=>number;
  readonly signal?:AbortSignal;
  readonly testRemote?:{
    readonly root:string;
    readonly checkpoint?:(event:GitCheckpoint)=>Promise<void>;
    readonly packCheckpoint?:(event:GitPackCheckpoint)=>Promise<void>;
  };
}
export type EntryWarning="timing-disposal-failed"|"listener-cleanup-failed"|"store-close-failed"|"worker-close-failed";
export interface EntryResult {
  readonly status:"completed"|"failed";
  readonly exitCode:0|1;
  readonly code?:"entry-refused"|"dependencies-unavailable";
  readonly outcome?:HostStageOutcome;
  readonly source?:SourceJobResult;
  readonly maintenance?:MaintenanceResult;
  readonly warnings:readonly EntryWarning[];
}

const WORK_MS=600000;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Each intrinsic is rebound to its genuine native receiver below.
const addListener=EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Each intrinsic is rebound to its genuine native receiver below.
const removeListener=EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method -- The native promise observer is rebound to its owned pending operation below.
const promiseThen=Promise.prototype.then;
// eslint-disable-next-line @typescript-eslint/unbound-method -- The native getter validates the AbortSignal brand below.
const abortedGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")?.get;
function fail():never{throw new Error("pixelwatch-action: entry-refused");}
function nativeAborted(signal:AbortSignal):boolean {
  if(abortedGetter===undefined)fail();const value:unknown=Reflect.apply(abortedGetter,signal,[]);if(typeof value!=="boolean")fail();return value;
}
function fixedPath(value:string|undefined):string {
  if(typeof value!=="string"||value.length===0||value.length>4096||!value.isWellFormed()||value.includes("\0")||!isAbsolute(value))fail();return value;
}
function frozenCopy<T>(value:T):T {
  const copy=structuredClone(value);
  const freeze=(current:unknown):void=>{if(current===null||typeof current!=="object")return;for(const child of Object.values(current))freeze(child);Object.freeze(current);};
  freeze(copy);return copy;
}
interface CapturedPorts {
  readonly timing:Timing;
  readonly transport:HttpTransport;
  readonly now:()=>string;
  readonly monotonic:()=>number;
  readonly jitter:(attempt:number)=>number;
  readonly signal:AbortSignal|undefined;
  readonly remote:TrustedEntryTestPorts["testRemote"];
}
function capturePorts(trusted:TrustedEntryTestPorts|undefined):CapturedPorts {
  const timing=trusted?.timing??new RealTiming(),transport=trusted?.transport??new FetchTransport();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured methods are bound to the same trusted port instance.
  const deadline=timing.deadline;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured methods are bound to the same trusted port instance.
  const delay=timing.delay;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured methods are bound to the same trusted port instance.
  const request=transport.request;
  if(typeof deadline!=="function"||typeof delay!=="function"||typeof request!=="function")fail();
  const now=trusted?.now??(()=>new Date().toISOString().replace(/\.\d{3}Z$/,"Z")),monotonic=trusted?.monotonic??(()=>performance.now()),jitter=trusted?.jitter??(()=>randomInt(0,1001)),signal=trusted?.signal,remote=trusted?.testRemote;
  if(typeof now!=="function"||typeof monotonic!=="function"||typeof jitter!=="function")fail();
  const root=remote?.root,checkpoint=remote?.checkpoint,packCheckpoint=remote?.packCheckpoint;
  if(remote!==undefined&&(typeof root!=="string"||(checkpoint!==undefined&&typeof checkpoint!=="function")||(packCheckpoint!==undefined&&typeof packCheckpoint!=="function")))fail();
  const capturedRemote=remote===undefined?undefined:Object.freeze({root:root??fail(),...(checkpoint===undefined?{}:{checkpoint:(event:GitCheckpoint)=>Reflect.apply<NonNullable<TrustedEntryTestPorts["testRemote"]>,[GitCheckpoint],Promise<void>>(checkpoint,remote,[event])}),...(packCheckpoint===undefined?{}:{packCheckpoint:(event:GitPackCheckpoint)=>Reflect.apply<NonNullable<TrustedEntryTestPorts["testRemote"]>,[GitPackCheckpoint],Promise<void>>(packCheckpoint,remote,[event])})});
  return {timing:{deadline:ms=>Reflect.apply<Timing,[number],ReturnType<Timing["deadline"]>>(deadline,timing,[ms]),delay:(ms,active)=>Reflect.apply<Timing,[number,AbortSignal|undefined],Promise<void>>(delay,timing,[ms,active])},
    transport:{request:call=>Reflect.apply<HttpTransport,Parameters<HttpTransport["request"]>,ReturnType<HttpTransport["request"]>>(request,transport,[call])},now,monotonic,jitter,signal,remote:capturedRemote};
}
/** Entry owns this deadline. Producer deadlines borrow its signal, never a new work budget. */
class WorkScope {
  readonly signal:AbortSignal;
  readonly #controller=new AbortController();
  readonly #clock:()=>number;
  readonly #timing:Timing;
  readonly #caller:AbortSignal|undefined;
  readonly #warnings:Set<EntryWarning>;
  readonly #unlink:(()=>void)[]=[];
  #dispose:(()=>void)|undefined;
  #started=0;
  constructor(ports:CapturedPorts,warnings:Set<EntryWarning>){this.signal=this.#controller.signal;this.#clock=ports.monotonic;this.#timing=ports.timing;this.#caller=ports.signal;this.#warnings=warnings;}
  start():void {
    this.#started=this.#clock();if(!Number.isFinite(this.#started)||this.#started<0)fail();
    const deadline=this.#timing.deadline(WORK_MS);
    // Own the disposer before any later deadline field or caller listener can refuse.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the same acquired deadline below.
    const dispose=deadline.dispose;if(typeof dispose!=="function")fail();this.#dispose=()=>{Reflect.apply(dispose,deadline,[]);};
    const sources=this.#caller===undefined?[deadline.signal]:[deadline.signal,this.#caller];
    for(const source of sources){
      const cancel=()=>{this.#controller.abort();};
      if(nativeAborted(source)){cancel();continue;}
      this.#unlink.push(()=>{Reflect.apply(removeListener,source,["abort",cancel]);});
      Reflect.apply(addListener,source,["abort",cancel]);if(nativeAborted(source))cancel();
    }
    this.check();
  }
  check():void {
    const now=this.#clock();if(!Number.isFinite(now)||now<this.#started||now-this.#started>=WORK_MS){this.#controller.abort();fail();}
    if(nativeAborted(this.signal))fail();
  }
  borrowedDeadline(ms:number):ReturnType<Timing["deadline"]>{if(ms!==WORK_MS)fail();this.check();return {signal:this.signal,dispose(){/* The entry alone owns the acquired deadline. */}};}
  /** Normal native packs share the outer cancellation signal for their complete body
   * lifetime. A sent unknown receipt alone can authorize one original bounded read. */
  packDeadline(timing:Timing,recovery:boolean):StoreDeadline {
    if(!recovery)this.check();
    const deadline=timing.deadline(STORE_LIMITS.processTimeoutMs),controller=new AbortController(),unlink:(()=>void)[]=[];
    let rawDispose:(()=>void)|undefined,disposed=false;
    const dispose=():void=>{
      if(disposed)return;disposed=true;let failed=false;
      for(const remove of unlink){try{remove();}catch{failed=true;this.#warnings.add("listener-cleanup-failed");}}
      try{rawDispose?.();}catch{failed=true;this.#warnings.add("timing-disposal-failed");}
      if(failed)fail();
    };
    try{
      // Acquire disposal before the port's signal field or native listener hooks.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to this same acquired deadline below.
      const operation=deadline.dispose;if(typeof operation!=="function")fail();rawDispose=()=>{Reflect.apply(operation,deadline,[]);};
      const rawSignal=deadline.signal,sources=recovery?[rawSignal]:[rawSignal,this.signal];
      for(const source of sources){
        const cancel=()=>{controller.abort();};
        if(nativeAborted(source)){cancel();continue;}
        unlink.push(()=>{Reflect.apply(removeListener,source,["abort",cancel]);});
        Reflect.apply(addListener,source,["abort",cancel]);if(nativeAborted(source))cancel();
      }
      if(!recovery)this.check();
      return {signal:controller.signal,dispose};
    }catch{
      controller.abort();try{dispose();}catch{/* Every acquired cleanup step was attempted above. */}fail();
    }
  }
  /** Interrupt only pre-admission acquisition or checkpoint waits. Keep observing the
   * native operation; finally joins store.close, and sent-CAS recovery is never raced. */
  wait<T>(pending:Promise<T>):Promise<T> {
    return new Promise<T>((resolvePending,rejectPending)=>{
      let settled=false,acquired=false;
      const finish=(action:()=>void):void=>{if(settled)return;settled=true;if(acquired){try{Reflect.apply(removeListener,this.signal,["abort",cancel]);}catch{this.#warnings.add("listener-cleanup-failed");}}action();};
      const refuse=():void=>{rejectPending(new Error("pixelwatch-action: entry-refused"));};
      const cancel=():void=>{finish(refuse);};
      try{
        // Attach observers before checking cancellation, including already-aborted
        // acquisitions, so any late native rejection remains genuinely observed.
        Reflect.apply(promiseThen,pending,[(value:T)=>{finish(()=>{resolvePending(value);});},()=>{finish(refuse);}]);
        if(nativeAborted(this.signal)){cancel();return;}
        acquired=true;Reflect.apply(addListener,this.signal,["abort",cancel]);if(nativeAborted(this.signal))cancel();
      }catch{finish(refuse);}
    });
  }
  close():void {
    for(const unlink of this.#unlink){try{unlink();}catch{this.#warnings.add("listener-cleanup-failed");}}
    try{this.#dispose?.();}catch{this.#warnings.add("timing-disposal-failed");}
  }
}
/** Resolve only the fixed shipped layout, then ask sanitized native Git for its actual HEAD. */
function ownCheckoutHead():string {
  const host=fileURLToPath(import.meta.url),root=resolve(dirname(host),"../../..");
  if(join(root,"actions/publish/dist/index.js")!==host||realpathSync(root)!==root)fail();
  const metadata=join(root,".git"),stat=lstatSync(metadata);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(metadata)!==metadata)fail();
  const env:NodeJS.ProcessEnv={};for(const key of ["PATH","Path","SystemRoot","SYSTEMROOT","WINDIR","TMP","TEMP","TMPDIR"] as const){const value=process.env[key];if(value!==undefined)env[key]=value;}
  // Git for Windows accepts its reserved NUL device, but rejects Node's \\.\nul spelling.
  const gitNull=process.platform==="win32"?"NUL":devNull;
  Object.assign(env,{HOME:gitNull,USERPROFILE:gitNull,XDG_CONFIG_HOME:gitNull,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:gitNull,GIT_CONFIG_SYSTEM:gitNull,GIT_ATTR_NOSYSTEM:"1",GIT_TERMINAL_PROMPT:"0",GIT_ALLOW_PROTOCOL:"",GIT_NO_REPLACE_OBJECTS:"1"});
  const args=["--no-optional-locks","-c",`core.hooksPath=${gitNull}`,"-c",`core.attributesFile=${gitNull}`,"-c","core.fsmonitor=false","-c","submodule.recurse=false","-c","credential.helper=","--git-dir",metadata,"--work-tree",root,"rev-parse","--verify","HEAD^{commit}"];
  const child=spawnSync("git",args,{cwd:root,env,windowsHide:true,timeout:STORE_LIMITS.processTimeoutMs,maxBuffer:4096});
  if(child.status!==0||child.stderr.byteLength!==0)fail();const head=child.stdout.toString("utf8").trim();if(!/^[0-9a-f]{40}$/.test(head))fail();return head;
}

/** Production inputs choose data only. Only direct trusted JavaScript can provide test ports. */
export async function runPublisherEntry(environment:Readonly<Record<string,string|undefined>>,trusted?:TrustedEntryTestPorts):Promise<EntryResult> {
  const warnings=new Set<EntryWarning>();let scope:WorkScope|undefined,store:GitBranchStore|undefined,worker:PngWorker|undefined,workerClose:Promise<void>|undefined;
  let outcome:HostStageOutcome|undefined,source:SourceJobResult|undefined,maintenance:MaintenanceResult|undefined,code:EntryResult["code"];
  const closeWorker=():Promise<void>=>{if(workerClose===undefined){if(worker===undefined)fail();workerClose=worker.close();}return workerClose;};
  try{
    const ports=capturePorts(trusted);scope=new WorkScope(ports,warnings);scope.start();const active=scope;
    const captured:Record<string,string|undefined>={};
    for(const key of ["INPUT_STAGE","GITHUB_EVENT_NAME","GITHUB_REPOSITORY","GITHUB_REPOSITORY_ID","GITHUB_RUN_ID","GITHUB_RUN_ATTEMPT","GITHUB_SHA","GITHUB_REF","RUNNER_NAME","GITHUB_WORKFLOW_REF","PIXELWATCH_WORKFLOW_REPOSITORY","PIXELWATCH_WORKFLOW_SHA","PIXELWATCH_CHECKOUT_HEAD","GITHUB_EVENT_PATH","GITHUB_OUTPUT","RUNNER_TEMP"] as const)captured[key]=environment[key];
    const event=readBoundedFile(fixedPath(captured["GITHUB_EVENT_PATH"]),1024*1024),head=ownCheckoutHead();
    if(captured["PIXELWATCH_CHECKOUT_HEAD"]!==head)fail();const invocation=readInvocation(captured,event,head);
    const release=readRuntimeRelease(import.meta.url,__PIXELWATCH_VERSION__,__PIXELWATCH_SOURCE_COMMIT__);
    const runnerTemp=fixedPath(captured["RUNNER_TEMP"]),outputPath=fixedPath(captured["GITHUB_OUTPUT"]);active.check();
    if(invocation.stage==="prepare"||invocation.stage==="finish"){code="dependencies-unavailable";}
    else{
      const token=environment["INPUT_TOKEN"];if(typeof token!=="string"||token.length===0||token.length>512||!/^[A-Za-z0-9_]+$/.test(token))fail();
      const transport:HttpTransport={request:call=>{active.check();return ports.transport.request(call);}};
      const forge=new GitHubClient({owner:invocation.repository.owner,repo:invocation.repository.name,repositoryId:invocation.repository.repositoryId,token,transport,timing:ports.timing});
      const policy=await loadHostPolicy(invocation.repository,{release:release.version,releaseCommit:head,script:release.script},forge,active.signal);active.check();
      const remote=ports.remote===undefined?`https://github.com/${invocation.repository.owner}/${invocation.repository.name}.git`:join(ports.remote.root,"remote.git");
      const callback=ports.remote?.checkpoint;
      let packRecovery=false,recoveryReadAvailable=false;
      const storeTiming:StoreTiming={deadline:ms=>{
        if(ms!==STORE_LIMITS.processTimeoutMs)fail();
        // Freeze the operation's mode before acquiring any mutable trusted timer port.
        const recovery=packRecovery;return active.packDeadline(ports.timing,recovery);
      }};
      store=new GitBranchStore({repositoryId:invocation.repository.repositoryId,defaultBranch:policy.defaultBranch,branch:policy.context.config.store?.branch??"pixelwatch-data",remote,token,timing:storeTiming,
        checkpoint:async event=>{
          const phase=event.point;if(phase==="before-push")active.check();
          if(callback!==undefined)await active.wait(callback(event));
          // This also throws after a sent push at expiry. The real store converts that
          // boundary into its unknown receipt, preserving its bounded recovery read.
          active.check();
        },...(ports.remote===undefined?{}:{testRemote:{root:ports.remote.root},...(ports.remote.packCheckpoint===undefined?{}:{packCheckpoint:ports.remote.packCheckpoint})})});
      const actualStore=store,snapshot=await active.wait(actualStore.read());active.check();const prStates=await collectHostPrStates(snapshot,invocation.repository.repositoryId,forge,active.signal);active.check();
      const adapter:StoreAdapter={
        async read(){
          // Only this private flag, minted from the actual native CAS result, grants
          // recovery. It is consumed before the one fresh read starts.
          const recovery=recoveryReadAvailable;recoveryReadAvailable=false;packRecovery=recovery;
          try{
            if(recovery)return await actualStore.read();
            active.check();const value=await active.wait(actualStore.read());active.check();return value;
          }finally{packRecovery=false;}
        },
        async cas(tip,candidate){
          active.check();recoveryReadAvailable=false;packRecovery=false;
          // Never race a CAS: its real sent result and bounded recovery own settlement.
          const reply=frozenCopy(await actualStore.cas(tip,candidate));
          if(reply.status==="unknown"&&typeof reply.attemptedTip==="string"&&/^[0-9a-f]{40}$/.test(reply.attemptedTip))recoveryReadAvailable=true;
          return reply;
        },
      };
      const timestamp=ports.now(),admission={now:timestamp,metadata:{timestamp},prStates,pins:new Set<string>(),delay:async(ms:number)=>{active.check();await active.wait(ports.timing.delay(ms,active.signal));active.check();},jitter:ports.jitter};
      const timing={deadline:(ms:number)=>active.borrowedDeadline(ms)};
      const unavailable=():never=>{throw new Error("pixelwatch-action: dependencies-unavailable");};
      outcome=frozenCopy(await runHostStage({invocation,release,runnerTemp,outputPath},{
        async ingest(bytes){
          worker=new PngWorker({workerUrl:release.pngWorkerUrl});const ownedWorker=worker;
          const result=await ingestJob({...policy.context,event:bytes},{forge,store:adapter,admission,timing,signal:active.signal,
            worker:{decode:(...args)=>ownedWorker.decode(...args),encode:(...args)=>ownedWorker.encode(...args),compare:(...args)=>ownedWorker.compare(...args),close:closeWorker}});
          source=frozenCopy(result);return source;
        },
        async maintenance(){const result=await maintainStore(adapter,{...admission,context:policy.context,timing,signal:active.signal});maintenance=frozenCopy(result);return maintenance;},
        prepare:()=>Promise.reject(new Error("pixelwatch-action: dependencies-unavailable")),finish:()=>Promise.reject(new Error("pixelwatch-action: dependencies-unavailable")),renderProjectionSummary:unavailable,
      }));
    }
  }catch{code="entry-refused";}
  finally{
    // SourceJob invokes this observer once; entry joins that SAME native close promise. If
    // acquisition failed before transfer, the entry invokes the still-owned worker close.
    if(worker!==undefined){try{await closeWorker();}catch{warnings.add("worker-close-failed");}}
    if(store!==undefined){try{await store.close();}catch{warnings.add("store-close-failed");}}
    scope?.close();
  }
  const exitCode:0|1=outcome===undefined||outcome.exitCode===1||warnings.size>0?1:0;
  return Object.freeze({status:outcome===undefined?"failed":"completed",exitCode,...(code===undefined?{}:{code}),...(outcome===undefined?{}:{outcome}),...(source===undefined?{}:{source}),...(maintenance===undefined?{}:{maintenance}),warnings:Object.freeze([...warnings])});
}

if(process.argv[1]!==undefined&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const result=await runPublisherEntry(process.env);process.exitCode=result.exitCode;
  process.stdout.write((result.outcome?.summary??(result.code==="dependencies-unavailable"?"PixelWatch: projection dependencies unavailable; run repair after the reviewed publisher is complete":"PixelWatch: publisher failed; run repair from the trusted default-branch workflow"))+"\n");
}

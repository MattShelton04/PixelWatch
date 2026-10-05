/** Bounded test assembly of the ACTUAL main and reviewed packages; never a publisher substitute. */
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {basename,dirname,isAbsolute,join,relative,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {inspect} from "node:util";
import {canonicalBytes} from "../../../packages/schemas/src/index.ts";
import {GitBranchStore,STORE_LIMITS,type GitCheckpoint,type StoreSnapshot} from "../../../packages/store/src/index.ts";
import {Scratch} from "../../../packages/store/test/helpers.ts";
import {artifact,tinyPng,type ZipOptions} from "../../../packages/core/test/ingest-fixtures.ts";
import type {HttpRequest,HttpResponse,Timing} from "../../../packages/forge-github/src/transport.ts";
import {assertNoSecrets} from "../../../tools/simulation/capture.ts";
import {buildPublisherArtifacts,type ReleaseArtifact} from "../../../tools/release/build.ts";
import type {EntryResult,TrustedEntryTestPorts,runPublisherEntry} from "../src/main.ts";

export const FAKE_ENTRY_TOKEN="pw_entry_CANARY_TOKEN_DO_NOT_PUBLISH";
export const ENTRY_TIME="2026-10-03T00:00:00Z";
export const ENTRY_HEAD="a".repeat(40);
export const ENTRY_VERSION="0.1.0-rc.1";
export const entryRaw:(string|Uint8Array)[]=[];
let rawBytes=0;
export const entrySourceRoot=fileURLToPath(new URL("../../..",import.meta.url));
const roots:string[]=[],scratches:Scratch[]=[];
const fakeForms=[FAKE_ENTRY_TOKEN,encodeURIComponent(FAKE_ENTRY_TOKEN),Buffer.from(FAKE_ENTRY_TOKEN).toString("base64"),JSON.stringify(FAKE_ENTRY_TOKEN)];
export function scanEntryRaw(values:readonly(string|Uint8Array)[]):void {
  assertNoSecrets(values);
  for(const value of values){const text=typeof value==="string"?value:Buffer.from(value).toString("utf8");if(fakeForms.some(secret=>text.includes(secret)))throw new Error("entry-secret-leak");}
}
export function entryRecord(value:string|Uint8Array):void {
  const owned=typeof value==="string"?value:Uint8Array.from(value);entryRaw.push(owned);
  rawBytes+=typeof owned==="string"?Buffer.byteLength(owned):owned.byteLength;
  if(entryRaw.length>10000||rawBytes>64*1024*1024)throw new Error("entry-fixture-raw-limit");
  scanEntryRaw([owned]);
}
export function entryHash(bytes:Uint8Array):string{return createHash("sha256").update(bytes).digest("hex");}
function ownRoot():string {const root=mkdtempSync(join(realpathSync.native(tmpdir()),"pixelwatch-entry-"));roots.push(root);return root;}
function copyRuntimeDependencies(target:string):void {
  const copied=new Set<string>();
  const copy=(name:string,from:string):void=>{
    if(copied.has(name))return;
    const manifest=realpathSync(createRequire(from).resolve(`${name}/package.json`));
    const metadata=JSON.parse(readFileSync(manifest,"utf8")) as {dependencies?:Record<string,string>};
    copied.add(name);const destination=join(target,"node_modules",name);mkdirSync(dirname(destination),{recursive:true});
    cpSync(dirname(manifest),destination,{recursive:true,filter:path=>basename(path)!=="node_modules"});
    for(const dependency of Object.keys(metadata.dependencies??{}))copy(dependency,manifest);
  };
  copy("ajv",join(entrySourceRoot,"packages/schemas/package.json"));
}
export interface ActualEntryBundle {
  readonly sourceRoot:string;
  readonly sourceCommit:string;
  readonly releaseRoot:string;
  readonly releaseCommit:string;
  readonly artifacts:readonly ReleaseArtifact[];
  readonly run:typeof runPublisherEntry;
  readonly guard:string;
}
let fixtureGit:Scratch|undefined;
function git(args:string[],cwd:string):string {
  fixtureGit??=new Scratch();return fixtureGit.git(args,undefined,cwd);
}
function commitDirectory(root:string,paths:readonly string[]):string {
  const hooks=join(root,"empty-hooks");mkdirSync(hooks);
  git(["init","--object-format=sha1",`--template=${hooks}`,root],root);
  git(["add","--",...paths],root);git(["commit","-m","isolated actual entry fixture"],root);
  return git(["rev-parse","--verify","HEAD^{commit}"],root);
}
function guard(root:string):string {
  const output=join(root,"guard.mjs"),input=join(entrySourceRoot,"tools/lib/no-network.ts"),url=pathToFileURL(input).href;
  const env:NodeJS.ProcessEnv={};for(const key of ["SystemRoot","WINDIR","TEMP","TMP"] as const){const value=process.env[key];if(value!==undefined)env[key]=value;}
  const child=spawnSync(process.execPath,["--input-type=module","-e",`await import(${JSON.stringify(url)});const {buildSync}=await import('esbuild');const result=buildSync({entryPoints:[${JSON.stringify(input)}],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});process.stdout.write(result.outputFiles[0].contents);`],{cwd:entrySourceRoot,env,timeout:60000,maxBuffer:1024*1024,windowsHide:true});
  entryRecord(child.stdout);entryRecord(child.stderr);entryRecord(JSON.stringify({status:child.status,signal:child.signal,error:inspect(child.error,{depth:8,showHidden:true})}));
  if(child.status!==0)throw new Error("entry-guard-build-failed");writeFileSync(output,child.stdout);return output;
}
export async function actualEntryBundle():Promise<ActualEntryBundle> {
  const root=ownRoot(),sourceRoot=join(root,"source");mkdirSync(sourceRoot);
  for(const pkg of ["core","schemas","viewer","publisher","store","forge-github"]){
    const destination=join(sourceRoot,"packages",pkg);mkdirSync(destination,{recursive:true});
    cpSync(join(entrySourceRoot,"packages",pkg,"src"),join(destination,"src"),{recursive:true,filter:path=>!path.endsWith(".test.ts")});
    cpSync(join(entrySourceRoot,"packages",pkg,"package.json"),join(destination,"package.json"));
  }
  cpSync(join(entrySourceRoot,"packages/schemas/schemas"),join(sourceRoot,"packages/schemas/schemas"),{recursive:true});
  const action=join(sourceRoot,"actions/publish");mkdirSync(action,{recursive:true});
  cpSync(join(entrySourceRoot,"actions/publish/src"),join(action,"src"),{recursive:true});
  writeFileSync(join(action,"package.json"),'{"private":true,"type":"module"}\n');
  for(const path of ["package.json","pnpm-lock.yaml","LICENSE"])cpSync(join(entrySourceRoot,path),join(sourceRoot,path));
  const sourceCommit=commitDirectory(sourceRoot,["packages","actions","package.json","pnpm-lock.yaml","LICENSE"]);
  copyRuntimeDependencies(sourceRoot);
  const artifacts=await buildPublisherArtifacts({sourceRoot,version:ENTRY_VERSION,sourceCommit});
  for(const file of artifacts)entryRecord(file.bytes);
  const releaseRoot=join(root,"release"),dist=join(releaseRoot,"actions/publish/dist");mkdirSync(dist,{recursive:true});
  writeFileSync(join(releaseRoot,"actions/publish/package.json"),'{"private":true,"type":"module"}\n');
  for(const file of artifacts)writeFileSync(join(dist,file.path),file.bytes);
  const releaseCommit=commitDirectory(releaseRoot,["actions"]),testGuard=guard(root);
  const module:unknown=await import(pathToFileURL(join(dist,"index.js")).href);
  if(module===null||typeof module!=="object"||!("runPublisherEntry" in module)||typeof module.runPublisherEntry!=="function")throw new Error("entry-export-missing");
  return {sourceRoot,sourceCommit,releaseRoot,releaseCommit,artifacts,run:module.runPublisherEntry as typeof runPublisherEntry,guard:testGuard};
}
export interface EntryClock extends Timing {
  readonly deadlines:number[];
  readonly disposed:number[];
  readonly delays:number[];
  readonly work:AbortController;
  milliseconds:number;
  failDispose:boolean;
}
function clock():EntryClock {
  const deadlines:number[]=[],disposed:number[]=[],delays:number[]=[],work=new AbortController();
  const value:EntryClock={deadlines,disposed,delays,work,milliseconds:0,failDispose:false,
    deadline(ms){deadlines.push(ms);return {signal:ms===600000?work.signal:new AbortController().signal,dispose(){disposed.push(ms);if(value.failDispose&&ms===600000)throw new Error("entry-fake-disposal-refusal");}};},
    delay(ms,signal){delays.push(ms);value.milliseconds+=ms;if(signal?.aborted===true)return Promise.reject(new Error("entry-fake-cancelled"));return Promise.resolve();},
  };return value;
}
export interface EntryWorld {
  readonly root:string;
  readonly scratch:Scratch;
  readonly environment:Record<string,string|undefined>;
  readonly responses:Map<string,HttpResponse>;
  readonly requests:{method:string;url:string}[];
  readonly pushes:GitCheckpoint[];
  readonly clock:EntryClock;
  readonly ports:TrustedEntryTestPorts;
  tokenReads:number;
  requestOverride:((request:HttpRequest)=>Promise<HttpResponse>|undefined)|undefined;
  run(environment?:Readonly<Record<string,string|undefined>>):Promise<EntryResult>;
  snapshot():Promise<StoreSnapshot>;
}
export const ENTRY_API="https://api.github.com/repos/owner/repo";
export const entryJson=(value:unknown):HttpResponse=>({status:200,headers:{},body:canonicalBytes(value)});
export function entryPart(options:ZipOptions&{id?:string;name?:string}={}) {
  return artifact({attempt:"7",revision:"head",providerId:"p",shard:[1,1],units:[{viewId:"v1",state:"captured",png:tinyPng(1)}]},{id:"1",...options});
}
export function entryWorld(bundle:ActualEntryBundle):EntryWorld {
  const root=ownRoot(),runner=join(root,"runner");mkdirSync(runner);const eventPath=join(root,"event.json"),outputPath=join(root,"output.txt");writeFileSync(outputPath,"");
  const repository={id:42,full_name:"owner/repo",default_branch:"main",name:"repo",owner:{login:"owner"}},sourceRun={id:99,workflow_id:101,run_attempt:7,event:"push",status:"completed",created_at:ENTRY_TIME,head_sha:ENTRY_HEAD,head_branch:"main",path:".github/workflows/capture.yml",repository,head_repository:repository,head_commit:{id:ENTRY_HEAD},pull_requests:[]};
  writeFileSync(eventPath,canonicalBytes({action:"completed",repository,workflow_run:sourceRun}));
  const environment:Record<string,string|undefined>={INPUT_STAGE:"ingest",GITHUB_EVENT_NAME:"workflow_run",GITHUB_REPOSITORY:"owner/repo",GITHUB_REPOSITORY_ID:"42",GITHUB_RUN_ID:"501",GITHUB_RUN_ATTEMPT:"1",GITHUB_SHA:"b".repeat(40),GITHUB_REF:"refs/heads/main",RUNNER_NAME:"isolated-entry-runner",GITHUB_WORKFLOW_REF:"owner/repo/.github/workflows/report.yml@refs/heads/main",PIXELWATCH_WORKFLOW_REPOSITORY:"MattShelton04/PixelWatch",PIXELWATCH_WORKFLOW_SHA:bundle.releaseCommit,PIXELWATCH_CHECKOUT_HEAD:bundle.releaseCommit,GITHUB_EVENT_PATH:eventPath,GITHUB_OUTPUT:outputPath,RUNNER_TEMP:runner};
  const scratch=new Scratch();scratches.push(scratch);const time=clock(),requests:{method:string;url:string}[]=[],pushes:GitCheckpoint[]=[],responses=new Map<string,HttpResponse>();
  for(const [path,value] of [["",repository],["/git/ref/heads/main",{ref:"refs/heads/main",object:{type:"commit",sha:"3".repeat(40)}}],["/pages",{html_url:"https://owner.github.io/repo/",cname:null,build_type:"workflow"}],["/actions/runs/99",sourceRun],["/actions/runs/99/attempts/7",sourceRun],["/actions/workflows/101",{id:101,path:sourceRun.path}],[`/commits/${ENTRY_HEAD}`,{sha:ENTRY_HEAD,parents:[]}]] as const)responses.set(ENTRY_API+path,entryJson(value));
  responses.set(ENTRY_API+`/contents/.pixelwatch/config.json?ref=${"3".repeat(40)}`,entryJson({schemaVersion:1,source:{workflowIds:["101"],events:["push"]},providers:[{id:"p",shards:1}]}));
  responses.set(ENTRY_API+`/commits/${ENTRY_HEAD}`,entryJson({sha:ENTRY_HEAD,parents:[{sha:"b".repeat(40)}]}));
  const parts=[entryPart(),artifact({attempt:"7",revision:"base",providerId:"p",shard:[1,1],units:[{viewId:"v1",state:"captured",png:tinyPng(2)}]},{id:"2"})];
  responses.set(ENTRY_API+"/actions/runs/99/artifacts?per_page=100&page=1",entryJson({total_count:parts.length,artifacts:parts.map(part=>({id:Number(part.artifactId),name:part.artifactName,size_in_bytes:part.zip.byteLength,expired:false}))}));
  for(const part of parts)responses.set(`${ENTRY_API}/actions/artifacts/${part.artifactId}/zip`,{status:200,headers:{},body:part.zip});
  const world:EntryWorld={root,scratch,environment,responses,requests,pushes,clock:time,tokenReads:0,requestOverride:undefined,
    ports:{timing:time,now:()=>ENTRY_TIME,monotonic:()=>time.milliseconds,jitter:()=>42,testRemote:{root:scratch.root,checkpoint:event=>{pushes.push(event);return Promise.resolve();}},transport:{request:request=>{requests.push({method:request.method,url:request.url});const override=world.requestOverride?.(request);if(override!==undefined)return override;const response=responses.get(request.url);if(response===undefined)return Promise.reject(new Error("entry-fake-unregistered-request"));return Promise.resolve(response);}}},
    async run(selected=environment){
      try{const result=await bundle.run(selected,world.ports);entryRecord(JSON.stringify(result));return result;}
      catch(error){entryRecord(inspect(error,{depth:8,showHidden:true}));throw error;}
      finally{entryRecord(JSON.stringify(requests));entryRecord(JSON.stringify(pushes));if(existsSync(outputPath)){if(lstatSync(outputPath).isFile())entryRecord(readFileSync(outputPath));else entryRecord("entry-fixture: output-not-regular");}}
    },
    async snapshot(){const store=new GitBranchStore({repositoryId:"42",defaultBranch:"main",remote:scratch.remote,testRemote:{root:scratch.root}});try{const snapshot=await store.read(),owned=new Map<string,Uint8Array>();for(const file of snapshot.files){const bytes=await snapshot.readFile(file.path);entryRecord(bytes);owned.set(file.path,bytes);}return {...snapshot,readFile(path){const bytes=owned.get(path);if(bytes===undefined)return Promise.reject(new Error("entry-fixture-file-missing"));return Promise.resolve(Uint8Array.from(bytes));}};}finally{await store.close();}},
  };
  Object.defineProperty(environment,"INPUT_TOKEN",{configurable:true,enumerable:true,get(){world.tokenReads++;return FAKE_ENTRY_TOKEN;}});
  return world;
}
export function entryFiles(root:string):string[] {
  const result:string[]=[];const visit=(directory:string):void=>{for(const entry of readdirSync(directory,{withFileTypes:true})){if(entry.name===".git"||entry.name==="empty-hooks")continue;const path=join(directory,entry.name);if(entry.isDirectory())visit(path);else result.push(relative(root,path).replaceAll("\\","/"));}};visit(root);return result.sort();
}
interface HeldCheckpointProof {
  readonly mode:"initial-read"|"after-push"|"conflict-delay"|"admission-read"|"cas-read"|"pack-signal";
  readonly phase:string;
  readonly reached:number;
  readonly milliseconds:number;
  readonly outerAborted:boolean;
  readonly checkpoints:readonly GitCheckpoint[];
  readonly result?:EntryResult;
  readonly disposed:readonly number[];
  readonly clients:readonly {path:string;dev:string;ino:string;remaining:boolean}[];
  readonly delayCalls:number;
  readonly delayMilliseconds?:number;
  readonly competingCalls:number;
  readonly competingTip?:string;
  readonly competitorEvents:readonly GitCheckpoint[];
  readonly markerTip?:string;
  readonly packIndexes:number;
  readonly downloadedArtifacts:number;
  readonly rawSignalGetterReads:number;
  readonly nativePackPid?:number;
  readonly packSignalImmediatelyAborted?:boolean;
  readonly httpComponentSignalIdentical?:boolean;
  readonly httpComponentFetchCalls:number;
  readonly httpComponentStreamTerminal?:boolean;
}
/** A real Node child makes an unsettled native boundary an actual exit13 regression,
 * while persisting the controlled barrier and owned native directories BEFORE waiting. */
export function entryHeldCheckpoint(bundle:ActualEntryBundle,world:EntryWorld,mode:HeldCheckpointProof["mode"]):{status:number|null;proof:HeldCheckpointProof} {
  const script=join(world.root,`entry-held-${mode}.mjs`),rawPath=join(world.root,`entry-held-${mode}.json`);
  const environment:Record<string,string|undefined>={};for(const key of Object.keys(world.environment)){if(key!=="INPUT_TOKEN")environment[key]=world.environment[key];}environment["INPUT_TOKEN"]=FAKE_ENTRY_TOKEN;
  const responses=[...world.responses].map(([url,response])=>[url,{status:response.status,headers:response.headers,body:Array.from(response.body)}]);
  const index=pathToFileURL(join(bundle.releaseRoot,"actions/publish/dist/index.js")).href;
  writeFileSync(script,`
import fs from 'node:fs';
import {inspect} from 'node:util';
import {basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const mode=${JSON.stringify(mode)},rawPath=${JSON.stringify(rawPath)},environment=${JSON.stringify(environment)};
const responses=new Map(${JSON.stringify(responses)}),work=new AbortController(),clients=[],checkpoints=[],disposed=[],requests=[],competitorEvents=[];
const nativeAbortGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get,nativeAdd=EventTarget.prototype.addEventListener,abortReceivers=[];
function actuallyAborted(signal){return Reflect.apply(nativeAbortGetter,signal,[]);}
if(mode==='pack-signal'){EventTarget.prototype.addEventListener=function(type,...args){if(type==='abort'){try{actuallyAborted(this);abortReceivers.push(this);}catch{}}return Reflect.apply(nativeAdd,this,[type,...args]);};}
let milliseconds=0,reached=0,result,delayCalls=0,delayMilliseconds,competingCalls=0,competingTip,markerTip,packIndexes=0,rawSignalGetterReads=0,nativePackPid,packSignalImmediatelyAborted,httpComponentSignalIdentical,httpComponentFetchCalls=0,httpComponentStreamTerminal;const componentErrors=[];
const target=mode==='admission-read'?3:mode==='cas-read'?4:0;
function downloaded(){return requests.filter(request=>request.url.endsWith('/actions/artifacts/1/zip')||request.url.endsWith('/actions/artifacts/2/zip')).length;}
function persist(phase){fs.writeFileSync(rawPath,JSON.stringify({mode,phase,reached,milliseconds,outerAborted:actuallyAborted(work.signal),checkpoints,result,disposed,delayCalls,delayMilliseconds,competingCalls,competingTip,competitorEvents,markerTip,packIndexes,downloadedArtifacts:downloaded(),rawSignalGetterReads,nativePackPid,packSignalImmediatelyAborted,httpComponentSignalIdentical,httpComponentFetchCalls,httpComponentStreamTerminal,componentErrors,clients:clients.map(client=>({...client,remaining:fs.existsSync(client.path)}))}));}
const nativeMkdtemp=fs.mkdtempSync;
fs.mkdtempSync=function(prefix,options){const path=nativeMkdtemp(prefix,options);if(typeof prefix==='string'&&basename(prefix)==='pixelwatch-store-client-'){const stat=fs.lstatSync(path);clients.push({path,dev:String(stat.dev),ino:String(stat.ino)});persist('native-client-acquired');}return path;};
syncBuiltinESMExports();
const {runPublisherEntry}=await import(${JSON.stringify(index)});
let NativeStore,newStore,canonicalBytes;
if(mode==='conflict-delay'||target!==0||mode==='pack-signal'){
  ({GitBranchStore:NativeStore}=await import(${JSON.stringify(pathToFileURL(join(entrySourceRoot,"packages/store/src/index.ts")).href)}));
  ({newStore}=await import(${JSON.stringify(pathToFileURL(join(entrySourceRoot,"packages/core/src/index.ts")).href)}));
  ({canonicalBytes}=await import(${JSON.stringify(pathToFileURL(join(entrySourceRoot,"packages/schemas/src/index.ts")).href)}));
}
async function marker(){const competitor=new NativeStore({repositoryId:'42',defaultBranch:'main',remote:${JSON.stringify(world.scratch.remote)},testRemote:{root:${JSON.stringify(world.scratch.root)}},checkpoint(event){competitorEvents.push({...event});return Promise.resolve();}});
  try{const before=await competitor.read();if(before.tip!==null)throw new Error('entry-child-competitor-tip-refused');const store=newStore('42'),reply=await competitor.cas(null,{store,runs:new Map(),files:new Map([['store.json',canonicalBytes(store)]]),metadata:{timestamp:${JSON.stringify(ENTRY_TIME)}}});persist('genuine-marker-cas-returned');if(reply.status!=='accepted')throw new Error('entry-child-competitor-cas-refused');return reply.tip;}finally{await competitor.close();}}
const ports={now:()=>${JSON.stringify(ENTRY_TIME)},monotonic:()=>milliseconds,jitter:()=>42,
  timing:{deadline(ms){const signal=ms===600000?work.signal:new AbortController().signal;if(mode==='pack-signal'){for(const key of ['aborted','reason','addEventListener','removeEventListener'])if(!Object.hasOwn(signal,key))Object.defineProperty(signal,key,{configurable:true,get(){rawSignalGetterReads++;throw new Error('entry-child-raw-signal-shadow-refused');}});}return {signal,dispose(){disposed.push(ms);}};},delay(ms,signal){
    if(mode==='conflict-delay'){delayCalls++;delayMilliseconds=ms;if(ms!==142||competingCalls!==1||checkpoints.filter(event=>event.point==='after-push'&&event.result==='conflict').length!==1)throw new Error('entry-child-conflict-delay-not-reached');reached++;milliseconds=600000;work.abort();persist('native-conflict-delay-held-after-expiry');return new Promise(()=>{});}
    milliseconds+=ms;if(signal?.aborted)return Promise.reject(new Error('entry-child-cancelled'));return Promise.resolve();}},
  transport:{request(request){requests.push({method:request.method,url:request.url});const response=responses.get(request.url);if(response===undefined)return Promise.reject(new Error('entry-child-unregistered-request'));return Promise.resolve({...response,body:Uint8Array.from(response.body)});}},
  testRemote:{root:${JSON.stringify(world.scratch.root)},async checkpoint(event){checkpoints.push({...event});
    if(mode==='conflict-delay'&&event.point==='before-push'){if(competingCalls!==0||event.expectedTip!==null)throw new Error('entry-child-second-cas-refused');competingCalls++;competingTip=await marker();persist('actual-competitor-accepted');}
    if(mode==='after-push'&&event.point==='after-push'){reached++;milliseconds=600000;work.abort();persist('sent-native-push-held-after-expiry');return new Promise(()=>{});}return;},
    async packCheckpoint(event){
      if(mode==='pack-signal'&&event.point==='child-started'){
        // GitBranchStore's genuine localPack installs its stop listener immediately
        // before this callback. The documented forwarding observer captures that
        // exact native receiver; no private symbol or assumed listener count.
        const packSignal=abortReceivers.at(-1);if(packSignal===undefined||actuallyAborted(packSignal)||!Number.isSafeInteger(event.pid)||event.pid<=0)throw new Error('entry-child-native-pack-signal-not-reached');
        nativePackPid=event.pid;reached++;milliseconds=600000;work.abort();packSignalImmediatelyAborted=actuallyAborted(packSignal);persist('native-pack-signal-immediate-outer-abort');
        const nativeFetch=globalThis.fetch;let stream;
        globalThis.fetch=async(url,options)=>{httpComponentFetchCalls++;if(url!=='https://github.com/owner/repo.git/git-upload-pack'||options.method!=='POST')throw new Error('entry-child-http-component-refused');httpComponentSignalIdentical=options.signal===packSignal;stream=new ReadableStream({start(controller){controller.close();}});return new Response(stream,{status:200,headers:{'content-type':'application/x-git-upload-pack-result'}});};
        try{const {httpPackTransport}=await import(${JSON.stringify(pathToFileURL(join(entrySourceRoot,"packages/store/src/transport.ts")).href)});try{const response=await httpPackTransport.request({url:'https://github.com/owner/repo.git/git-upload-pack',body:Uint8Array.of(1),headers:{},signal:packSignal});for await(const chunk of response.body){if(!(chunk instanceof Uint8Array))throw new Error('entry-child-http-component-body-refused');}}catch(error){componentErrors.push(inspect(error,{depth:8,showHidden:true,maxStringLength:1024*1024}));} }
        finally{globalThis.fetch=nativeFetch;httpComponentStreamTerminal=stream!==undefined&&!stream.locked;persist('actual-http-component-signal-proof');}
        return;
      }
      if(event.point==='before-index'&&target!==0){packIndexes++;if(packIndexes===target){if(downloaded()!==2||checkpoints.length!==0||(event.bytes??0)<=0)throw new Error('entry-child-later-pack-not-reached');reached++;milliseconds=600000;work.abort();persist('later-unsent-native-pack-held-after-expiry');return new Promise(()=>{});}}
      if(mode==='initial-read'&&event.point==='before-index'){reached++;milliseconds=600000;work.abort();persist('initial-native-pack-held-after-expiry');return new Promise(()=>{});}return Promise.resolve();}}};
if(target!==0||mode==='pack-signal'){markerTip=await marker();persist('actual-marker-seed-accepted');}
persist('before-actual-entry');
result=await runPublisherEntry(environment,ports);
persist('actual-entry-settled');
EventTarget.prototype.addEventListener=nativeAdd;
`);
  const env:NodeJS.ProcessEnv={};for(const key of ["PATH","Path","SystemRoot","SYSTEMROOT","WINDIR","TMP","TEMP","TMPDIR"] as const){const value=process.env[key];if(value!==undefined)env[key]=value;}
  const child=spawnSync(process.execPath,["--import",pathToFileURL(bundle.guard).href,script],{env,windowsHide:true,timeout:STORE_LIMITS.processTimeoutMs,maxBuffer:1024*1024});
  entryRecord(child.stdout);entryRecord(child.stderr);entryRecord(JSON.stringify({status:child.status,signal:child.signal,error:inspect(child.error,{depth:8,showHidden:true})}));
  const stat=lstatSync(rawPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error("entry-child-raw-refused");
  const raw=readFileSync(rawPath);entryRecord(raw);const proof=JSON.parse(raw.toString("utf8")) as HeldCheckpointProof;
  // A red exit13 does not execute entry cleanup. Remove only exact directories captured
  // at their genuine native mint point; never infer paths by enumerating temp storage.
  for(const client of proof.clients){if(!client.remaining)continue;const target=resolve(client.path),rel=relative(resolve(realpathSync.native(tmpdir())),target),identity=lstatSync(target);
    if(isAbsolute(rel)||!/^pixelwatch-store-client-[A-Za-z0-9_-]+$/.test(rel)||identity.isSymbolicLink()||!identity.isDirectory()||realpathSync(target)!==target||String(identity.dev)!==client.dev||String(identity.ino)!==client.ino)throw new Error("entry-child-cleanup-refused");
    rmSync(target,{recursive:true,force:false});
  }
  return {status:child.status,proof};
}
export function cleanupEntryFixtures():void {
  for(const scratch of scratches.splice(0))scratch.close();fixtureGit?.close();fixtureGit=undefined;
  for(const root of roots.splice(0)){const target=resolve(root),rel=relative(resolve(realpathSync.native(tmpdir())),target);if(isAbsolute(rel)||!/^pixelwatch-entry-[A-Za-z0-9_-]+$/.test(rel)||lstatSync(target).isSymbolicLink()||realpathSync(target)!==target)throw new Error("entry-fixture-cleanup-refused");rmSync(target,{recursive:true,force:false});}
}

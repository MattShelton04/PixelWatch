import {types} from "node:util";
import {parseJson,type JsonObject,type JsonValue} from "../../packages/schemas/src/index.ts";
import {LIMITS} from "../../packages/forge-github/src/errors.ts";
import type {HttpResponse,HttpTransport,Timing} from "../../packages/forge-github/src/transport.ts";
import {parseLiveSetupManifest,type LiveSetupManifest} from "./manifest.ts";

export interface LivePreflightOptions {readonly transport:HttpTransport;readonly timing:Timing;readonly credential?:string}
export interface LivePreflightResult {
  readonly manifest:LiveSetupManifest;readonly upstreamHead:string;readonly forkHead:string;
  readonly driverCredential:"not-supplied"|"verified";readonly readyForMutations:false;readonly getAttempts:number;
}
const HEADERS=Object.freeze({accept:"application/vnd.github+json","x-github-api-version":"2022-11-28"}),WORK_MS=600000,MAX_GETS=60;
const nativeState=Object.getOwnPropertySymbols(new AbortController().signal).find(symbol=>symbol.description==="kAborted");
const bytePrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native intrinsics are invoked with Reflect.apply and their checked receivers.
const signalState=Object.getOwnPropertyDescriptor(AbortSignal.prototype,"aborted")?.get,addListener=EventTarget.prototype.addEventListener,removeListener=EventTarget.prototype.removeEventListener,promiseThen=Promise.prototype.then;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Native byte getters and copy ignore callback-owned properties, methods and iterators.
const byteLength=Object.getOwnPropertyDescriptor(bytePrototype,"byteLength")?.get,byteBuffer=Object.getOwnPropertyDescriptor(bytePrototype,"buffer")?.get,byteTag=Object.getOwnPropertyDescriptor(bytePrototype,Symbol.toStringTag)?.get,copyBytes=Uint8Array.prototype.set;
function fail():never{throw new Error("live-preflight: preflight-refused");}
function aborted(signal:unknown):boolean{
  if(typeof signal!=="object"||signal===null||types.isProxy(signal)||Object.getPrototypeOf(signal)!==AbortSignal.prototype||nativeState===undefined||signalState===undefined||typeof Object.getOwnPropertyDescriptor(signal,nativeState)?.value!=="boolean")fail();
  for(const key of Object.getOwnPropertySymbols(signal)){const descriptor=Object.getOwnPropertyDescriptor(signal,key);if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();}
  const state:unknown=Reflect.apply(signalState,signal,[]);if(typeof state!=="boolean")fail();return state;
}
function watch(signal:AbortSignal,listener:()=>void):()=>void{
  aborted(signal);
  // Automatic once removal invokes a foreign native hook before the abort callback.
  // Account for listeners explicitly so hook failure cannot prevent settlement.
  try{Reflect.apply(addListener,signal,["abort",listener]);}catch{try{Reflect.apply(removeListener,signal,["abort",listener]);}catch{/* Native unlink precedes its hook. */}fail();}
  return ()=>{Reflect.apply(removeListener,signal,["abort",listener]);};
}
function ownField(value:unknown,key:string):unknown{
  if(typeof value!=="object"||value===null||types.isProxy(value))fail();
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();return descriptor.value;
}
/** Observe native response bytes immediately in fulfillment, before another await. */
function ownResponse(value:unknown):HttpResponse{
  const status=ownField(value,"status"),headersValue=ownField(value,"headers"),supplied=ownField(value,"body");
  if(typeof status!=="number"||!Number.isSafeInteger(status)||status<100||status>599)fail();
  if(typeof supplied!=="object"||supplied===null||types.isProxy(supplied)||byteTag===undefined||byteLength===undefined||byteBuffer===undefined||Reflect.apply(byteTag,supplied,[])!=="Uint8Array")fail();
  const length:unknown=Reflect.apply(byteLength,supplied,[]),buffer:unknown=Reflect.apply(byteBuffer,supplied,[]);
  if(typeof length!=="number"||!Number.isSafeInteger(length)||length<0||length>LIMITS.maxJsonBytes||types.isSharedArrayBuffer(buffer))fail();
  const body=new Uint8Array(length);Reflect.apply(copyBytes,body,[supplied]);
  if(typeof headersValue!=="object"||headersValue===null||types.isProxy(headersValue)||Array.isArray(headersValue))fail();
  const keys=Object.keys(headersValue);if(keys.length>128)fail();const headers:Record<string,string>=Object.create(null) as Record<string,string>;let size=0;
  for(const key of keys){const entry=ownField(headersValue,key);if(typeof entry!=="string"||!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key)||!/^[\x20-\x7e]*$/.test(entry))fail();const name=key.toLowerCase();if(Object.hasOwn(headers,name))fail();size+=key.length+entry.length;if(size>16384)fail();headers[name]=entry;}
  const lengthHeader=headers["content-length"];if(lengthHeader!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(lengthHeader)||!Number.isSafeInteger(Number(lengthHeader))||Number(lengthHeader)>LIMITS.maxJsonBytes))fail();
  return Object.freeze({status,headers:Object.freeze(headers),body});
}
function object(value:JsonValue|undefined):JsonObject{if(typeof value!=="object"||value===null||Array.isArray(value))fail();return value;}
function integer(value:JsonValue|undefined,minimum=1):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<minimum)fail();return value;}
function id(value:JsonValue|undefined,expected:string):void{if(String(integer(value))!==expected)fail();}
function same(value:JsonValue|undefined,expected:JsonValue):void{if(value!==expected)fail();}
function head(value:JsonValue):string{const root=object(value),commit=object(root["object"]);same(root["ref"],"refs/heads/main");same(commit["type"],"commit");const sha=commit["sha"];if(typeof sha!=="string"||!/^[0-9a-f]{40}$/.test(sha))fail();return sha;}
interface OwnedJson {readonly value:JsonValue;readonly headers:Readonly<Record<string,string>>}

/** Read-only setup identity checks; never credential grants or resource authorization. */
export class LiveInfrastructurePreflight {
  readonly #manifest:LiveSetupManifest;readonly #transport:HttpTransport;readonly #timing:Timing;
  readonly #request:HttpTransport["request"];readonly #deadline:Timing["deadline"];readonly #delay:Timing["delay"];readonly #credential:string|undefined;
  #attempts=0;
  constructor(bytes:Uint8Array,expectedOrganization:string,options:LivePreflightOptions){
    try{
      // Parse all target authority before observing ports or an explicit credential.
      const manifest=parseLiveSetupManifest(bytes,expectedOrganization);
      const supplied:unknown=options;if(typeof supplied!=="object"||supplied===null||types.isProxy(supplied))fail();const suppliedTransport:unknown=options.transport,suppliedTiming:unknown=options.timing,credential:unknown=options.credential;
      if(typeof suppliedTransport!=="object"||suppliedTransport===null||types.isProxy(suppliedTransport)||typeof suppliedTiming!=="object"||suppliedTiming===null||types.isProxy(suppliedTiming))fail();
      const transport=suppliedTransport as HttpTransport,timing=suppliedTiming as Timing;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured once, invoked with Reflect.apply and the original stable receiver.
      const request=transport.request,deadline=timing.deadline,delay=timing.delay;
      if(typeof request!=="function"||typeof deadline!=="function"||typeof delay!=="function"||(credential!==undefined&&(typeof credential!=="string"||!/^[\x21-\x7e]{1,1024}$/.test(credential))))fail();
      this.#manifest=manifest;this.#transport=transport;this.#timing=timing;this.#request=request;this.#deadline=deadline;this.#delay=delay;this.#credential=credential;
    }catch{fail();}
  }
  #bounded<T>(ms:number,invoke:(signal:AbortSignal)=>Promise<unknown>,capture:(value:unknown)=>T,caller?:AbortSignal):Promise<T>{
    return new Promise<T>((resolve,reject)=>{
      const controller=new AbortController(),removers:(()=>void)[]=[];let dispose:(()=>void)|undefined,settled=false;
      const finish=(ok:boolean,value:unknown):void=>{
        if(settled)return;settled=true;let cleanupFailed=false;
        for(const remove of removers)try{remove();}catch{cleanupFailed=true;}
        if(dispose!==undefined)try{dispose();}catch{cleanupFailed=true;}
        if(ok&&!cleanupFailed)resolve(value as T);else reject(new Error("live-preflight: preflight-refused"));
      };
      const cancel=():void=>{try{controller.abort();}catch{/* Independent settlement must still run. */}finish(false,undefined);};
      const subscribe=(signal:AbortSignal):void=>{
        let acquired=false,early=false;const remove=watch(signal,()=>{if(acquired)cancel();else early=true;});removers.push(remove);acquired=true;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Native registration hooks can synchronously dispatch an abort.
        if(early)cancel();
      };
      try{
        if(caller!==undefined&&aborted(caller)){finish(false,undefined);return;}
        const supplied:unknown=Reflect.apply(this.#deadline,this.#timing,[ms]);if(typeof supplied!=="object"||supplied===null||types.isProxy(supplied))fail();const handle=supplied as ReturnType<Timing["deadline"]>;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain disposal before reading signal, including partial acquisition failure.
        const cleanup=handle.dispose;if(typeof cleanup!=="function")fail();dispose=()=>{Reflect.apply(cleanup,handle,[]);};
        const deadlineSignal=handle.signal;if(aborted(deadlineSignal)){cancel();return;}subscribe(deadlineSignal);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- A native registration hook can settle synchronously.
        if(!settled&&caller!==undefined)subscribe(caller);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Synchronous native hook settlement must prevent invoking a port.
        if(settled)return;
        if(aborted(deadlineSignal)||(caller!==undefined&&aborted(caller))){cancel();return;}
        const pending=invoke(controller.signal);if(!types.isPromise(pending)||types.isProxy(pending))fail();
        void Reflect.apply(promiseThen,pending,[(value:unknown)=>{if(settled)return;try{finish(true,capture(value));}catch{finish(false,undefined);}},()=>{finish(false,undefined);}]);
      }catch{finish(false,undefined);}
    });
  }
  async #get(url:string,signal:AbortSignal,authenticate=false):Promise<OwnedJson>{
    for(let attempt=0;attempt<LIMITS.maxAttempts;attempt++){
      const response=await this.#bounded(LIMITS.requestMs,requestSignal=>{
        if(aborted(signal)||this.#attempts>=MAX_GETS)fail();this.#attempts++;
        const headers=authenticate?Object.freeze({...HEADERS,authorization:`Bearer ${this.#credential??""}`}):HEADERS;
        return Reflect.apply<HttpTransport,Parameters<HttpTransport["request"]>,Promise<HttpResponse>>(this.#request,this.#transport,[Object.freeze({method:"GET",url,headers,maxBytes:LIMITS.maxJsonBytes,signal:requestSignal})]);
      },ownResponse,signal);
      if(response.status===200)return {value:parseJson(response.body,{maxBytes:LIMITS.maxJsonBytes,maxDepth:32}),headers:response.headers};
      const after=response.headers["retry-after"],retry=response.status===429||response.status>=500||(response.status===403&&(after!==undefined||response.headers["x-ratelimit-remaining"]==="0"));
      if(!retry||attempt===LIMITS.maxAttempts-1)fail();let delay=1000*(attempt+1);
      if(after!==undefined){if(!/^(0|[1-9][0-9]{0,4})$/.test(after)||Number(after)*1000>LIMITS.maxRetryDelayMs)fail();delay=Number(after)*1000;}
      await this.#bounded(LIMITS.requestMs,requestSignal=>Reflect.apply<Timing,Parameters<Timing["delay"]>,Promise<void>>(this.#delay,this.#timing,[delay,requestSignal]),()=>undefined,signal);
    }
    return fail();
  }
  #repository(value:JsonValue|undefined,name:string,repositoryId:string,isFork:boolean):JsonObject{
    const root=object(value),owner=object(root["owner"]),manifest=this.#manifest;id(root["id"],repositoryId);same(root["name"],name);same(root["full_name"],`${manifest.organization.login}/${name}`);same(root["private"],false);same(root["visibility"],"public");same(root["default_branch"],"main");same(root["fork"],isFork);id(owner["id"],manifest.organization.id);same(owner["login"],manifest.organization.login);same(owner["type"],"Organization");return root;
  }
  #bot(value:JsonValue):void{const root=object(value);id(root["id"],this.#manifest.bot.id);same(root["login"],this.#manifest.bot.login);same(root["type"],"User");}
  #policy(response:OwnedJson,expectedUrl:string):void{
    const root=object(response.value),count=integer(root["total_count"],0),policies=root["branch_policies"];
    if(count>LIMITS.maxComments||!Array.isArray(policies)||policies.length>100||policies.length>LIMITS.maxComments||policies.length!==count||count!==1)fail();
    const policy=object(policies[0]);integer(policy["id"]);same(policy["name"],"main");same(policy["type"],"branch");
    // Exactly one rule fits on the first page. Only fixed page-one first/last links
    // corroborate that terminal proof; returned URLs never select a request.
    const link=response.headers["link"];if(link!==undefined){
      const items=link.split(","),relations=new Set<string>();if(items.length===0||items.length>2)fail();
      for(const item of items){const match=/^<([^<>\s]+)>;\s*rel="(first|last)"$/.exec(item.trim());if(match===null||match[1]!==expectedUrl||match[2]===undefined||relations.has(match[2]))fail();relations.add(match[2]);}
    }
  }
  async #verify(signal:AbortSignal):Promise<LivePreflightResult>{
    const manifest=this.#manifest,organization=manifest.organization.login,upstream=`https://api.github.com/repos/${organization}/${manifest.upstream.name}`,fork=`https://api.github.com/repos/${organization}/${manifest.fork.name}`;
    const org=object((await this.#get(`https://api.github.com/orgs/${organization}`,signal)).value);id(org["id"],manifest.organization.id);same(org["login"],organization);same(org["type"],"Organization");
    this.#repository((await this.#get(upstream,signal)).value,manifest.upstream.name,manifest.upstream.id,false);
    const forkRepo=this.#repository((await this.#get(fork,signal)).value,manifest.fork.name,manifest.fork.id,true);this.#repository(forkRepo["parent"],manifest.upstream.name,manifest.upstream.id,false);this.#repository(forkRepo["source"],manifest.upstream.name,manifest.upstream.id,false);
    this.#bot((await this.#get(`https://api.github.com/users/${manifest.bot.login}`,signal)).value);
    for(const identity of [manifest.workflows.source,manifest.workflows.report]){const workflow=object((await this.#get(`${upstream}/actions/workflows/${identity.id}`,signal)).value);id(workflow["id"],identity.id);same(workflow["path"],identity.path);same(workflow["state"],"active");}
    const pages=object((await this.#get(`${upstream}/pages`,signal)).value);same(pages["html_url"],manifest.pages.url);same(pages["build_type"],"workflow");same(pages["cname"],null);same(pages["https_enforced"],true);same(pages["public"],true);
    const environment=object((await this.#get(`${upstream}/environments/github-pages`,signal)).value),branchPolicy=object(environment["deployment_branch_policy"]);id(environment["id"],manifest.pages.environment.id);same(environment["name"],"github-pages");same(branchPolicy["protected_branches"],false);same(branchPolicy["custom_branch_policies"],true);
    const policyUrl=`${upstream}/environments/github-pages/deployment-branch-policies?per_page=100&page=1`;this.#policy(await this.#get(policyUrl,signal),policyUrl);
    const upstreamHead=head((await this.#get(`${upstream}/git/ref/heads/main`,signal)).value),forkHead=head((await this.#get(`${fork}/git/ref/heads/main`,signal)).value);
    const driverCredential=this.#credential===undefined?"not-supplied":"verified";
    if(this.#credential!==undefined)this.#bot((await this.#get("https://api.github.com/user",signal,true)).value);
    if(aborted(signal))fail();return Object.freeze({manifest,upstreamHead,forkHead,driverCredential,readyForMutations:false,getAttempts:this.#attempts});
  }
  read(signal?:AbortSignal):Promise<LivePreflightResult>{return this.#bounded(WORK_MS,requestSignal=>this.#verify(requestSignal),value=>value as LivePreflightResult,signal);}
}

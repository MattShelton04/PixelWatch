import {types} from "node:util";
import {isGitHubId,parseJson,type JsonObject} from "../../packages/schemas/src/index.ts";

/** Operator-approved fixed setup data. Validation is not infrastructure authorization. */
export interface LiveRcIdentity {readonly version:string;readonly sourceCommit:string;readonly releaseCommit:string}
export interface LiveSetupManifest {
  readonly schemaVersion:1;readonly driverSourceSha:string;
  readonly organization:{readonly login:string;readonly id:string};
  readonly upstream:{readonly name:"pixelwatch-m2-live";readonly id:string;readonly ownerId:string;readonly defaultBranch:"main";readonly visibility:"public"};
  readonly fork:{readonly name:"pixelwatch-m2-live-fork";readonly id:string;readonly ownerId:string;readonly defaultBranch:"main";readonly visibility:"public";readonly fork:true;readonly parentId:string;readonly sourceId:string};
  readonly bot:{readonly login:string;readonly id:string};
  readonly workflows:{readonly source:{readonly id:string;readonly path:".github/workflows/pixelwatch-capture.yml"};readonly report:{readonly id:string;readonly path:".github/workflows/pixelwatch-report.yml"}};
  readonly pages:{readonly url:string;readonly prefix:"pixelwatch";readonly environment:{readonly id:string;readonly name:"github-pages";readonly protectedBranches:false;readonly customBranchPolicies:true;readonly policies:readonly {readonly name:"main";readonly type:"branch"}[]}};
  readonly publisher:{readonly current:LiveRcIdentity;readonly older:LiveRcIdentity};
  readonly approvedRefs:readonly string[];
}
export interface LiveRunIdentity {
  readonly eventName:string;readonly headRef:string;readonly ref:string;
  readonly repository:string;readonly workflowRepository:string;
  readonly workflowSha:string;readonly checkedOutSha:string;
}
export type TrustedLiveRun = {readonly ok:true;readonly manifest:LiveSetupManifest}|{readonly ok:false;readonly reason:"untrusted-run"|"manifest-refused"};
export const liveDriverCredentialKey="PIXELWATCH_E2E_DRIVER_TOKEN";
const MAX_BYTES=1024*1024,PRODUCT="MattShelton04/PixelWatch";
const refs=["same-repo","fork","fork-hostile","full-rerun","partial-rerun","stale-head","deploy-repair","older-pin"].map(name=>`refs/heads/pixelwatch-e2e/m2/${name}`);
const NativeBytes=Uint8Array,typedPrototype=Object.getPrototypeOf(NativeBytes.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds the captured native getters and set to their checked native views.
const nativeLength=Object.getOwnPropertyDescriptor(typedPrototype,"byteLength")?.get,nativeTag=Object.getOwnPropertyDescriptor(typedPrototype,Symbol.toStringTag)?.get,nativeSet=NativeBytes.prototype.set;
function fail():never{throw new Error("live-manifest: manifest-refused");}
function nativeBytes(value:Uint8Array):Uint8Array{
  if(types.isProxy(value)||nativeLength===undefined||nativeTag===undefined)fail();
  const tag:unknown=Reflect.apply(nativeTag,value,[]),length:unknown=Reflect.apply(nativeLength,value,[]);
  if(tag!=="Uint8Array"||typeof length!=="number"||!Number.isSafeInteger(length)||length<0||length>MAX_BYTES)fail();
  const captured=new NativeBytes(length);Reflect.apply(nativeSet,captured,[value]);return captured;
}
function exact(value:unknown,keys:readonly string[]):JsonObject{
  if(typeof value!=="object"||value===null||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const present=Object.keys(value);if(present.length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();return value as JsonObject;
}
function string(value:unknown):string{if(typeof value!=="string")fail();return value;}
function id(value:unknown):string{const result=string(value);if(!isGitHubId(result))fail();return result;}
function sha(value:unknown):string{const result=string(value);if(!/^[0-9a-f]{40}$/.test(result))fail();return result;}
function login(value:unknown):string{const result=string(value);if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(result))fail();return result;}
function literal(value:unknown,expected:unknown):void{if(value!==expected)fail();}
function rc(value:unknown):LiveRcIdentity{
  const input=exact(value,["version","sourceCommit","releaseCommit"]),version=string(input["version"]),sourceCommit=sha(input["sourceCommit"]),releaseCommit=sha(input["releaseCommit"]);
  if(!/^0\.1\.0-rc\.[1-9][0-9]{0,18}$/.test(version)||sourceCommit===releaseCommit)fail();return {version,sourceCommit,releaseCommit};
}
/** Freeze only privately parsed JSON, never caller objects or methods. */
function freeze(value:unknown):void{
  if(typeof value!=="object"||value===null)return;for(const child of Object.values(value))freeze(child);Object.freeze(value);
}
export function parseLiveSetupManifest(bytes:Uint8Array,expectedOrganization:string):LiveSetupManifest {
  try{
    const approvedOrganization=login(expectedOrganization);if(approvedOrganization.toLowerCase()==="mattshelton04")fail();
    const root=exact(parseJson(nativeBytes(bytes),{maxBytes:MAX_BYTES,maxDepth:16}),["schemaVersion","driverSourceSha","organization","upstream","fork","bot","workflows","pages","publisher","approvedRefs"]);
    literal(root["schemaVersion"],1);sha(root["driverSourceSha"]);
    const organization=exact(root["organization"],["login","id"]),organizationId=id(organization["id"]);literal(login(organization["login"]),approvedOrganization);
    const upstream=exact(root["upstream"],["name","id","ownerId","defaultBranch","visibility"]),upstreamId=id(upstream["id"]);
    literal(upstream["name"],"pixelwatch-m2-live");literal(id(upstream["ownerId"]),organizationId);literal(upstream["defaultBranch"],"main");literal(upstream["visibility"],"public");
    const fork=exact(root["fork"],["name","id","ownerId","defaultBranch","visibility","fork","parentId","sourceId"]);if(id(fork["id"])===upstreamId)fail();
    literal(fork["name"],"pixelwatch-m2-live-fork");literal(id(fork["ownerId"]),organizationId);literal(fork["defaultBranch"],"main");literal(fork["visibility"],"public");literal(fork["fork"],true);literal(id(fork["parentId"]),upstreamId);literal(id(fork["sourceId"]),upstreamId);
    const bot=exact(root["bot"],["login","id"]);login(bot["login"]);id(bot["id"]);
    const workflows=exact(root["workflows"],["source","report"]),source=exact(workflows["source"],["id","path"]),report=exact(workflows["report"],["id","path"]);
    if(id(source["id"])===id(report["id"]))fail();literal(source["path"],".github/workflows/pixelwatch-capture.yml");literal(report["path"],".github/workflows/pixelwatch-report.yml");
    const pages=exact(root["pages"],["url","prefix","environment"]);literal(pages["url"],`https://${approvedOrganization.toLowerCase()}.github.io/pixelwatch-m2-live/`);literal(pages["prefix"],"pixelwatch");
    const environment=exact(pages["environment"],["id","name","protectedBranches","customBranchPolicies","policies"]);id(environment["id"]);literal(environment["name"],"github-pages");literal(environment["protectedBranches"],false);literal(environment["customBranchPolicies"],true);
    const policies=environment["policies"];if(!Array.isArray(policies)||policies.length!==1)fail();const policy=exact(policies[0],["name","type"]);literal(policy["name"],"main");literal(policy["type"],"branch");
    const publisher=exact(root["publisher"],["current","older"]),current=rc(publisher["current"]),older=rc(publisher["older"]);
    if(current.version===older.version||current.releaseCommit===older.releaseCommit||BigInt(current.version.slice(9))<=BigInt(older.version.slice(9)))fail();
    const approvedRefs=root["approvedRefs"];if(!Array.isArray(approvedRefs)||approvedRefs.length!==refs.length||approvedRefs.some((ref,index)=>ref!==refs[index]))fail();
    freeze(root);return root as unknown as LiveSetupManifest;
  }catch{return fail();}
}
/** Observe only explicit trusted runner identity fields; this module never looks up a credential. */
export function evaluateTrustedLiveRun(bytes:Uint8Array|undefined,expectedOrganization:string,run:unknown):TrustedLiveRun {
  let captured:Record<string,string>;
  try{
    if(typeof run!=="object"||run===null||types.isProxy(run)||Object.getPrototypeOf(run)!==Object.prototype)return {ok:false,reason:"untrusted-run"};
    captured={};for(const key of ["eventName","headRef","ref","repository","workflowRepository","workflowSha","checkedOutSha"]){const descriptor=Object.getOwnPropertyDescriptor(run,key);if(descriptor===undefined||!Object.hasOwn(descriptor,"value")||typeof descriptor.value!=="string")return {ok:false,reason:"untrusted-run"};captured[key]=descriptor.value;}
    if(!["workflow_dispatch","schedule"].includes(captured["eventName"]??"")||captured["headRef"]!==""||captured["ref"]!=="refs/heads/main"||captured["repository"]!==PRODUCT||captured["workflowRepository"]!==PRODUCT||sha(captured["workflowSha"])!==sha(captured["checkedOutSha"]))return {ok:false,reason:"untrusted-run"};
  }catch{return {ok:false,reason:"untrusted-run"};}
  let manifest:LiveSetupManifest;try{if(bytes===undefined)return {ok:false,reason:"manifest-refused"};manifest=parseLiveSetupManifest(bytes,expectedOrganization);}catch{return {ok:false,reason:"manifest-refused"};}
  if(captured["workflowSha"]!==manifest.driverSourceSha)return {ok:false,reason:"untrusted-run"};return {ok:true,manifest};
}

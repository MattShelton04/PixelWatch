import {createHash} from "node:crypto";
import {types} from "node:util";
import {classifyStorePath,deriveStreams,prPointerPath,sizeLimits} from "../../../packages/core/src/index.ts";
import {canonicalBytes,isGitHubId,parseDocument,parseJson,type Run} from "../../../packages/schemas/src/index.ts";
import {STORE_LIMITS} from "../../../packages/store/src/index.ts";
import {assembleSite} from "../../../packages/publisher/src/assemble.ts";
import {validateTree} from "../../../packages/publisher/src/admission-input.ts";
import {captureContext,checkedDocument,checkedOid,copyBytes} from "../../../packages/publisher/src/assembly-input.ts";
import type {PreparedProjection,ProjectionDeferred,ProjectionWarning,ReadinessTarget} from "../../../packages/publisher/src/types.ts";
import type {SiteFile} from "./host-files.ts";

/** Trusted same-job identity, independent of every persisted capsule field. */
export interface CapsuleBinding {
  readonly owner:string;readonly name:string;
  readonly repositoryId:string;readonly runId:string;readonly attempt:number;
  readonly workflowPath:string;readonly headSha:string;readonly ref:string;readonly runnerName:string;
  readonly workflowSha:string;readonly sourceCommit:string;readonly release:string;
}
const MAX_BYTES=64*1024*1024,MAX_FILES=3*STORE_LIMITS.maxFiles+2*1001+16;
const categories=["html","app","api","stubs","data","blobs","derived","grace"] as const;
const deferredReasons=["comment-disabled","pr-closed","pr-unavailable","no-eligible-run","pointer-mismatch","head-changed","comment-order-unproved"] as const;
const warningCodes=["timing-disposal-failed","store-close-failed","listener-cleanup-failed"] as const;
const nativeArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply binds these captured native getters to the checked view.
const nativeLength=Object.getOwnPropertyDescriptor(nativeArrayPrototype,"byteLength")?.get,nativeTag=Object.getOwnPropertyDescriptor(nativeArrayPrototype,Symbol.toStringTag)?.get;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function fail():never {throw new Error("pixelwatch-action: capsule-refused");}
function id(value:unknown):value is string{return typeof value==="string"&&isGitHubId(value);}
function plain(value:unknown):Record<string,unknown>{
  if(typeof value!=="object"||value===null||types.isProxy(value)||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();return value as Record<string,unknown>;
}
function field(value:Record<string,unknown>,key:string):unknown {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();return descriptor.value as unknown;
}
function select(value:unknown,keys:readonly string[]):Record<string,unknown>{
  const source=plain(value),result:Record<string,unknown>={};for(const key of keys)result[key]=field(source,key);return result;
}
function nativeArray(value:unknown,bound:number):readonly unknown[]{
  if(typeof value!=="object"||value===null||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>bound)fail();return value as readonly unknown[];
}
function item(value:readonly unknown[],index:number):unknown{
  const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();return descriptor.value as unknown;
}
function byteLength(value:unknown):number{
  if(typeof value!=="object"||value===null||types.isProxy(value)||nativeLength===undefined||nativeTag===undefined)fail();
  const tag:unknown=Reflect.apply(nativeTag,value,[]),length:unknown=Reflect.apply(nativeLength,value,[]);
  if(tag!=="Uint8Array"||typeof length!=="number"||!Number.isSafeInteger(length)||length<0)fail();return length;
}
/** Capture plain data and count its exact canonical UTF-8 length before whole serialization. */
function captureJson(value:unknown,maximum=MAX_BYTES):{value:unknown;bytes:number}{
  let bytes=0;const ancestors=new Set<object>();
  const add=(count:number)=>{bytes+=count;if(bytes>maximum)fail();};
  const string=(value:string)=>{
    if(!value.isWellFormed())fail();add(2);
    for(let index=0;index<value.length;index++){
      const code=value.charCodeAt(index);
      if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)add(2);
      else if(code<32)add(6);else if(code<128)add(1);else if(code<2048)add(2);
      else if(code>=0xd800&&code<=0xdbff){add(4);index++;}else add(3);
    }
  };
  const visit=(value:unknown,depth:number):unknown=>{
    if(depth>32)fail();
    if(value===null){add(4);return null;}
    if(typeof value==="boolean"){add(value?4:5);return value;}
    if(typeof value==="number"){if(!Number.isSafeInteger(value)||Object.is(value,-0))fail();add(String(value).length);return value;}
    if(typeof value==="string"){string(value);return value;}
    if(typeof value!=="object"||types.isProxy(value)||ancestors.has(value))fail();ancestors.add(value);
    try {
      if(Array.isArray(value)){
        if(value.length>MAX_FILES)fail();add(2);const result:unknown[]=[];
        for(let index=0;index<value.length;index++){if(index>0)add(1);const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();result.push(visit(descriptor.value as unknown,depth+1));}return result;
      }
      const source=plain(value),keys=Object.keys(source);if(keys.length>64)fail();add(2);const result:Record<string,unknown>={};
      for(let index=0;index<keys.length;index++){const key=keys[index];if(key===undefined||["__proto__","constructor","prototype"].includes(key))fail();if(index>0)add(1);string(key);add(1);result[key]=visit(field(source,key),depth+1);}return result;
    }finally{ancestors.delete(value);}
  };
  return {value:visit(value,0),bytes};
}
function binding(value:CapsuleBinding):CapsuleBinding{
  const captured=captureJson(select(value,["owner","name","repositoryId","runId","attempt","workflowPath","headSha","ref","runnerName","workflowSha","sourceCommit","release"])).value as CapsuleBinding;
  if(!isGitHubId(captured.repositoryId)||!isGitHubId(captured.runId)||!Number.isSafeInteger(captured.attempt)||captured.attempt<1||captured.attempt>2147483647
    ||typeof captured.owner!=="string"||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(captured.owner)
    ||typeof captured.name!=="string"||!/^[A-Za-z0-9_.-]{1,100}$/.test(captured.name)||captured.name==="."||captured.name===".."
    ||typeof captured.workflowPath!=="string"||!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(captured.workflowPath)
    ||typeof captured.ref!=="string"||!captured.ref.startsWith("refs/heads/")||typeof captured.runnerName!=="string"||captured.runnerName.length===0||captured.runnerName.length>1024
    ||typeof captured.release!=="string"||!/^0\.1\.0(?:-rc\.[1-9][0-9]{0,18})?$/.test(captured.release))fail();
  for(const value of [captured.headSha,captured.workflowSha,captured.sourceCommit])if(typeof value!=="string"||!/^[0-9a-f]{40}$/.test(value))fail();return captured;
}
function same(a:unknown,b:unknown):boolean{return Buffer.from(canonicalBytes(a)).equals(canonicalBytes(b));}
function list(value:unknown,bound:number):readonly unknown[]{return nativeArray(value,bound);}
function captureFiles(source:readonly SiteFile[],metadata:readonly unknown[],hardBytes:number):PreparedProjection["site"]["files"]{
  const supplied=nativeArray(source,MAX_FILES);if(supplied.length!==metadata.length)fail();let total=0;const seen=new Set<string>(),result:PreparedProjection["site"]["files"][number][]=[];
  for(let index=0;index<supplied.length;index++){
    const file=plain(item(supplied,index));
    const meta=plain(metadata[index]);const path=field(meta,"path"),category=field(meta,"category"),immutable=field(meta,"immutable"),sha256=field(meta,"sha256"),size=field(meta,"bytes");
    if(typeof path!=="string"||path.length>1024||seen.has(path)||typeof category!=="string"||!categories.includes(category as typeof categories[number])||typeof immutable!=="boolean"
      ||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256)||!Number.isSafeInteger(size)||typeof size!=="number"||size<0||field(file,"path")!==path||field(file,"sha256")!==sha256)fail();seen.add(path);
    const bytes=copyBytes(field(file,"bytes") as Uint8Array,Math.min(hardBytes-total,path.endsWith(".png")?STORE_LIMITS.maxPngBytes:path.endsWith(".json")?STORE_LIMITS.maxJsonBytes:hardBytes),size);
    total+=bytes.byteLength;if(hash(bytes)!==sha256)fail();result.push({path,category:category as typeof categories[number],immutable,sha256,bytes});
  }return result;
}
async function restore(document:unknown,expected:CapsuleBinding,script:Uint8Array,sourceFiles:readonly SiteFile[]):Promise<PreparedProjection>{
  const root=plain(document);if(field(root,"schemaVersion")!==1||!same(field(root,"binding"),expected))fail();
  const value=plain(field(root,"prepared"));if(field(value,"schemaVersion")!==1)fail();
  const serializedContext=plain(field(value,"context")),assets=plain(field(serializedContext,"assets"));
  const config=checkedDocument("config",captureJson(field(serializedContext,"config"),STORE_LIMITS.maxJsonBytes).value as PreparedProjection["context"]["config"]);
  const nativeScript=copyBytes(script,sizeLimits(config).hardBytes);if(field(assets,"scriptSha256")!==hash(nativeScript))fail();
  const context=captureContext({...serializedContext,config,assets:{release:field(assets,"release"),releaseCommit:field(assets,"releaseCommit"),script:nativeScript}} as PreparedProjection["context"]);
  const defaultBranch=field(value,"defaultBranch"),report=plain(field(value,"report")),environment=plain(field(value,"environment")),deployment=plain(field(value,"deployment"));
  if(typeof defaultBranch!=="string"||defaultBranch.length===0||expected.ref!==`refs/heads/${defaultBranch}`||context.repository.repositoryId!==expected.repositoryId||context.repository.owner!==expected.owner||context.repository.name!==expected.name
    ||context.assets.release!==expected.release||context.assets.releaseCommit!==expected.workflowSha)fail();
  for(const key of ["runId","attempt","workflowPath","headSha","ref","runnerName"] as const)if(field(report,key)!==expected[key])fail();
  const workflowId=report["workflowId"];if(workflowId!==undefined&&!id(workflowId))fail();
  if(!id(field(environment,"environmentId"))||field(environment,"defaultBranch")!==defaultBranch||field(deployment,"complete")!==true)fail();
  const current=plain(field(deployment,"current"));if(!id(field(current,"deploymentId"))||!id(field(current,"jobId")))fail();
  const states=list(field(current,"states"),1024),prior=list(field(deployment,"priorDeploymentIds"),1024),ids=new Set([field(current,"deploymentId")]);
  if(states.length===0||states.some(state=>typeof state!=="string"||!["waiting","queued","pending","in_progress","success","failure","error","inactive"].includes(state)))fail();
  for(const value of prior){if(!id(value)||ids.has(value))fail();ids.add(value);}
  const store=checkedDocument("store",field(value,"store") as PreparedProjection["store"]),records=list(field(value,"records"),STORE_LIMITS.maxFiles).map(record=>checkedDocument("run",record as Run));
  const runs=new Map(records.map(record=>[record.runKey,record]));if(runs.size!==records.length||store.repositoryId!==expected.repositoryId)fail();
  const site=plain(field(value,"site")),tip=checkedOid(field(site,"storeTip") as string),limits=sizeLimits(context.config),files=captureFiles(sourceFiles,list(field(site,"files"),MAX_FILES),limits.hardBytes);
  const stored=new Map(files.filter(file=>{const kind=classifyStorePath(file.path)?.kind;return kind==="run"||kind==="blob"||kind==="derived";}).map(file=>[file.path,file.bytes]));stored.set("store.json",canonicalBytes(store));
  validateTree({store,runs,files:stored,metadata:{timestamp:"2000-01-01T00:00:00Z"}},expected.repositoryId);
  const actual=await assembleSite({...context,snapshot:{tip,store,runs,files:[...stored].map(([path,bytes])=>({path,bytes:bytes.byteLength})),readFile:path=>{const bytes=stored.get(path);if(bytes===undefined)fail();return Promise.resolve(bytes);}}});
  const actualMetadata=siteMetadata(actual,limits.hardBytes);if(!same(site,actualMetadata)||files.some((file,index)=>{const generated=actual.files[index];return generated===undefined||file.path!==generated.path||!Buffer.from(file.bytes).equals(generated.bytes);}))fail();
  const streams=deriveStreams(store).filter(stream=>stream.streamId.startsWith("pr-")),retained=new Set(streams.map(stream=>stream.streamId.slice(3))),covered=new Set<string>();
  const targets:ReadinessTarget[]=list(field(value,"targets"),1000).map(target=>{
    const input=plain(target),prNumber=field(input,"prNumber"),runKey=field(input,"runKey"),headSha=field(input,"headSha");
    if(!id(prNumber)||typeof runKey!=="string"||typeof headSha!=="string"||covered.has(prNumber)||!retained.has(prNumber))fail();
    const record=runs.get(runKey),stream=streams.find(item=>item.streamId===`pr-${prNumber}`),pointerFile=actual.files.find(file=>file.path===prPointerPath(prNumber));
    if(record?.source.event!=="pull_request"||record.source.association.status!=="corroborated"||record.source.association.prNumber!==prNumber||record.source.commits.head!==headSha||stream?.latest!==runKey||pointerFile===undefined)fail();
    const pointer=parseDocument("pr-pointer",pointerFile.bytes);if(!pointer.ok||pointer.value.prNumber!==prNumber||pointer.value.runKey!==runKey||pointer.value.headSha!==headSha||pointer.value.generation!==actual.generation)fail();
    covered.add(prNumber);return {prNumber,runKey,headSha};
  });
  const deferred:ProjectionDeferred[]=list(field(value,"deferred"),1000).map(item=>{
    const input=plain(item),prNumber=field(input,"prNumber"),reason=field(input,"reason");
    if(!id(prNumber)||covered.has(prNumber)||!retained.has(prNumber)||typeof reason!=="string"||!deferredReasons.includes(reason as ProjectionDeferred["reason"]))fail();covered.add(prNumber);return {prNumber,reason:reason as ProjectionDeferred["reason"]};
  });if(covered.size!==retained.size)fail();
  const warnings:ProjectionWarning[]=[],rawWarnings=value["warnings"];
  if(rawWarnings!==undefined)for(const warning of list(rawWarnings,3)){if(typeof warning!=="string"||!warningCodes.includes(warning as ProjectionWarning)||warnings.includes(warning as ProjectionWarning))fail();warnings.push(warning as ProjectionWarning);}
  return {schemaVersion:1,context,defaultBranch,report:report as unknown as PreparedProjection["report"],environment:environment as unknown as PreparedProjection["environment"],deployment:deployment as unknown as PreparedProjection["deployment"],store,records,site:actual,targets,deferred,...(warnings.length===0?{}:{warnings})};
}
function siteMetadata(site:PreparedProjection["site"],hardBytes:number):Record<string,unknown>{
  const source=plain(site),supplied=nativeArray(field(source,"files"),MAX_FILES),files:Record<string,unknown>[]=[],seen=new Set<string>();let total=0;
  for(let index=0;index<supplied.length;index++){
    const file=plain(item(supplied,index)),meta=select(file,["path","category","immutable","sha256"]),path=meta["path"],category=meta["category"],sha256=meta["sha256"];
    if(typeof path!=="string"||path.length>1024||seen.has(path)||typeof category!=="string"||!categories.includes(category as typeof categories[number])||typeof meta["immutable"]!=="boolean"||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256))fail();seen.add(path);
    const bytes=byteLength(field(file,"bytes")),maximum=path.endsWith(".json")?STORE_LIMITS.maxJsonBytes:path.endsWith(".png")?STORE_LIMITS.maxPngBytes:hardBytes;
    if(bytes>maximum||bytes>hardBytes-total)fail();total+=bytes;files.push({...meta,bytes});
  }
  return {...select(source,["generation","storeTip","configCommit","releaseCommit","totalBytes","breakdown","overSoftLimit"]),files};
}
/** The private prepared payload is separate from the immutable staging inventory capsule. */
export async function encodePreparedProjection(prepared:PreparedProjection,sourceBinding:CapsuleBinding):Promise<Uint8Array>{
  try {
    const source=plain(prepared),expected=binding(sourceBinding),sourceContext=plain(field(source,"context")),sourceAssets=plain(field(sourceContext,"assets")),sourceSite=plain(field(source,"site"));
    const config=checkedDocument("config",captureJson(field(sourceContext,"config"),STORE_LIMITS.maxJsonBytes).value as PreparedProjection["context"]["config"]),hardBytes=sizeLimits(config).hardBytes;
    const context={...select(sourceContext,["configCommit","pages","repository"]),config},script=copyBytes(field(sourceAssets,"script") as Uint8Array,hardBytes);
    const descriptor=Object.getOwnPropertyDescriptor(source,"warnings");if(descriptor!==undefined&&!Object.hasOwn(descriptor,"value"))fail();const warnings=descriptor?.value as unknown;
    const value={...select(source,["schemaVersion","defaultBranch","report","environment","deployment","store","records","targets","deferred"]),context:{...context,assets:{...select(sourceAssets,["release","releaseCommit"]),scriptSha256:hash(script)}},site:siteMetadata(sourceSite as unknown as PreparedProjection["site"],hardBytes),...(warnings===undefined?{}:{warnings})};
    const captured=captureJson({schemaVersion:1,binding:expected,prepared:value});await restore(captured.value,expected,script,field(sourceSite,"files") as readonly SiteFile[]);
    const bytes=canonicalBytes(captured.value);if(bytes.byteLength!==captured.bytes)fail();return bytes;
  }catch{return fail();}
}
export async function decodePreparedProjection(bytes:Uint8Array,sourceBinding:CapsuleBinding,script:Uint8Array,files:readonly SiteFile[]):Promise<PreparedProjection>{
  try {return await restore(parseJson(copyBytes(bytes,MAX_BYTES),{maxBytes:MAX_BYTES,maxDepth:32}),binding(sourceBinding),script,files);}catch{return fail();}
}

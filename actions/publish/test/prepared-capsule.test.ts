import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {describe,it,vi} from "vitest";
import {assembleSite} from "../../../packages/publisher/src/assemble.ts";
import {addRun,buildRun,mergeParts,newStore,runRecordPath,siteLocation,siteUrls,type ValidPart} from "../../../packages/core/src/index.ts";
import {canonicalBytes,type Config} from "../../../packages/schemas/src/index.ts";
import type {PreparedProjection,PublisherContext} from "../../../packages/publisher/src/types.ts";
import {assertNoSecrets} from "../../../tools/simulation/capture.ts";
import {decodePreparedProjection,encodePreparedProjection,type CapsuleBinding} from "../src/prepared-capsule.ts";

const oid=(value:string)=>value.repeat(40);
const binding:CapsuleBinding={owner:"owner",name:"project",repositoryId:"42",runId:"41",attempt:2,workflowPath:".github/workflows/pixelwatch-report.yml",headSha:oid("b"),ref:"refs/heads/main",runnerName:"trusted runner",workflowSha:oid("a"),sourceCommit:oid("c"),release:"0.1.0-rc.1"};
async function fixture():Promise<PreparedProjection>{
  const config:Config={schemaVersion:1,source:{workflowIds:["30"],events:["pull_request","push"]},providers:[{id:"fixture",shards:1}]};
  const context:PublisherContext={repository:{owner:"owner",name:"project",repositoryId:"42"},config,configCommit:oid("d"),pages:{url:"https://owner.github.io/project/",host:"owner.github.io"},
    assets:{release:binding.release,releaseCommit:binding.workflowSha,script:new TextEncoder().encode("/* private capsule IO fixture, not production release evidence */")}};
  const store=newStore("42"),storeBytes=canonicalBytes(store),site=await assembleSite({...context,snapshot:{tip:oid("e"),store,runs:new Map(),files:[{path:"store.json",bytes:storeBytes.byteLength}],readFile:()=>Promise.resolve(storeBytes)}});
  return {schemaVersion:1,context,defaultBranch:"main",report:{runId:binding.runId,attempt:binding.attempt,workflowPath:binding.workflowPath,headSha:binding.headSha,ref:binding.ref,runnerName:binding.runnerName},environment:{environmentId:"5",defaultBranch:"main"},
    deployment:{current:{deploymentId:"6",jobId:"7",states:["in_progress"]},priorDeploymentIds:[],complete:true},store,records:[],site,targets:[],deferred:[]};
}
async function retainedFixture():Promise<PreparedProjection>{
  const prepared=await fixture(),config=prepared.context.config;
  const parts:ValidPart[]=(["base","head"] as const).map((revision,index)=>({revision,providerId:"fixture",shard:{index:1,count:1},artifact:{artifactId:String(index+10)},claims:{},units:[{viewId:"fixture",variantId:"default",side:{state:"failed",category:"capture-error"},details:{}}]}));
  const ingestion={...mergeParts({config,baseline:"expected",valid:parts,rejected:[]}),attempt:"1",ignored:[],ignoredOverflow:0};
  const run=buildRun({repositoryId:"42",workflowId:"30",runId:"51",attempt:"1",event:"pull_request",createdAt:"2026-10-03T00:00:00Z",association:{status:"corroborated",prNumber:"7"},commits:{base:oid("1"),head:oid("f")},configSha:oid("d"),releaseSha:binding.workflowSha},ingestion,new Map(),{release:binding.release,config:1,comparator:1,bundle:1,data:1});
  const store=addRun(newStore("42"),run).store,stored=new Map([["store.json",canonicalBytes(store)],[runRecordPath(run.runKey),canonicalBytes(run)]]);
  const site=await assembleSite({...prepared.context,snapshot:{tip:oid("e"),store,runs:new Map([[run.runKey,run]]),files:[...stored].map(([path,bytes])=>({path,bytes:bytes.byteLength})),readFile:path=>{const bytes=stored.get(path);assert.ok(bytes);return Promise.resolve(bytes);}}});
  return {...prepared,store,records:[run],site,targets:[{prNumber:"7",runKey:run.runKey,headSha:oid("f")}]};
}
async function refused(operation:()=>unknown):Promise<void>{let failed=false;try{await operation();}catch(error){failed=true;assert.ok(error instanceof Error);assertNoSecrets([error.stack??error.message]);assert.match(error.message,/^pixelwatch-action: [a-z-]+$/);assert.equal(error.message.includes("not-implemented"),false);}assert.equal(failed,true);}
function mutate(bytes:Uint8Array,change:(value:Record<string,unknown>)=>void):Uint8Array{const parsed=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;change(parsed);return canonicalBytes(parsed);}

describe("private prepared payload persistence (IO fixture, production composition pending)",()=>{
  it("round trips the actual assembled generation with data-only metadata and reconstructed URL methods",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding);assertNoSecrets([bytes]);
    const restored=await decodePreparedProjection(bytes,binding,prepared.context.assets.script,prepared.site.files);
    assert.deepEqual(restored.context,prepared.context);assert.deepEqual(restored.store,prepared.store);assert.deepEqual(restored.site.files,prepared.site.files);
    assert.equal(restored.site.generation,prepared.site.generation);assert.equal(restored.site.urls.siteJson(),siteUrls(siteLocation(prepared.context.config,prepared.context.pages)).siteJson());
    assert.equal(new TextDecoder().decode(bytes).includes("Uint8Array"),false);
  });
  it("foreign repository report attempt product release source and actual app bytes refuse before restoration",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding);
    for(const change of [{repositoryId:"43"},{runId:"40"},{attempt:1},{workflowSha:oid("f")},{sourceCommit:oid("f")},{release:"0.1.0"},{headSha:oid("f")},{workflowPath:".github/workflows/foreign.yml"}])
      await refused(()=>decodePreparedProjection(bytes,{...binding,...change},prepared.context.assets.script,prepared.site.files));
    await refused(()=>decodePreparedProjection(bytes,binding,new TextEncoder().encode("foreign app"),prepared.site.files));
  });
  it("unknown payload config store schema malformed duplicate JSON and oversized metadata fail closed",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding);
    await refused(()=>decodePreparedProjection(mutate(bytes,value=>{value["schemaVersion"]=2;}),binding,prepared.context.assets.script,prepared.site.files));
    await refused(()=>decodePreparedProjection(new TextEncoder().encode('{"schemaVersion":1,"schemaVersion":1}'),binding,prepared.context.assets.script,prepared.site.files));
    await refused(()=>decodePreparedProjection(new Uint8Array(64*1024*1024+1),binding,prepared.context.assets.script,prepared.site.files));
    for(const part of ["config","store"] as const){const bad=await fixture();if(part==="config")(bad.context.config as {schemaVersion:number}).schemaVersion=2;else(bad.store as {schemaVersion:number}).schemaVersion=2;await refused(()=>encodePreparedProjection(bad,binding));}
  });
  it("changed missing duplicated foreign and rehashed active served files cannot restore another generation",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding),first=prepared.site.files[0];assert.ok(first);
    const modified={...first,bytes:new Uint8Array(first.bytes.byteLength).fill(65)};
    for(const files of [[...prepared.site.files.slice(1)],[...prepared.site.files,first],[modified,...prepared.site.files.slice(1)],[...prepared.site.files,{...first,path:"data/v1/hostile.js"}]])
      await refused(()=>decodePreparedProjection(bytes,binding,prepared.context.assets.script,files));
  });
  it("persisted URL lookalikes grant no callback or destination authority",async()=>{
    const prepared=await fixture();let invoked=0;
    const foreignUrls=Object.create(prepared.site.urls) as typeof prepared.site.urls;Object.defineProperty(foreignUrls,"siteJson",{value(){invoked++;throw new Error("foreign callback");}});
    const supplied={...prepared,site:{...prepared.site,urls:foreignUrls}};
    const bytes=await encodePreparedProjection(supplied,binding),restored=await decodePreparedProjection(bytes,binding,prepared.context.assets.script,prepared.site.files);
    assert.equal(invoked,0);assert.equal(restored.site.urls.siteJson(),prepared.site.urls.siteJson());
  });
  it("retained PR records and pointers round trip while aliased targets and changed records refuse",async()=>{
    const prepared=await retainedFixture(),bytes=await encodePreparedProjection(prepared,binding),restored=await decodePreparedProjection(bytes,binding,prepared.context.assets.script,prepared.site.files);
    assert.equal(restored.records.length,1);assert.deepEqual(restored.targets,prepared.targets);assert.deepEqual(restored.records,prepared.records);
    for(const change of [(value:PreparedProjection)=>({...value,targets:[...value.targets,...value.targets]}),(value:PreparedProjection)=>({...value,targets:[{...value.targets[0],prNumber:"8"}]}),(value:PreparedProjection)=>({...value,records:[]})])
      await refused(()=>encodePreparedProjection(change(prepared) as PreparedProjection,binding));
  });
  it("a rehashed active HTML tree and rewritten private manifest still cannot become the actual assembly",async()=>{
    const prepared=await retainedFixture(),bytes=await encodePreparedProjection(prepared,binding),file=prepared.site.files.find(item=>item.path==="index.html");assert.ok(file);
    const altered=new Uint8Array(file.bytes);altered[0]=65;const sha256=createHash("sha256").update(altered).digest("hex");
    const modified=prepared.site.files.map(item=>item===file?{...item,bytes:altered,sha256}:item);
    const forged=mutate(bytes,value=>{const projection=value["prepared"] as {site:{files:{path:string;sha256:string}[]}};const manifest=projection.site.files.find(item=>item.path===file.path);assert.ok(manifest);manifest.sha256=sha256;});
    await refused(()=>decodePreparedProjection(forged,binding,prepared.context.assets.script,modified));
    await refused(()=>encodePreparedProjection({...prepared,site:{...prepared.site,files:modified}},binding));
  });
  it("fresh runner repository owner and name remain authority even with the same numeric repository ID",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding);
    await refused(()=>decodePreparedProjection(bytes,{...binding,owner:"foreign"},prepared.context.assets.script,prepared.site.files));
    await refused(()=>decodePreparedProjection(bytes,{...binding,name:"foreign"},prepared.context.assets.script,prepared.site.files));
  });
  it("supplied array methods grant no callback authority for valid files",async()=>{
    const prepared=await retainedFixture(),bytes=await encodePreparedProjection(prepared,binding);let callbacks=0;
    const harmless=[...prepared.site.files];Object.defineProperty(harmless,"map",{value(){callbacks++;throw new Error("foreign array method");}});
    const restored=await decodePreparedProjection(bytes,binding,prepared.context.assets.script,harmless);assert.equal(restored.site.generation,prepared.site.generation);assert.equal(callbacks,0);
  });
  it("supplied file getters grant no callback or native byte authority",async()=>{
    const prepared=await retainedFixture(),bytes=await encodePreparedProjection(prepared,binding);let callbacks=0;
    const first=prepared.site.files[0];assert.ok(first);const accessor={...first};Object.defineProperty(accessor,"bytes",{get(){callbacks++;return first.bytes;}});
    await refused(()=>decodePreparedProjection(bytes,binding,prepared.context.assets.script,[accessor,...prepared.site.files.slice(1)]));assert.equal(callbacks,0);
  });
  it("changed active bytes cannot bypass validation through supplied map and some methods",async()=>{
    const prepared=await retainedFixture(),bytes=await encodePreparedProjection(prepared,binding);let callbacks=0;
    const html=prepared.site.files.find(file=>file.path==="index.html");assert.ok(html);const changed=new Uint8Array(html.bytes);changed[0]=65;
    const foreign=prepared.site.files.map(file=>file===html?{...file,bytes:changed}:file);Object.defineProperty(foreign,"some",{value(){callbacks++;return false;}});
    const bypass=[...foreign];Object.defineProperty(bypass,"map",{value(){callbacks++;return foreign;}});
    await refused(()=>decodePreparedProjection(bytes,binding,prepared.context.assets.script,bypass));assert.equal(callbacks,0);
  });
  it("top level context site assets and script accessors refuse without invoking supplied getters",async()=>{
    for(const key of ["context","site","assets","script"]){
      const prepared=await fixture();let callbacks=0;
      const receiver=key==="context"||key==="site"?prepared:key==="assets"?prepared.context:prepared.context.assets;
      const original=Object.getOwnPropertyDescriptor(receiver,key);assert.ok(original);Object.defineProperty(receiver,key,{get(){callbacks++;return original.value as unknown;}});
      await refused(()=>encodePreparedProjection(prepared,binding));assert.equal(callbacks,0);
    }
  });
  it("Proxy bindings arrays and files refuse before any supplied proxy trap runs",async()=>{
    const prepared=await fixture(),bytes=await encodePreparedProjection(prepared,binding);let callbacks=0;
    const handler:ProxyHandler<object>={get(target,key,receiver){callbacks++;return Reflect.get(target,key,receiver) as unknown;},getOwnPropertyDescriptor(target,key){callbacks++;return Reflect.getOwnPropertyDescriptor(target,key);},getPrototypeOf(target){callbacks++;return Reflect.getPrototypeOf(target);}};
    await refused(()=>decodePreparedProjection(bytes,new Proxy<CapsuleBinding>(binding,handler),prepared.context.assets.script,prepared.site.files));assert.equal(callbacks,0);
    await refused(()=>decodePreparedProjection(bytes,binding,prepared.context.assets.script,new Proxy<typeof prepared.site.files>([...prepared.site.files],handler)));assert.equal(callbacks,0);
    const first=prepared.site.files[0];assert.ok(first);await refused(()=>decodePreparedProjection(bytes,binding,prepared.context.assets.script,[new Proxy<typeof first>(first,handler),...prepared.site.files.slice(1)]));assert.equal(callbacks,0);
  });
  it("over-budget repeated native files refuse before any occurrence is copied for metadata",async()=>{
    const prepared=await fixture(),hardBytes=1024*1024,foreign=new Uint8Array(2*hardBytes),html=prepared.site.files.find(file=>file.path==="index.html");assert.ok(html);
    const repeated=Array.from({length:8},()=>({...html,bytes:foreign,sha256:createHash("sha256").update(foreign).digest("hex")}));
    const supplied={...prepared,context:{...prepared.context,config:{...prepared.context.config,limits:{softBytes:hardBytes,hardBytes}}},site:{...prepared.site,files:repeated}};
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer invokes this original intrinsic with Reflect.apply and its native destination.
    const originalSet=Uint8Array.prototype.set;let copies=0;
    const observer=vi.spyOn(Uint8Array.prototype,"set").mockImplementation(function(this:Uint8Array,input:ArrayLike<number>,offset?:number){if(input===foreign)copies++;Reflect.apply(originalSet,this,[input,offset]);});
    try{vi.resetModules();const {encodePreparedProjection:encode}=await import("../src/prepared-capsule.ts");await refused(()=>encode(supplied,binding));}finally{observer.mockRestore();}
    assert.equal(copies,0);
  });
});

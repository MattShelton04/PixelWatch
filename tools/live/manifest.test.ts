import assert from "node:assert/strict";
import {inspect} from "node:util";
import {describe,it,vi} from "vitest";
import {canonicalBytes} from "../../packages/schemas/src/index.ts";
import {CANARY_TOKEN,assertNoSecrets} from "../simulation/capture.ts";
import {evaluateTrustedLiveRun,liveDriverCredentialKey,parseLiveSetupManifest,type LiveRunIdentity,type LiveSetupManifest} from "./manifest.ts";

const organization="pixelwatch-e2e",oid=(character:string)=>character.repeat(40);
const refs=["same-repo","fork","fork-hostile","full-rerun","partial-rerun","stale-head","deploy-repair","older-pin"].map(name=>`refs/heads/pixelwatch-e2e/m2/${name}`);
function fixture():LiveSetupManifest {
  return {schemaVersion:1,driverSourceSha:oid("a"),organization:{login:organization,id:"10"},
    upstream:{name:"pixelwatch-m2-live",id:"20",ownerId:"10",defaultBranch:"main",visibility:"public"},
    fork:{name:"pixelwatch-m2-live-fork",id:"21",ownerId:"10",defaultBranch:"main",visibility:"public",fork:true,parentId:"20",sourceId:"20"},
    bot:{login:"pixelwatch-e2e-bot",id:"11"},workflows:{source:{id:"30",path:".github/workflows/pixelwatch-capture.yml"},report:{id:"31",path:".github/workflows/pixelwatch-report.yml"}},
    pages:{url:`https://${organization}.github.io/pixelwatch-m2-live/`,prefix:"pixelwatch",environment:{id:"40",name:"github-pages",protectedBranches:false,customBranchPolicies:true,policies:[{name:"main",type:"branch"}]}},
    publisher:{current:{version:"0.1.0-rc.2",sourceCommit:oid("b"),releaseCommit:oid("c")},older:{version:"0.1.0-rc.1",sourceCommit:oid("d"),releaseCommit:oid("e")}},approvedRefs:[...refs]};
}
const run=():LiveRunIdentity=>({eventName:"workflow_dispatch",headRef:"",ref:"refs/heads/main",repository:"MattShelton04/PixelWatch",workflowRepository:"MattShelton04/PixelWatch",workflowSha:oid("a"),checkedOutSha:oid("a")});
const parse=(value:unknown)=>parseLiveSetupManifest(canonicalBytes(value),organization);
function refused(operation:()=>unknown):void {
  let error:unknown;try{operation();}catch(caught){error=caught;}assert.ok(error instanceof Error);assert.equal(error.message,"live-manifest: manifest-refused");assertNoSecrets([inspect(error,{showHidden:true,depth:5})]);
}
function changed(change:(value:Record<string,unknown>)=>void):unknown{const value=structuredClone(fixture()) as unknown as Record<string,unknown>;change(value);return value;}
const record=(value:unknown)=>value as Record<string,unknown>;
function accepted():LiveSetupManifest {return parse(fixture());}

describe("fixed live manifest and trusted run boundary (pure setup evidence only)",()=>{
  it("resolved fixed setup is privately captured immutable data without granting infrastructure approval",()=>{
    const input=fixture(),bytes=canonicalBytes(input),manifest=parseLiveSetupManifest(bytes,organization);assert.deepEqual(manifest,input);assert.notEqual(manifest,input);
    bytes.fill(65);assert.deepEqual(manifest,input);assert.equal(Object.isFrozen(manifest),true);assert.equal(Object.isFrozen(manifest.publisher.current),true);assert.equal(Object.isFrozen(manifest.approvedRefs),true);assertNoSecrets([canonicalBytes(manifest)]);
  });
  it("unknown missing duplicate and extra manifest fields refuse before use",()=>{
    accepted();for(const value of [changed(value=>{value["schemaVersion"]=2;}),changed(value=>{delete value["driverSourceSha"];}),changed(value=>{value["token"]=CANARY_TOKEN;}),null])refused(()=>parse(value));
    const text=new TextDecoder().decode(canonicalBytes(fixture()));refused(()=>parseLiveSetupManifest(new TextEncoder().encode(text.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')),organization));
  });
  it("one MiB manifest limit is enforced before copying hostile native input",async()=>{
    accepted();const oversized=new Uint8Array(1024*1024+1);let copies=0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer rebinds this captured native set with Reflect.apply.
    const original=Uint8Array.prototype.set,observer=vi.spyOn(Uint8Array.prototype,"set").mockImplementation(function(this:Uint8Array,value:ArrayLike<number>,offset?:number){if(value===oversized)copies++;Reflect.apply(original,this,[value,offset]);});
    try{vi.resetModules();const {parseLiveSetupManifest:parseCurrent}=await import("./manifest.ts");refused(()=>parseCurrent(oversized,organization));}finally{observer.mockRestore();}assert.equal(copies,0);
  });
  it("all organization repository owner bot workflow and environment IDs are canonical numeric strings",()=>{
    accepted();for(const [section,key] of [["organization","id"],["upstream","id"],["upstream","ownerId"],["fork","id"],["fork","ownerId"],["fork","parentId"],["fork","sourceId"],["bot","id"]] as const)for(const invalid of ["0","01","<unresolved>","1e3",1,"9".repeat(20)])refused(()=>parse(changed(value=>{record(value[section])[key]=invalid;})));
    for(const section of ["source","report"])refused(()=>parse(changed(value=>{record(record(value["workflows"])[section])["id"]="<workflow-id>";})));
    refused(()=>parse(changed(value=>{record(record(value["pages"])["environment"])["id"]="0";})));
  });
  it("explicit separate organization fixed public names main and genuine fork parent source identity are required",()=>{
    accepted();refused(()=>parseLiveSetupManifest(canonicalBytes(fixture()),"other-org"));
    for(const [section,key,invalid] of [["organization","login","MattShelton04"],["upstream","name","unrelated"],["upstream","visibility","private"],["upstream","defaultBranch","master"],["fork","name","unrelated"],["fork","visibility","private"],["fork","defaultBranch","master"],["fork","fork",false],["fork","parentId","22"],["fork","sourceId","22"],["fork","id","20"],["fork","ownerId","11"]] as const)refused(()=>parse(changed(value=>{record(value[section])[key]=invalid;})));
    refused(()=>parse(changed(value=>{record(value["upstream"])["ownerId"]="11";})));
  });
  it("current and older RC retain full immutable source pins and distinct release and version identities",()=>{
    accepted();for(const name of ["current","older"])for(const key of ["sourceCommit","releaseCommit"])for(const invalid of ["", "a".repeat(7),"main","v0.1.0-rc.1","A".repeat(40),CANARY_TOKEN])refused(()=>parse(changed(value=>{record(record(value["publisher"])[name])[key]=invalid;})));
    for(const key of ["version","releaseCommit"])refused(()=>parse(changed(value=>{const publisher=record(value["publisher"]);record(publisher["older"])[key]=record(publisher["current"])[key];})));
    refused(()=>parse(changed(value=>{record(record(value["publisher"])["current"])["version"]="0.1.0";})));
    refused(()=>parse(changed(value=>{const current=record(record(value["publisher"])["current"]);current["releaseCommit"]=current["sourceCommit"];})));
    refused(()=>parse(changed(value=>{const older=record(record(value["publisher"])["older"]);older["releaseCommit"]=older["sourceCommit"];})));
  });
  it("exact eight scratch refs forbid duplicates extras wildcard tags default and store branches",()=>{
    accepted();for(const selected of [refs.slice(1),[...refs,refs[0]],[...refs.slice(1),refs[0]],[...refs.slice(0,7),refs[0]],[...refs.slice(0,7),"refs/heads/main"],[...refs.slice(0,7),"refs/heads/pixelwatch-data"],[...refs.slice(0,7),"refs/tags/0.1.0"],[...refs.slice(0,7),"refs/heads/pixelwatch-e2e/m2/*"]])refused(()=>parse(changed(value=>{value["approvedRefs"]=selected;})));
  });
  it("Pages URL prefix and github-pages policy are canonical HTTPS and literal main branch only",()=>{
    accepted();for(const url of ["http://pixelwatch-e2e.github.io/pixelwatch-m2-live/","https://evil.invalid/","https://pixelwatch-e2e.github.io/pixelwatch-m2-live/?token=x","https://pixelwatch-e2e.github.io/pixelwatch-m2-live/#x","https://pixelwatch-e2e.github.io/pixelwatch-m2-live","https://pixelwatch-e2e.github.io/pixelwatch-m2-live/%2e%2e/"])refused(()=>parse(changed(value=>{record(value["pages"])["url"]=url;})));
    for(const key of ["prefix","environment"])refused(()=>parse(changed(value=>{record(value["pages"])[key]="unresolved";})));
    for(const [key,invalid] of [["name","foreign"],["protectedBranches",true],["customBranchPolicies",false],["policies",[]],["policies",[{name:"main"}]],["policies",[{name:"*",type:"branch"}]],["policies",[{name:"main",type:"tag"}]],["policies",[{name:"main",type:"branch"},{name:"other",type:"branch"}]]] as const)refused(()=>parse(changed(value=>{record(record(value["pages"])["environment"])[key]=invalid;})));
  });
  it("source and report workflows are fixed distinct numeric IDs with no arbitrary path or credential field",()=>{
    accepted();for(const name of ["source","report"])refused(()=>parse(changed(value=>{record(record(value["workflows"])[name])["path"]=".github/workflows/foreign.yml";})));
    refused(()=>parse(changed(value=>{const workflows=record(value["workflows"]);record(workflows["report"])["id"]=record(workflows["source"])["id"];})));
    refused(()=>parse(changed(value=>{record(value["bot"])["credential"]=CANARY_TOKEN;})));
  });
  it("only trusted manual or schedule on the verified default branch may acquire live credentials",()=>{
    for(const eventName of ["workflow_dispatch","schedule"]){const gate=evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,{...run(),eventName});assert.equal(gate.ok,true);assert.deepEqual(gate.manifest,fixture());}
    assert.equal(liveDriverCredentialKey,"PIXELWATCH_E2E_DRIVER_TOKEN");assert.notEqual(liveDriverCredentialKey,"GH_TOKEN");
  });
  it("all pull request other events nondefault and nonempty head refs refuse before manifest or credential access",()=>{
    assert.equal(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,run()).ok,true);let lookups=0;
    for(const change of [{eventName:"pull_request"},{eventName:"pull_request_target"},{eventName:"pull_request_review"},{eventName:"workflow_run"},{eventName:"push"},{eventName:""},{ref:"refs/heads/other"},{ref:"refs/pull/7/merge"},{headRef:"fork-branch"}]){const identity={...run(),...change};Object.defineProperty(identity,liveDriverCredentialKey,{get(){lookups++;throw new Error(CANARY_TOKEN);}});assert.deepEqual(evaluateTrustedLiveRun(undefined,organization,identity),{ok:false,reason:"untrusted-run"});}assert.equal(lookups,0);
  });
  it("actual workflow repository and checked out revision corroborate the fixed trusted product source",()=>{
    assert.equal(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,run()).ok,true);
    for(const change of [{repository:"attacker/PixelWatch"},{workflowRepository:"attacker/PixelWatch"},{workflowRepository:"MattShelton04/PixelWatch/extra"},{workflowSha:"main"},{workflowSha:oid("b")},{checkedOutSha:oid("b")},{checkedOutSha:""}])assert.deepEqual(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,{...run(),...change}),{ok:false,reason:"untrusted-run"});
  });
  it("unresolved manifest and mismatched upstream fork parent or workflow IDs cause zero mutations",()=>{
    assert.equal(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,run()).ok,true);let lookups=0;const identity=run();Object.defineProperty(identity,liveDriverCredentialKey,{get(){lookups++;throw new Error(CANARY_TOKEN);}});
    for(const bytes of [undefined,new Uint8Array(),canonicalBytes(changed(value=>{record(value["fork"])["parentId"]="<unresolved>";})),canonicalBytes(changed(value=>{record(record(value["workflows"])["source"])["id"]="<unresolved>";}))])assert.deepEqual(evaluateTrustedLiveRun(bytes,organization,identity),{ok:false,reason:"manifest-refused"});assert.equal(lookups,0);
  });
  it("foreign run accessors and proxies are refused without callback authority or raw diagnostics",()=>{
    assert.equal(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,run()).ok,true);let callbacks=0;
    const accessor=run();Object.defineProperty(accessor,"eventName",{get(){callbacks++;throw new Error(CANARY_TOKEN);}});assert.deepEqual(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,accessor),{ok:false,reason:"untrusted-run"});
    const proxy=new Proxy(run(),{get(){callbacks++;throw new Error(CANARY_TOKEN);},getPrototypeOf(){callbacks++;throw new Error(CANARY_TOKEN);},getOwnPropertyDescriptor(){callbacks++;throw new Error(CANARY_TOKEN);}});assert.deepEqual(evaluateTrustedLiveRun(canonicalBytes(fixture()),organization,proxy),{ok:false,reason:"untrusted-run"});assert.equal(callbacks,0);
  });
  it("native input shadows proxies and malformed UTF8 grant no callbacks and emit only fixed failures",()=>{
    accepted();let callbacks=0;const bytes=canonicalBytes(fixture());for(const key of ["byteLength","buffer","constructor","subarray"])Object.defineProperty(bytes,key,{get(){callbacks++;throw new Error(CANARY_TOKEN);}});assert.deepEqual(parseLiveSetupManifest(bytes,organization),fixture());
    const proxy=new Proxy(canonicalBytes(fixture()),{get(){callbacks++;throw new Error(CANARY_TOKEN);},getPrototypeOf(){callbacks++;throw new Error(CANARY_TOKEN);}});refused(()=>parseLiveSetupManifest(proxy,organization));refused(()=>parseLiveSetupManifest(new Uint8Array([0xff]),organization));assert.equal(callbacks,0);
  });
  it("invalid organization bot driver pins unsafe JSON and canary payloads fail with fixed scanned diagnostics",()=>{
    accepted();for(const login of ["", "<E2E_ORG>", "../evil", CANARY_TOKEN])refused(()=>parseLiveSetupManifest(canonicalBytes(fixture()),login));
    for(const invalid of ["<RC-SHA>","MAIN",oid("a").toUpperCase(),CANARY_TOKEN])refused(()=>parse(changed(value=>{value["driverSourceSha"]=invalid;})));
    refused(()=>parse(changed(value=>{record(value["bot"])["login"]="<E2E_BOT>";})));
    refused(()=>parseLiveSetupManifest(new TextEncoder().encode('{"__proto__":{}}'),organization));refused(()=>parseLiveSetupManifest(new TextEncoder().encode('"'+CANARY_TOKEN+'"'),organization));
  });
  it("distinct immutable RC versions and release commits may rebuild the same approved source",()=>{
    const prepared=fixture(),current=prepared.publisher.current,older={...prepared.publisher.older,sourceCommit:current.sourceCommit};
    const setup={...prepared,publisher:{current,older}},manifest=parse(setup);
    assert.deepEqual(manifest,setup);assert.equal(manifest.publisher.current.sourceCommit,manifest.publisher.older.sourceCommit);
    assert.notEqual(manifest.publisher.current.version,manifest.publisher.older.version);assert.notEqual(manifest.publisher.current.releaseCommit,manifest.publisher.older.releaseCommit);
    assert.equal(Object.isFrozen(manifest.publisher.older),true);assert.equal(evaluateTrustedLiveRun(canonicalBytes(setup),organization,run()).ok,true);
    assertNoSecrets([canonicalBytes(manifest)]);
  });
});

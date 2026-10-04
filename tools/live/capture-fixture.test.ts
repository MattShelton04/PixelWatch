// Unit composition and executable local fixture evidence; none of the nine actual live cases ran.
import "../lib/no-network.ts";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {appendFileSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {inspect} from "node:util";
import {pathToFileURL} from "node:url";
import {afterAll,describe,it} from "vitest";
import {canonicalBytes,parseDocument,parseJson,type Config} from "../../packages/schemas/src/index.ts";
import {ingestArtifacts} from "../../packages/core/src/ingest/ingest.ts";
import {IngressError} from "../../packages/core/src/ingest/errors.ts";
import type {ArtifactInput} from "../../packages/core/src/ingest/types.ts";
import {memoryPool} from "../../packages/core/test/ingest-fixtures.ts";
import {buildZip} from "../zip-corpus/zip-builder.ts";
import {assertNoSecrets,CANARY_TOKEN,SIGNED_URL} from "../simulation/capture.ts";
import {buildCapturePart,buildCaptureSetup,buildCaptureStimulus,captureCaseIds,type CaptureFixtureFile,type CapturePart,type CaptureRunIdentity,type CaptureSetupInput} from "./capture-fixture.ts";
import {renderReportCaller,validateReportCaller} from "../release/workflow-policy.ts";

const raw:string[]=[],rawBytes:Uint8Array[]=[];
const sha=(letter:string)=>letter.repeat(40);
const text=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const state=(value=0,failure="none",payload="valid")=>canonicalBytes({schemaVersion:1,value,failure,payload});
function runner():CaptureRunIdentity {
  return {runId:"510",attempt:"1",jobKey:"capture",eventName:"pull_request",actor:{login:"pixelwatch-e2e-bot",id:"11"},repository:{fullName:"pixelwatch-e2e/pixelwatch-m2-live",id:"20"},headSha:sha("a"),baselineSha:sha("b"),harnessSha:sha("a"),pullRequest:{number:"7",headRepository:{fullName:"pixelwatch-e2e/pixelwatch-m2-live-fork",id:"21"},baseRepositoryId:"20",eventBaseSha:sha("c"),eventBaseRef:"main"}};
}
function setup():CaptureSetupInput {return {sourceWorkflowId:"30",current:{version:"0.1.0-rc.2",sourceCommit:sha("d"),releaseCommit:sha("e")},older:{version:"0.1.0-rc.1",sourceCommit:sha("d"),releaseCommit:sha("f")}};}
function get(files:readonly CaptureFixtureFile[],name:string):Uint8Array {const found=files.find(file=>file.path===name);assert.ok(found);return found.bytes;}
function part(revision:"base"|"head"="head",shard:1|2=1,identity=runner(),bytes=state()):CapturePart {const result=buildCapturePart(identity,revision,shard,bytes);rawBytes.push(result.receipt,...result.files.map(file=>file.bytes));return result;}
function artifact(value:CapturePart,id:string):ArtifactInput {const result={artifactName:value.artifactName,artifactId:id,zip:buildZip({entries:value.files.map(file=>({name:file.path,data:file.bytes}))})};rawBytes.push(new Uint8Array(result.zip));return result;}
function config():Config {const checked=parseDocument("config",get(buildCaptureSetup(setup()),".pixelwatch/config.json"));assert.ok(checked.ok);return checked.value;}
function refused(operation:()=>unknown,message="live-capture: fixture-invalid"):void {let error:unknown;try{operation();}catch(caught){error=caught;}assert.ok(error instanceof Error);raw.push(inspect(error,{showHidden:true,depth:5}));assert.equal(error.message,message);}
function fields(value:unknown):Record<string,unknown> {assert.ok(typeof value==="object"&&value!==null);return value as Record<string,unknown>;}
function editIdentity(change:(value:Record<string,unknown>)=>void):CaptureRunIdentity {const value=structuredClone(runner()) as unknown as Record<string,unknown>;change(value);return value as unknown as CaptureRunIdentity;}
function safeChildEnvironment():Record<string,string> {const safe:Record<string,string>={GH_TOKEN:CANARY_TOKEN,GITHUB_TOKEN:CANARY_TOKEN};for(const key of ["PATH","Path","SystemRoot","WINDIR","TMP","TEMP","TMPDIR"]){const value=process.env[key];if(value!==undefined)safe[key]=value;}return safe;}
afterAll(()=>{const serialized=JSON.stringify({text:raw,bytesBase64:rawBytes.map(bytes=>Buffer.from(bytes).toString("base64"))});writeFileSync(path.resolve(".tools/logs/capture-fixture-raw.json"),serialized);appendFileSync(path.resolve(".tools/logs/capture-fixture-raw-history.jsonl"),serialized+"\n");assertNoSecrets([...raw,...rawBytes]);});

describe("deterministic local two-shard capture setup (not live acceptance)",()=>{
  it("uses exact artifact name flat PNG route bundle@1 and a separate real runner receipt",()=>{
    const result=part(),bundle=parseDocument("bundle",get(result.files,"bundle.json"));assert.ok(bundle.ok);
    assert.equal(result.artifactName,"pixelwatch-b1-a1-head-app-s1-of2");assert.deepEqual(result.files.map(file=>file.path),["bundle.json","shard-1.desktop.png"]);
    assert.equal(bundle.value.providerId,"app");assert.deepEqual(bundle.value.shard,{index:1,count:2});assert.deepEqual(bundle.value.units.map(unit=>[unit.viewId,unit.variantId,unit.state,unit.labels?.route]),[["shard-1","desktop","captured","/fixture/shard-1"]]);
    assert.deepEqual(bundle.value.claims,{revisionSha:sha("a"),harnessSha:sha("a"),environment:{viewport:{width:16,height:16},deviceScaleFactor:1,colorScheme:"light",locale:"en-US",timezone:"UTC"}});
    const receipt=fields(parseJson(result.receipt));assert.equal(receipt["schemaVersion"],1);assert.deepEqual(receipt["identity"],runner());assert.equal(receipt["revision"],"head");assert.equal(receipt["shard"],1);assert.ok(result.receipt.byteLength<=16*1024);
    assert.equal(result.files.some(file=>file.path.includes("receipt")),false);assertNoSecrets(result.files.map(file=>file.bytes));
  });
  it("complete base and head shards are accepted by actual source artifact ingress with two disjoint units",async()=>{
    const parts=[part("base",1,runner(),state(0)),part("base",2,runner(),state(0)),part("head",1,runner(),state(1)),part("head",2,runner(),state(1))],pool=memoryPool();
    const result=await ingestArtifacts({config:config(),attempt:"1",baseline:"expected",artifacts:parts.map((value,index)=>artifact(value,String(100+index))),pool});
    assert.equal(result.coverage.status,"complete-declared");assert.equal(result.parts.length,4);assert.ok(result.parts.every(value=>value.status==="valid"));assert.deepEqual(result.units.map(value=>value.viewId),["shard-1","shard-2"]);
    assert.ok(result.units.every(value=>value.base.state==="captured"&&value.head.state==="captured"));assert.equal(pool.blobs.size,4);raw.push(inspect(result,{depth:6}));
  });
  it("controlled pixels are deterministic independent of run actor job and revision SHA claims",()=>{
    const first=part(),second=part("head",1,{...runner(),runId:"511",actor:{login:"another-bot",id:"12"},headSha:sha("c"),harnessSha:sha("c")});assert.deepEqual(get(first.files,"shard-1.desktop.png"),get(second.files,"shard-1.desktop.png"));
    assert.notDeepEqual(first.receipt,second.receipt);assert.notDeepEqual(get(first.files,"shard-1.desktop.png"),get(part("head",1,runner(),state(1)).files,"shard-1.desktop.png"));
    assert.notDeepEqual(get(first.files,"shard-1.desktop.png"),get(part("head",2).files,"shard-2.desktop.png"));
  });
  it("dispatch and initial push have explicit no baseline and cannot manufacture a base part",async()=>{
    part();for(const eventName of ["workflow_dispatch","push"] as const){const identity={...runner(),eventName,baselineSha:null,pullRequest:null};const head=[part("head",1,identity),part("head",2,identity)];refused(()=>part("base",1,identity));
      const result=await ingestArtifacts({config:config(),attempt:"1",baseline:"none",artifacts:head.map((value,index)=>artifact(value,String(110+index))),pool:memoryPool()});assert.equal(result.coverage.status,"complete-declared");assert.ok(result.units.every(value=>value.base.state==="none"));}
  });
  it("full rerun changes the real run attempt identity and selects only complete new-attempt parts",async()=>{
    const original=runner(),rerun={...original,attempt:"2"},old=[part("base",1,original),part("base",2,original),part("head",1,original),part("head",2,original)],fresh=[part("base",1,rerun),part("base",2,rerun),part("head",1,rerun),part("head",2,rerun)];
    assert.equal(fields(fields(parseJson(fresh[0]?.receipt??new Uint8Array()))["identity"])["runId"],original.runId);
    const result=await ingestArtifacts({config:config(),attempt:"2",baseline:"expected",artifacts:[...old,...fresh].map((value,index)=>artifact(value,String(120+index))),pool:memoryPool()});assert.equal(result.coverage.status,"complete-declared");assert.equal(result.ignored.length,4);assert.ok(result.ignored.every(value=>value.reason==="other-attempt"));assert.ok(result.parts.every(value=>value.artifacts.every(value=>BigInt(value.artifactId)>=124n)));
  });
  it("real failed subset then failed-job-only rerun cannot borrow older successful shard parts",async()=>{
    const bytes=get(buildCaptureStimulus("partial-rerun"),".pixelwatch/fixture.json"),first=runner(),rerun={...first,attempt:"2"};part("head",1,first,bytes);refused(()=>part("head",2,first,bytes),"live-capture: selected-fixture-failure");refused(()=>part("base",2,first,bytes),"live-capture: selected-fixture-failure");
    const selected=[part("base",1,first,bytes),part("head",1,first,bytes),part("base",2,rerun,bytes),part("head",2,rerun,bytes)];const result=await ingestArtifacts({config:config(),attempt:"2",baseline:"expected",artifacts:selected.map((value,index)=>artifact(value,String(140+index))),pool:memoryPool()});
    assert.equal(result.coverage.status,"incomplete");assert.equal(result.coverage.missingParts.length,2);assert.ok(result.coverage.missingParts.every(value=>value.shard.index===1));assert.equal(result.ignored.length,2);assert.equal(result.units.length,1);assert.equal(result.units[0]?.viewId,"shard-2");
  });
  it("unknown selected hostile bundle version refuses before all sibling PNG and blob work",async()=>{
    const hostileBytes=get(buildCaptureStimulus("pr-fork-hostile"),".pixelwatch/fixture.json"),hostile=part("head",1,runner(),hostileBytes),active=part("head",2,runner(),hostileBytes);assert.ok(active.files.some(file=>file.path==="index.html"));assert.ok(active.files.some(file=>file.path===".pixelwatch.json"));const pool=memoryPool();
    let error:unknown;try{await ingestArtifacts({config:config(),attempt:"1",baseline:"none",artifacts:[artifact(part("head",2),"151"),artifact(hostile,"152")],pool});}catch(caught){error=caught;}assert.ok(error instanceof IngressError);assert.equal(error.code,"ingest-unsupported-version");assert.equal(error.scope,"ingestion");assert.equal(pool.blobs.size,0);raw.push(inspect(error,{showHidden:true,depth:5}));
  });
  it("separate active malformed known-version hostile part is rejected by actual ZIP allowlist",async()=>{
    const bytes=get(buildCaptureStimulus("pr-fork-hostile"),".pixelwatch/fixture.json"),unknown=part("head",1,runner(),bytes),active=part("head",2,runner(),bytes);assert.equal(fields(parseJson(get(unknown.files,"bundle.json")))["schemaVersion"],2);assert.equal(fields(parseJson(get(active.files,"bundle.json")))["schemaVersion"],1);
    const pool=memoryPool(),result=await ingestArtifacts({config:config(),attempt:"1",baseline:"none",artifacts:[artifact(active,"153")],pool});assert.equal(result.coverage.status,"unknown");assert.equal(result.parts.find(value=>value.shard.index===2)?.status,"rejected");assert.equal(result.parts.find(value=>value.shard.index===2)?.diagnostic?.code,"zip-name-not-allowed");assert.equal(result.units.length,0);assert.equal(pool.blobs.size,0);raw.push(inspect(result,{depth:6}));
  });
  it("forged source run actor repository and PR claims remain schema-invalid rather than envelope authority",async()=>{
    const forged=part("head",1,runner(),state(0,"none","forged-claims")),doc=fields(parseJson(get(forged.files,"bundle.json")));assert.equal(fields(doc["claims"])["runId"],"999");assert.equal(parseDocument("bundle",get(forged.files,"bundle.json")).ok,false);
    const result=await ingestArtifacts({config:config(),attempt:"1",baseline:"none",artifacts:[artifact(forged,"160"),artifact(part("head",2),"161")],pool:memoryPool()});assert.equal(result.coverage.status,"incomplete");const rejected=result.parts[0];assert.ok(rejected);assert.equal(rejected.status,"rejected");assert.equal(rejected.diagnostic?.code,"part-bundle-invalid");
  });
  it("runner IDs SHA separation event shape fixed repository names and PR base identity refuse safely",()=>{
    part();for(const key of ["runId","attempt"])for(const bad of ["0","01","<unresolved>",CANARY_TOKEN])refused(()=>part("head",1,editIdentity(value=>{value[key]=bad;})));
    for(const key of ["headSha","harnessSha","baselineSha"])for(const bad of ["a".repeat(7),"A".repeat(40),SIGNED_URL])refused(()=>part("head",1,editIdentity(value=>{value[key]=bad;})));
    for(const change of [(value:Record<string,unknown>)=>{value["harnessSha"]=sha("d");},(value:Record<string,unknown>)=>{fields(value["repository"])["fullName"]="MattShelton04/PixelWatch";},(value:Record<string,unknown>)=>{fields(value["pullRequest"])["baseRepositoryId"]="21";},(value:Record<string,unknown>)=>{value["pullRequest"]=null;},(value:Record<string,unknown>)=>{value["eventName"]="pull_request_target";},(value:Record<string,unknown>)=>{value["jobKey"]="../source";}])refused(()=>part("head",1,editIdentity(change)));
  });
  it("strict bounded canonical fixture state rejects unknown versions fields duplicates and malformed bytes",()=>{
    part();for(const bytes of [state(4),state(0,"skip-all"),state(0,"none","callback"),canonicalBytes({schemaVersion:2,value:0,failure:"none",payload:"valid"}),canonicalBytes({schemaVersion:1,value:0,failure:"none",payload:"valid",token:CANARY_TOKEN}),new Uint8Array(513),new TextEncoder().encode('{"failure":"none","payload":"valid","schemaVersion":1,"value":0,"value":0}'),new Uint8Array([0xff])])refused(()=>part("head",1,runner(),bytes));
  });
  it("returned bytes and receipt are owned and immutable entries survive caller input and byte mutations",()=>{
    const identity=runner(),bytes=state(),result=part("head",1,identity,bytes),png=get(result.files,"shard-1.desktop.png"),receipt=result.receipt,bundle=get(result.files,"bundle.json");png.fill(0);receipt.fill(0);bundle.fill(0);bytes.fill(0);fields(identity.actor)["login"]="changed";
    assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.files),true);assert.ok(result.files.every(Object.isFrozen));assert.equal(parseDocument("bundle",get(result.files,"bundle.json")).ok,true);assert.equal(fields(fields(parseJson(result.receipt))["identity"])["runId"],"510");assert.equal(fields(fields(fields(parseJson(result.receipt))["identity"])["actor"])["login"],"pixelwatch-e2e-bot");
  });
  it("six fixed setup paths include actual observed source ID and valid two-shard trusted config",()=>{
    const files=buildCaptureSetup(setup());assert.deepEqual(files.map(file=>file.path),[".github/workflows/pixelwatch-capture.yml",".github/workflows/pixelwatch-report-older.yml",".github/workflows/pixelwatch-report.yml",".pixelwatch/capture.mjs",".pixelwatch/config.json",".pixelwatch/fixture.json"]);
    const cfg=config();assert.deepEqual(cfg.source,{workflowIds:["30"],events:["pull_request","push","workflow_dispatch"]});assert.deepEqual(cfg.providers,[{id:"app",shards:2}]);assert.deepEqual(cfg.store,{branch:"pixelwatch-data",prefix:"pixelwatch"});assert.deepEqual(cfg.comparator,{version:1});assert.ok(files.every(file=>file.bytes.byteLength>0));assertNoSecrets(files.map(file=>file.bytes));
  });
  it("unresolved workflow release version and SHA inputs cannot become runnable setup",()=>{
    buildCaptureSetup(setup());for(const bad of ["<workflow-id>","0","01",CANARY_TOKEN])refused(()=>buildCaptureSetup({...setup(),sourceWorkflowId:bad}));
    for(const slot of ["current","older"] as const)for(const key of ["version","sourceCommit","releaseCommit"] as const){const input=structuredClone(setup());fields(input[slot])[key]="<unresolved>";refused(()=>buildCaptureSetup(input));}
    const sameRelease={...setup(),older:{...setup().older,releaseCommit:setup().current.releaseCommit}};refused(()=>buildCaptureSetup(sameRelease));refused(()=>buildCaptureSetup({...setup(),current:{...setup().current,sourceCommit:setup().current.releaseCommit}}));assert.ok(buildCaptureSetup(setup()).length>0);
  });
  it("static capture is read-only with pinned hosted actions no secrets and explicit actual runner inputs",()=>{
    const yaml=text(get(buildCaptureSetup(setup()),".github/workflows/pixelwatch-capture.yml"));assert.match(yaml,/permissions:\n {2}contents: read/);assert.match(yaml,/runs-on: ubuntu-24\.04/);assert.match(yaml,/revision: \[base, head\]/);assert.match(yaml,/shard: \[1, 2\]/);assert.match(yaml,/fail-fast: false/);assert.match(yaml,/pixelwatch-b1-a\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.revision \}\}-app-s\$\{\{ matrix\.shard \}\}-of2/);
    for(const action of ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1","actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0","actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1"])assert.ok(yaml.includes(action));
    for(const field of ["github.run_id","github.run_attempt","github.job","github.actor_id","github.actor","github.repository_id","github.repository","github.event.pull_request.number","github.event.pull_request.base.sha","github.event.pull_request.head.repo.id"])assert.ok(yaml.includes(field));
    assert.doesNotMatch(yaml,/pull_request_target|self-hosted|secrets:|secrets\.|environment:|npm install|pnpm install|cache:|GITHUB_TOKEN|GH_TOKEN/);assert.match(yaml,/persist-credentials: false/);assert.doesNotMatch(yaml,/TODO|exit 1|report\.yml@/);
  });
  it("same real head harness selects PR target merge base push first parent and dispatch no baseline",()=>{
    const yaml=text(get(buildCaptureSetup(setup()),".github/workflows/pixelwatch-capture.yml"));assert.match(yaml,/git merge-base "\$\{PR_BASE\}" "\$\{PR_HEAD\}"/);assert.match(yaml,/"\$\{PUSHED\}\^1"/);assert.match(yaml,/workflow_dispatch[\s\S]*base=""/);assert.match(yaml,/path: \.harness[\s\S]*ref: \$\{\{ needs\.refs\.outputs\.head \}\}/);assert.match(yaml,/github\.event\.pull_request\.head\.repo\.full_name/);
    assert.match(yaml,/node \.harness\/\.pixelwatch\/capture\.mjs \.pixelwatch-capture-identity\.json \.target\/\.pixelwatch\/fixture\.json/);assert.match(yaml,/path: pixelwatch-bundle\//);assert.doesNotMatch(yaml,/path: \.pixelwatch-capture/);
  });
  it("current and older callers use exact immutable product releases with no inputs or inherited secrets",()=>{
    const files=buildCaptureSetup(setup()),current=text(get(files,".github/workflows/pixelwatch-report.yml")),older=text(get(files,".github/workflows/pixelwatch-report-older.yml"));
    assert.match(current,/workflow_run:\n {4}workflows: \[PixelWatch Capture\]\n {4}types: \[completed\]/);assert.match(current,/workflow_dispatch:/);assert.doesNotMatch(older,/workflow_run:/);
    for(const [yaml,release,version] of [[current,setup().current.releaseCommit,setup().current.version],[older,setup().older.releaseCommit,setup().older.version]] as const){assert.ok(yaml.includes(`MattShelton04/PixelWatch/.github/workflows/report.yml@${release} # v${version}`));assert.match(yaml,/permissions: \{\}/);for(const permission of ["actions: read","contents: write","pages: write","id-token: write","pull-requests: write"])assert.ok(yaml.includes(permission));assert.doesNotMatch(yaml,/with:|secrets:|inherit|checkout@|^\s+run:/m);}
  });
  it("all nine actual case stimuli remain explicit fixed data and stale new head changes bytes",()=>{
    const cases=["first-run","pr-same-repo","pr-fork","pr-fork-hostile","full-rerun","partial-rerun","stale-head","stored-deploy-fail-repair","queued-older-pin-after-newer"];assert.deepEqual(captureCaseIds,cases);assert.equal(Object.isFrozen(captureCaseIds),true);
    for(const id of captureCaseIds){const files=buildCaptureStimulus(id);assert.deepEqual(files.map(file=>file.path),[".pixelwatch/fixture.json"]);const parsed=fields(parseJson(files[0]?.bytes??new Uint8Array()));assert.equal(parsed["schemaVersion"],1);assert.equal(Object.isFrozen(files),true);assertNoSecrets(files.map(file=>file.bytes));}
    const digest=(files:readonly CaptureFixtureFile[])=>createHash("sha256").update(get(files,".pixelwatch/fixture.json")).digest("hex");assert.notEqual(digest(buildCaptureStimulus("stale-head")),digest(buildCaptureStimulus("stale-head","new-head")));refused(()=>buildCaptureStimulus("first-run","new-head"));refused(()=>buildCaptureStimulus("other" as typeof captureCaseIds[number]));
  });
  it("standalone generated mjs runs behind the existing guard and emits only upload files plus private receipt",()=>{
    const files=buildCaptureSetup(setup()),dir=mkdtempSync(path.join(os.tmpdir(),"pw-capture-fixture-"));try{
      writeFileSync(path.join(dir,"capture.mjs"),get(files,".pixelwatch/capture.mjs"));writeFileSync(path.join(dir,"identity.json"),canonicalBytes({identity:runner(),revision:"head",shard:1}));writeFileSync(path.join(dir,"state.json"),state());
      const safeEnv=safeChildEnvironment();
      const guard=pathToFileURL(path.resolve("tools/lib/no-network.ts")).href,result=spawnSync(process.execPath,["--import",guard,path.join(dir,"capture.mjs"),path.join(dir,"identity.json"),path.join(dir,"state.json")],{cwd:dir,encoding:"utf8",timeout:10_000,env:safeEnv});raw.push(result.stdout,result.stderr,inspect(result.error,{depth:4}));assert.equal(result.status,0);
      assert.deepEqual(readdirSync(path.join(dir,"pixelwatch-bundle")).sort(),["bundle.json","shard-1.desktop.png"]);const expected=part();for(const file of expected.files)assert.deepEqual(new Uint8Array(readFileSync(path.join(dir,"pixelwatch-bundle",file.path))),file.bytes);assert.deepEqual(new Uint8Array(readFileSync(path.join(dir,".pixelwatch-capture-receipt.json"))),expected.receipt);
      assert.doesNotMatch(text(get(files,".pixelwatch/capture.mjs")),/process\.env|GH_TOKEN|GITHUB_TOKEN|fetch\(|https?:|child_process|\.ts["']/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("actual standalone base capture takes failed subset control from head harness while retaining target pixels",()=>{
    const files=buildCaptureSetup(setup()),dir=mkdtempSync(path.join(os.tmpdir(),"pw-capture-control-"));try{
      writeFileSync(path.join(dir,"capture.mjs"),get(files,".pixelwatch/capture.mjs"));writeFileSync(path.join(dir,"identity.json"),canonicalBytes({identity:runner(),revision:"base",shard:2}));writeFileSync(path.join(dir,"target.json"),state(0));writeFileSync(path.join(dir,"control.json"),get(buildCaptureStimulus("partial-rerun"),".pixelwatch/fixture.json"));
      const args=["--import",pathToFileURL(path.resolve("tools/lib/no-network.ts")).href,path.join(dir,"capture.mjs"),path.join(dir,"identity.json"),path.join(dir,"target.json"),path.join(dir,"control.json")],options={cwd:dir,encoding:"utf8" as const,timeout:10_000,env:safeChildEnvironment()},failed=spawnSync(process.execPath,args,options);raw.push(failed.stdout,failed.stderr,inspect(failed.error,{depth:4}));assert.equal(failed.status,1);assert.match(failed.stderr,/live-capture: selected-fixture-failure/);assert.equal(existsSync(path.join(dir,"pixelwatch-bundle")),false);
      const identity={...runner(),attempt:"2"};writeFileSync(path.join(dir,"identity.json"),canonicalBytes({identity,revision:"base",shard:2}));const succeeded=spawnSync(process.execPath,args,options);raw.push(succeeded.stdout,succeeded.stderr,inspect(succeeded.error,{depth:4}));assert.equal(succeeded.status,0);const expected=part("base",2,identity,state(0)),actualPng=new Uint8Array(readFileSync(path.join(dir,"pixelwatch-bundle/shard-2.desktop.png")));assert.deepEqual(actualPng,get(expected.files,"shard-2.desktop.png"));assert.notDeepEqual(actualPng,get(part("base",2,identity,state(1)).files,"shard-2.desktop.png"));
      const bundle=parseDocument("bundle",new Uint8Array(readFileSync(path.join(dir,"pixelwatch-bundle/bundle.json"))));assert.ok(bundle.ok);assert.equal(bundle.value.claims.revisionSha,identity.baselineSha);assert.equal(bundle.value.claims.harnessSha,identity.headSha);const yaml=text(get(files,".github/workflows/pixelwatch-capture.yml"));assert.ok(yaml.includes("node .harness/.pixelwatch/capture.mjs .pixelwatch-capture-identity.json .target/.pixelwatch/fixture.json .harness/.pixelwatch/fixture.json"));
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("local helpers do not consult ambient token fields even with unknown secret-bearing inputs",()=>{
    part();const previous=process.env,reads:string[]=[];process.env=new Proxy(previous,{get(target,key){if(key==="GH_TOKEN"||key==="GITHUB_TOKEN"){reads.push(key);throw new Error(CANARY_TOKEN);}const observed:unknown=Reflect.get(target,key);return observed;}});
    try{const input=editIdentity(value=>{value["token"]=CANARY_TOKEN;});refused(()=>part("head",1,input));buildCaptureSetup(setup());buildCaptureStimulus("first-run");}finally{process.env=previous;}assert.deepEqual(reads,[]);assertNoSecrets(raw);
  });
  it("generated capture setup callers exactly satisfy reviewed policy and reject hostile caller mutations",()=>{
    const identity=setup(),files=buildCaptureSetup(identity);assert.deepEqual(files.map(file=>file.path),[".github/workflows/pixelwatch-capture.yml",".github/workflows/pixelwatch-report-older.yml",".github/workflows/pixelwatch-report.yml",".pixelwatch/capture.mjs",".pixelwatch/config.json",".pixelwatch/fixture.json"]);
    for(const [name,release,older] of [[".github/workflows/pixelwatch-report.yml",identity.current,false],[".github/workflows/pixelwatch-report-older.yml",identity.older,true]] as const){
      const pin={releaseCommit:release.releaseCommit,version:release.version},bytes=get(files,name),expected=renderReportCaller(pin,older),source=text(bytes);rawBytes.push(bytes);assert.deepEqual(bytes,new TextEncoder().encode(expected));assert.deepEqual(validateReportCaller(bytes,pin,older),pin);
      assert.equal((source.match(/zizmor: ignore/g)??[]).length,older?0:1);assert.doesNotMatch(source,/^\s+steps:|^\s+run:|^\s+with:|secrets:|checkout@|cache@/m);assert.equal((source.match(/^ {2}report:/gm)??[]).length,1);assert.ok(source.includes(`MattShelton04/PixelWatch/.github/workflows/report.yml@${release.releaseCommit} # v${release.version}`));
      if(older)assert.doesNotMatch(source,/workflow_run|zizmor:/);else assert.ok(source.includes('on: # zizmor: ignore[dangerous-triggers] ADR 0032: exact pinned caller; structural gate required'));
      for(const changed of [source.replace("  workflow_dispatch:","  pull_request_target:"),source+"  hostile:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bad\n",source+"  hostile:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@"+sha("a")+"\n",source+"  hostile:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@"+sha("a")+"\n",source.replace("    uses:","    secrets: inherit\n    uses:"),source.replace("    uses:","    with:\n      token: "+CANARY_TOKEN+"\n    uses:"),source.replace("MattShelton04/PixelWatch/","attacker/PixelWatch/"),source.replace(release.releaseCommit,"main"),source.replace("permissions: {}","permissions: {}\npermissions: write-all"),source.replace("      contents: write","      contents: read")])refused(()=>validateReportCaller(new TextEncoder().encode(changed),pin,older),"workflow-policy: reviewed-contract-refused");
    }
  });
});

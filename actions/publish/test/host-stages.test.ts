import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync,lstatSync,readdirSync} from "node:fs";
import {join,resolve,relative,isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {describe,it} from "vitest";
import {assembleSite} from "../../../packages/publisher/src/assemble.ts";
import {PublisherError,type PreparedProjection,type ProjectionResult,type SourceJobResult} from "../../../packages/publisher/src/types.ts";
import {newStore} from "../../../packages/core/src/index.ts";
import {canonicalBytes,parseDocument,type Config} from "../../../packages/schemas/src/index.ts";
import {CANARY_TOKEN,assertNoSecrets} from "../../../tools/simulation/capture.ts";
import {readInvocation,type ActionInvocation} from "../src/host-input.ts";
import {readStagedSite,cleanupStagedSite} from "../src/host-files.ts";
import {runHostStage,type HostStageInput,type HostStagePorts} from "../src/host-stages.ts";
import type {RuntimeRelease} from "../src/runtime-release.ts";

const oid=(value:string)=>value.repeat(40),encoder=new TextEncoder();
const script=encoder.encode("/* host stage IO unit fixture; not released publisher evidence */");
const release:RuntimeRelease={version:"0.1.0-rc.1",sourceCommit:oid("c"),script,pngWorkerUrl:new URL("file:///fixture/png-worker.js")};
function invocation(stage:ActionInvocation["stage"]):ActionInvocation{
  return readInvocation({INPUT_STAGE:stage,GITHUB_EVENT_NAME:stage==="ingest"?"workflow_run":"workflow_dispatch",GITHUB_REPOSITORY:"owner/project",GITHUB_REPOSITORY_ID:"42",
    GITHUB_RUN_ID:"41",GITHUB_RUN_ATTEMPT:"2",GITHUB_SHA:oid("b"),GITHUB_REF:"refs/heads/main",RUNNER_NAME:"trusted runner",GITHUB_WORKFLOW_REF:"owner/project/.github/workflows/pixelwatch-report.yml@refs/heads/main",
    PIXELWATCH_WORKFLOW_REPOSITORY:"MattShelton04/PixelWatch",PIXELWATCH_WORKFLOW_SHA:oid("a")},encoder.encode('{"repository":{"id":42,"full_name":"owner/project"}}'),oid("a"));
}
async function fixture<T>(operation:(root:string,output:string)=>Promise<T>):Promise<T>{
  const anchor=realpathSync(tmpdir()),root=mkdtempSync(join(anchor,"pixelwatch-host-stage-")),output=join(root,"output");writeFileSync(output,"");
  try{return await operation(root,output);}finally{
    const target=resolve(root),rel=relative(anchor,target);assert.ok(!isAbsolute(rel)&&/^pixelwatch-host-stage-[A-Za-z0-9_-]+$/.test(rel)&&realpathSync(target)===target&&!lstatSync(target).isSymbolicLink());rmSync(target,{recursive:true,force:false});
  }
}
function input(stage:ActionInvocation["stage"],runnerTemp:string,outputPath:string):HostStageInput{return {invocation:invocation(stage),release,runnerTemp,outputPath};}
function ports(overrides:Partial<HostStagePorts>={}):{ports:HostStagePorts;calls:string[]}{
  const calls:string[]=[],absent=()=>{throw new Error("unexpected unit port");};
  return {calls,ports:{ingest:()=>{calls.push("ingest");return absent();},maintenance:()=>{calls.push("maintenance");return absent();},prepare:()=>{calls.push("prepare");return absent();},
    finish:()=>{calls.push("finish");return absent();},renderProjectionSummary:()=>{calls.push("summary");return absent();},...overrides}};
}
function source():SourceJobResult{
  const parsed=parseDocument("run",readFileSync(new URL("../../../testdata/schemas/run/valid/no-usable-artifact.json",import.meta.url)));assert.ok(parsed.ok);
  return {admission:{status:"stored",tip:oid("e"),run:parsed.value,added:true,attempts:1},diagnostics:{source:[],missing:[],ignored:[],ignoredOverflow:0,excludedCount:0,cleanup:[]},projection:"pending"};
}
async function prepared():Promise<PreparedProjection>{
  const config:Config={schemaVersion:1,source:{workflowIds:["30"],events:["pull_request","push"]},providers:[{id:"fixture",shards:1}]},store=newStore("42"),bytes=canonicalBytes(store);
  const context={repository:{owner:"owner",name:"project",repositoryId:"42"},config,configCommit:oid("d"),pages:{url:"https://owner.github.io/project/",host:"owner.github.io"},assets:{release:release.version,releaseCommit:oid("a"),script}};
  const assembled=await assembleSite({...context,snapshot:{tip:oid("e"),store,runs:new Map(),files:[{path:"store.json",bytes:bytes.byteLength}],readFile:()=>Promise.resolve(bytes)}});
  // The handoff owns native views; keep every exact byte assertion while making the input fixture own the same native view type.
  const site={...assembled,files:assembled.files.map(file=>({...file,bytes:Uint8Array.from(file.bytes)}))};
  return {schemaVersion:1,context,defaultBranch:"main",report:invocation("prepare").report,environment:{environmentId:"5",defaultBranch:"main"},deployment:{current:{deploymentId:"6",jobId:"7",states:["in_progress"]},priorDeploymentIds:[],complete:true},store,records:[],site,targets:[],deferred:[]};
}
function finishResult(value:PreparedProjection):ProjectionResult{return {defaultBranch:value.defaultBranch,reportWorkflowPath:value.report.workflowPath,environmentId:value.environment.environmentId,deploymentId:value.deployment.current.deploymentId,
  storeTip:value.site.storeTip,generation:value.site.generation,configCommit:value.context.configCommit,releaseCommit:value.context.assets.releaseCommit,deployment:"failure",
  readiness:{status:"pending",reason:"timeout",generation:value.site.generation,pollCount:9,consecutivePasses:0,elapsedMilliseconds:90000,polls:[]},comments:[],deferred:[]};}
function outputs(path:string):Record<string,string>{const text=readFileSync(path,"utf8");assertNoSecrets([text]);return Object.fromEntries(text.trim().split("\n").filter(Boolean).map(line=>{const separator=line.indexOf("=");return [line.slice(0,separator),line.slice(separator+1)];}));}
/** Both Buffer and Uint8Array are valid views; compare every byte and metadata field. */
function exactFiles(files:readonly {readonly bytes:Uint8Array}[]):unknown{return files.map(file=>{assert.ok(file.bytes instanceof Uint8Array);return {...file,bytes:Buffer.from(file.bytes)};});}

describe("trusted host stage composition units (not product simulation or live acceptance)",()=>{
  it("unknown ingestion refusal produces no project output or prepare call",async()=>{await fixture(async(root,output)=>{
    let ingests=0;const unit=ports({ingest:()=>{ingests++;return Promise.reject(new PublisherError("unsupported-document-version"));}}),result=await runHostStage(input("ingest",root,output),unit.ports);
    assert.equal(ingests,1);assert.equal(result.exitCode,1);assert.equal(result.project,false);assert.equal(result.stored,false);assert.equal(readFileSync(output,"utf8"),"");assert.deepEqual(unit.calls,[]);assertNoSecrets([JSON.stringify(result)]);
  });});
  it("a proven durable source publishes only bounded stored and project outputs",async()=>{await fixture(async(root,output)=>{
    let received:Uint8Array|undefined;const unit=ports({ingest:event=>{received=event;return Promise.resolve(source());}}),selected=input("ingest",root,output),result=await runHostStage(selected,unit.ports);
    assert.deepEqual(received,selected.invocation.event);assert.notEqual(received,selected.invocation.event);assert.equal(result.exitCode,0);assert.equal(result.stored,true);assert.equal(result.project,true);assert.deepEqual(outputs(output),{stored:"true",project:"true",projection:"pending"});assert.ok(result.summary.includes("stored; deployment pending")&&result.summary.includes("repair"));assert.deepEqual(unit.calls,[]);
  });});
  it("expired admission does not start projection and raw port errors never enter summaries",async()=>{await fixture(async(root,output)=>{
    const unit=ports({ingest:()=>Promise.resolve({...source(),admission:{status:"expired",runKey:"41-a2",tip:oid("e"),reason:"pr-run-limit",attempts:1},projection:"not-retained"})}),result=await runHostStage(input("ingest",root,output),unit.ports);
    assert.equal(result.exitCode,0);assert.equal(result.project,false);assert.equal(result.stored,false);assert.deepEqual(outputs(output),{stored:"false",project:"false",projection:"not-retained"});
    writeFileSync(output,"");const failure=await runHostStage(input("ingest",root,output),ports({ingest:()=>Promise.reject(new Error(CANARY_TOKEN))}).ports);assert.equal(failure.exitCode,1);assertNoSecrets([JSON.stringify(failure)]);assert.equal(readFileSync(output,"utf8"),"");
  });});
  it("output refusal keeps the proven durable result and fixed repair diagnostic",async()=>{await fixture(async(root,output)=>{
    const result=await runHostStage({...input("ingest",root,output),outputPath:join(root,"missing-output")},ports({ingest:()=>Promise.resolve(source())}).ports);
    assert.equal(result.exitCode,1);assert.equal(result.stored,true);assert.equal(result.project,true);assert.deepEqual(result.warnings,["output-failed"]);assert.ok(result.summary.includes("stored; deployment pending")&&result.summary.includes("repair"));assertNoSecrets([JSON.stringify(result)]);
  });});
  it("manual maintenance has no capture and only retained state requests repair",async()=>{await fixture(async(root,output)=>{
    for(const status of ["absent","unchanged","updated","recovered"] as const){writeFileSync(output,"");let calls=0;
      const unit=ports({maintenance:()=>{calls++;return Promise.resolve({status,tip:status==="absent"?null:oid("e"),attempts:1,unknownPushes:0,deleted:[],removedRuns:[]});}}),result=await runHostStage(input("maintenance",root,output),unit.ports);
      assert.equal(calls,1);assert.equal(result.exitCode,0);assert.equal(result.project,status!=="absent");assert.deepEqual(outputs(output),{stored:"false",project:String(status!=="absent"),projection:status==="absent"?"not-attempted":"pending"});assert.deepEqual(unit.calls,[]);
    }
  });});
  it("prepare persists exact real assembly privately and absent state emits no upload root",async()=>{await fixture(async(root,output)=>{
    const absent=await runHostStage(input("prepare",root,output),ports({prepare:()=>Promise.resolve({status:"absent",repositoryId:"42"})}).ports);assert.equal(absent.exitCode,0);assert.deepEqual(outputs(output),{prepared:"false"});assert.equal(readdirSync(root).filter(name=>name.startsWith("pixelwatch-stage-")).length,0);writeFileSync(output,"");
    const value=await prepared(),result=await runHostStage(input("prepare",root,output),ports({prepare:()=>Promise.resolve({status:"prepared",projection:value})}).ports);assert.equal(result.exitCode,0);assert.equal(result.prepared,true);
    const written=outputs(output);assert.equal(written["prepared"],"true");assert.ok(written["capsule"]&&written["capsule_sha256"]&&written["upload_root"]);const staged=readStagedSite(written["capsule"],written["capsule_sha256"],root);
    assert.equal(staged.uploadRoot,written["upload_root"]);assert.deepEqual(exactFiles(staged.files),exactFiles(value.site.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))));assert.ok(staged.preparedPayload);assert.equal(readdirSync(staged.uploadRoot).includes("prepared.json"),false);cleanupStagedSite(staged,root);
  });});
  it("finish authenticates the own prepared digest report and app before calling projection",async()=>{await fixture(async(root,output)=>{
    const value=await prepared();await runHostStage(input("prepare",root,output),ports({prepare:()=>Promise.resolve({status:"prepared",projection:value})}).ports);const written=outputs(output);assert.ok(written["capsule"]&&written["capsule_sha256"]);
    let finishes=0;const unit=ports({finish:(restored,observation)=>{finishes++;assert.equal(restored.site.generation,value.site.generation);assert.deepEqual(exactFiles(restored.site.files),exactFiles(value.site.files));assert.equal(observation.outcome,"failure");return Promise.resolve(finishResult(restored));},renderProjectionSummary:()=>"Readiness: stored; deployment pending; run repair"});
    const selected={...input("finish",root,output),finish:{capsulePath:written["capsule"],capsuleSha256:written["capsule_sha256"],observation:{outcome:"failure" as const}}};
    const foreign=await runHostStage({...selected,invocation:{...selected.invocation,report:{...selected.invocation.report,attempt:1}}},unit.ports);assert.equal(foreign.exitCode,1);assert.equal(finishes,0);
    const good=await runHostStage(selected,unit.ports);assert.equal(good.exitCode,0);assert.equal(finishes,1);assert.ok(good.summary.includes("deployment pending"));assert.equal(readdirSync(root).filter(name=>name.startsWith("pixelwatch-stage-")).length,0);
  });});
  it("staging uses the rebuilt configured prefix rather than a supplied URL lookalike",async()=>{await fixture(async(root,output)=>{
    const value=await prepared(),lookalikeUrls=Object.create(value.site.urls) as typeof value.site.urls;Object.defineProperty(lookalikeUrls,"prefix",{value:"different"});const lookalike={...value,site:{...value.site,urls:lookalikeUrls}};
    const result=await runHostStage(input("prepare",root,output),ports({prepare:()=>Promise.resolve({status:"prepared",projection:lookalike})}).ports);assert.equal(result.exitCode,0);
    const written=outputs(output);assert.ok(written["capsule"]&&written["capsule_sha256"]);const staged=readStagedSite(written["capsule"],written["capsule_sha256"],root);
    assert.equal(staged.prefix,value.site.urls.prefix);assert.equal(readdirSync(staged.uploadRoot).includes("different"),false);cleanupStagedSite(staged,root);
  });});
  it("changed private prepared bytes refuse before finish and arbitrary capsule paths cannot be deleted",async()=>{await fixture(async(root,output)=>{
    const value=await prepared();await runHostStage(input("prepare",root,output),ports({prepare:()=>Promise.resolve({status:"prepared",projection:value})}).ports);const written=outputs(output);assert.ok(written["capsule"]&&written["capsule_sha256"]);const staged=readStagedSite(written["capsule"],written["capsule_sha256"],root);
    writeFileSync(join(staged.taskRoot,"prepared.json"),"{}");let calls=0;const unit=ports({finish:()=>{calls++;return Promise.resolve(finishResult(value));}}),result=await runHostStage({...input("finish",root,output),finish:{capsulePath:staged.capsulePath,capsuleSha256:staged.capsuleSha256,observation:{outcome:"success"}}},unit.ports);
    assert.equal(result.exitCode,1);assert.equal(calls,0);assert.equal(readFileSync(join(staged.taskRoot,"prepared.json"),"utf8"),"{}");assertNoSecrets([JSON.stringify(result)]);
  });});
});

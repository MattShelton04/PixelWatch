import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import {mkdirSync,readFileSync,renameSync,truncateSync,unlinkSync,writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {basename,isAbsolute,join,relative,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {Worker} from "node:worker_threads";
import {canonicalBytes} from "../../../packages/schemas/src/index.ts";
import {blobPath,decodePng,encodePng,newStore,pixelHash,runRecordPath} from "../../../packages/core/src/index.ts";
import {tinyPng} from "../../../packages/core/test/ingest-fixtures.ts";
import type {EntryResult} from "../src/main.ts";
import {actualEntryBundle,cleanupEntryFixtures,entryFiles,entryHash,entryHeldCheckpoint,entryJson,entryPart,entryRaw,entryRecord,entrySourceRoot,entryWorld,scanEntryRaw,ENTRY_API,ENTRY_HEAD,ENTRY_TIME,ENTRY_VERSION,type ActualEntryBundle,type EntryWorld} from "./entry-fixture.ts";

let bundle:ActualEntryBundle;
let setupComplete=false;
const originalExecArgv=[...process.execArgv];
const originalRm=fs.rmSync;
let scannedValues=0,scannedBytes=0,scanFailures=0;
beforeAll(async()=>{bundle=await actualEntryBundle();process.execArgv=[...originalExecArgv,"--import",pathToFileURL(bundle.guard).href];setupComplete=true;});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync=originalRm;syncBuiltinESMExports();scanEntryRaw(entryRaw);});
afterAll(()=>{
  try{
    scannedValues=entryRaw.length;scannedBytes=entryRaw.reduce((total,value)=>total+(typeof value==="string"?Buffer.byteLength(value):value.byteLength),0);
    const directory=join(entrySourceRoot,".tools/logs");mkdirSync(directory,{recursive:true});
    // Every private value is retained before the final scan, including any rejected value.
    writeFileSync(join(directory,"entry-actual-source-raw.json"),JSON.stringify(entryRaw.map(value=>typeof value==="string"?{text:value}:{bytesBase64:Buffer.from(value).toString("base64")})));
    try{scanEntryRaw(entryRaw);}catch{scanFailures++;throw new Error("entry-secret-leak");}
    const proof=setupComplete?{actualMainSource:true,targetStages:["ingest","maintenance"],acceptance:"determined-only-by-complete-suite-result",projectionDependencies:"unavailable",values:scannedValues,bytes:scannedBytes,failures:scanFailures,
      sourceCommit:bundle.sourceCommit,releaseCommit:bundle.releaseCommit,version:ENTRY_VERSION,artifacts:bundle.artifacts.map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes.byteLength}))}
      :{actualMainSource:true,fixtureSetup:"not-completed",acceptance:"no-execution-proof",values:scannedValues,bytes:scannedBytes,failures:scanFailures};
    writeFileSync(join(directory,"entry-actual-source-fixture-session.json"),JSON.stringify(proof));
    console.info(JSON.stringify({entryRawScan:{values:scannedValues,bytes:scannedBytes,failures:scanFailures}}));
  }finally{process.execArgv=originalExecArgv;cleanupEntryFixtures();}
});
async function stored(world=entryWorld(bundle)) {
  const result=await world.run();
  expect(result).toMatchObject({status:"completed",exitCode:0,outcome:{stage:"ingest",exitCode:0,stored:true,project:true,prepared:false},source:{admission:{status:"stored",run:{runKey:"99-a7"}},projection:"pending"},warnings:[]});
  expect(result.outcome?.summary).toContain("stored; deployment pending");expect(result.outcome?.summary).toContain("repair");
  const snapshot=await world.snapshot();expect(snapshot.tip).not.toBeNull();expect(snapshot.runs.has("99-a7")).toBe(true);
  const run=snapshot.runs.get("99-a7");expect(run?.source).toMatchObject({repositoryId:"42",runId:"99",attempt:"7",createdAt:ENTRY_TIME,commits:{head:ENTRY_HEAD},releaseSha:bundle.releaseCommit});
  expect(run?.versions.release).toBe(ENTRY_VERSION);expect(world.pushes.filter(event=>event.point==="before-push")).toHaveLength(1);
  expect(world.requests.every(request=>request.method==="GET"&&request.url.startsWith(ENTRY_API))).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.source)).toBe(true);expect(Object.isFrozen(result.warnings)).toBe(true);
  return {world,result,snapshot};
}
async function refused(world:EntryWorld,environment:Readonly<Record<string,string|undefined>>=world.environment):Promise<EntryResult> {
  const result=await world.run(environment);expect(result.exitCode).toBe(1);expect(result.outcome?.project??false).toBe(false);expect(result.outcome?.stored??false).toBe(false);
  expect(world.pushes).toEqual([]);expect((await world.snapshot()).tip).toBeNull();return result;
}
function fixedDependencies(result:EntryResult):void {expect(result).toMatchObject({status:"failed",exitCode:1,code:"dependencies-unavailable",warnings:[]});expect(result.outcome).toBeUndefined();}
function cleanupNativeClient(path:string):void {
  const target=resolve(path),rel=relative(resolve(fs.realpathSync.native(tmpdir())),target);
  if(isAbsolute(rel)||!/^pixelwatch-store-client-[A-Za-z0-9_-]+$/.test(rel)||fs.lstatSync(target).isSymbolicLink()||fs.realpathSync(target)!==target)throw new Error("entry-fixture-cleanup-refused");
  originalRm(target,{recursive:true,force:false});
}

describe("actual released publisher entry (ingest and capture-free maintenance)",()=>{
  it("released ingestion executes its sibling worker and stores canonical pixels through genuine GitHubClient and isolated Git",async()=>{
    const post=vi.spyOn(Worker.prototype,"postMessage"),terminate=vi.spyOn(Worker.prototype,"terminate");
    const {snapshot}=await stored();
    const image=await decodePng(tinyPng(1)),hash=pixelHash(image),bytes=await snapshot.readFile(blobPath(hash));entryRecord(bytes);
    expect(bytes).toEqual(encodePng(image));expect(pixelHash(await decodePng(bytes))).toBe(hash);
    const operations=post.mock.calls.map(call=>{const message:unknown=call[0];return typeof message==="object"&&message!==null&&"op" in message?String(message.op):"";});
    expect(operations).toContain("decode");expect(operations).toContain("encode");expect(operations).toContain("compare");expect(terminate).toHaveBeenCalledTimes(1);
    expect(entryFiles(bundle.releaseRoot)).toEqual(["actions/publish/dist/app.js","actions/publish/dist/index.js","actions/publish/dist/png-worker.js","actions/publish/dist/release.json","actions/publish/package.json"]);
  });
  it("own checkout HEAD and product workflow SHA refuse caller-selected code before credentials",async()=>{
    await stored();
    for(const key of ["PIXELWATCH_WORKFLOW_SHA","PIXELWATCH_CHECKOUT_HEAD","PIXELWATCH_WORKFLOW_REPOSITORY"]){const world=entryWorld(bundle);world.environment[key]=key.endsWith("REPOSITORY")?"attacker/PixelWatch":"c".repeat(40);await refused(world);expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);}
    const world=entryWorld(bundle);world.environment["PIXELWATCH_WORKFLOW_SHA"]="c".repeat(40);world.environment["PIXELWATCH_CHECKOUT_HEAD"]="c".repeat(40);world.environment["GITHUB_SHA"]="c".repeat(40);await refused(world);expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);
  });
  it("invalid stage event and report identities refuse before token or adapter operations",async()=>{
    await stored();
    for(const [key,value] of [["INPUT_STAGE","execute"],["GITHUB_EVENT_NAME","pull_request_target"],["GITHUB_REPOSITORY_ID","43"],["GITHUB_RUN_ATTEMPT","0"],["GITHUB_WORKFLOW_REF","attacker/repo/.github/workflows/report.yml@refs/heads/main"],["GITHUB_REF","refs/heads/../escape"],["RUNNER_NAME","bad\nrunner"]]){
      const world=entryWorld(bundle);if(key===undefined||value===undefined)throw new Error("entry-fixture-missing");world.environment[key]=value;await refused(world);expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);
    }
    const world=entryWorld(bundle),forbidden:string[]=[];const proxy=new Proxy(world.environment,{ownKeys(){forbidden.push("enumeration");throw new Error("entry-env-refused");},get(target,key){if(key==="GH_TOKEN"||key==="GITHUB_TOKEN"||key==="PIXELWATCH_E2E_TOKEN"){forbidden.push(key);throw new Error("entry-env-refused");}return typeof key==="string"?target[key]:undefined;}});
    expect((await world.run(proxy)).outcome?.stored).toBe(true);expect(forbidden).toEqual([]);
  });
  it("bounded event and unknown config versions refuse before writes",async()=>{
    await stored();const oversized=entryWorld(bundle),path=oversized.environment["GITHUB_EVENT_PATH"];if(path===undefined)throw new Error("entry-fixture-missing");truncateSync(path,1024*1024+1);await refused(oversized);expect(oversized.tokenReads).toBe(0);expect(oversized.requests).toEqual([]);
    const unknown=entryWorld(bundle);unknown.responses.set(ENTRY_API+`/contents/.pixelwatch/config.json?ref=${"3".repeat(40)}`,entryJson({schemaVersion:2}));await refused(unknown);expect(unknown.requests.some(request=>request.url.includes("/artifacts"))).toBe(false);
  });
  it("missing replaced or mismatched runtime siblings refuse before credentials",async()=>{
    await stored();const dist=join(bundle.releaseRoot,"actions/publish/dist");
    for(const name of ["png-worker.js","app.js","release.json"]){const path=join(dist,name),bytes=readFileSync(path),moved=path+".retained";
      try{renameSync(path,moved);const world=entryWorld(bundle);await refused(world);expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);}finally{renameSync(moved,path);}
      try{writeFileSync(path,name==="release.json"?canonicalBytes({schemaVersion:1,version:ENTRY_VERSION,sourceCommit:"f".repeat(40)}):Uint8Array.of(1,2,3));const world=entryWorld(bundle);await refused(world);expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);}finally{writeFileSync(path,bytes);}
    }
  });
  it("selected unknown bundle cannot project while unselected unknown stays unopened",async()=>{
    await stored();const unknown=entryWorld(bundle),future=entryPart({bundleBytes:canonicalBytes({schemaVersion:2})});unknown.responses.set(ENTRY_API+"/actions/artifacts/1/zip",{status:200,headers:{},body:future.zip});
    const selectedListing=unknown.responses.get(ENTRY_API+"/actions/runs/99/artifacts?per_page=100&page=1");if(selectedListing===undefined)throw new Error("entry-fixture-missing");const selected=JSON.parse(Buffer.from(selectedListing.body).toString("utf8")) as {artifacts:{id:number;size_in_bytes:number}[]};for(const entry of selected.artifacts)if(entry.id===1)entry.size_in_bytes=future.zip.byteLength;unknown.responses.set(ENTRY_API+"/actions/runs/99/artifacts?per_page=100&page=1",entryJson({total_count:selected.artifacts.length,artifacts:selected.artifacts}));await refused(unknown);expect(unknown.requests.some(request=>request.url.endsWith("/artifacts/1/zip"))).toBe(true);
    const unrelated=entryWorld(bundle),listing=unrelated.responses.get(ENTRY_API+"/actions/runs/99/artifacts?per_page=100&page=1");if(listing===undefined)throw new Error("entry-fixture-missing");
    const metadata=JSON.parse(Buffer.from(listing.body).toString("utf8")) as {artifacts:unknown[]};unrelated.responses.set(ENTRY_API+"/actions/runs/99/artifacts?per_page=100&page=1",entryJson({total_count:metadata.artifacts.length+1,artifacts:[...metadata.artifacts,{id:3,name:"unrelated-future-bundle",size_in_bytes:future.zip.byteLength,expired:false}]}));
    unrelated.responses.set(ENTRY_API+"/actions/artifacts/3/zip",{status:200,headers:{},body:future.zip});await stored(unrelated);expect(unrelated.requests.some(request=>request.url.endsWith("/artifacts/3/zip"))).toBe(false);
  });
  it("capture-free maintenance uses actual retained store without artifacts or synthetic run",async()=>{
    const {world,snapshot}=await stored();const before=await snapshot.readFile(runRecordPath("99-a7"));world.requests.splice(0);world.pushes.splice(0);world.environment["INPUT_STAGE"]="maintenance";world.environment["GITHUB_EVENT_NAME"]="workflow_dispatch";
    const result=await world.run();expect(result).toMatchObject({status:"completed",exitCode:0,outcome:{stage:"maintenance",stored:false,project:true},maintenance:{status:"unchanged",removedRuns:[],deleted:[]}});
    const after=await world.snapshot();expect(after.tip).toBe(snapshot.tip);expect(after.store.runs).toEqual(snapshot.store.runs);expect(await after.readFile(runRecordPath("99-a7"))).toEqual(before);expect(world.pushes).toEqual([]);expect(world.requests.some(request=>/\/actions\/|\/artifacts\//.test(request.url))).toBe(false);
  });
  it("one ten-minute scope includes policy and stops new CAS after expiry",async()=>{
    await stored();const expired=entryWorld(bundle);expired.requestOverride=request=>{if(request.url===ENTRY_API+"/pages"){expired.clock.milliseconds=600000;return Promise.resolve(expired.responses.get(request.url)??entryJson(null));}return undefined;};await refused(expired);expect(expired.clock.deadlines.filter(ms=>ms===600000)).toHaveLength(1);
    const sent=entryWorld(bundle),ports={...sent.ports,testRemote:{root:sent.scratch.root,checkpoint(event:Parameters<NonNullable<NonNullable<typeof sent.ports.testRemote>["checkpoint"]>>[0]){sent.pushes.push(event);if(event.point==="after-push"){sent.clock.milliseconds=600000;sent.clock.work.abort();throw new Error("entry-fake-lost-reply");}return Promise.resolve();}}};
    const result=await bundle.run(sent.environment,ports);entryRecord(JSON.stringify(result));expect(result.source?.admission.status).toBe("stored");expect(result.outcome).toMatchObject({stored:true,project:true});expect((await sent.snapshot()).runs.has("99-a7")).toBe(true);expect(sent.pushes.filter(event=>event.point==="before-push")).toHaveLength(1);expect(sent.clock.deadlines.filter(ms=>ms===600000)).toHaveLength(1);
  });
  it("cancellation settles ignored policy and joins real resources",async()=>{
    const terminate=vi.spyOn(Worker.prototype,"terminate");await stored();expect(terminate).toHaveBeenCalledTimes(1);
    const world=entryWorld(bundle);world.requestOverride=request=>{if(request.url===ENTRY_API){queueMicrotask(()=>{world.clock.work.abort();});return new Promise(()=>{});}return undefined;};await refused(world);expect(world.requests).toHaveLength(1);expect(world.clock.disposed.filter(ms=>ms===600000)).toHaveLength(1);expect(terminate).toHaveBeenCalledTimes(1);
    const caller=new AbortController();caller.abort();const aborted=entryWorld(bundle),result=await bundle.run(aborted.environment,{...aborted.ports,signal:caller.signal});entryRecord(JSON.stringify(result));expect(result.exitCode).toBe(1);expect(aborted.requests).toEqual([]);expect(aborted.pushes).toEqual([]);
    let terminal=false;terminate.mockRestore();
    // Fault only AFTER the genuine native worker has terminally completed, before admission.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual worker receiver.
    const nativeTerminate=Worker.prototype.terminate;
    const failedTerminate=vi.spyOn(Worker.prototype,"terminate").mockImplementation(function(this:Worker){return nativeTerminate.call(this).then(()=>{terminal=true;throw new Error("entry-fake-worker-close-refusal");});});
    const workerFailure=entryWorld(bundle),failed=await workerFailure.run();expect(failed.exitCode).toBe(1);expect(failed.warnings).toContain("worker-close-failed");expect(workerFailure.pushes).toEqual([]);expect((await workerFailure.snapshot()).tip).toBeNull();expect(terminal).toBe(true);expect(failedTerminate).toHaveBeenCalledTimes(1);
  });
  it("accepted admission survives output and terminal cleanup failure with fixed finite warnings",async()=>{
    await stored();const world=entryWorld(bundle),output=world.environment["GITHUB_OUTPUT"];if(output===undefined)throw new Error("entry-fixture-missing");unlinkSync(output);mkdirSync(output);world.clock.failDispose=true;
    const retained:string[]=[];fs.rmSync=(path,options)=>{if(options?.recursive===true&&typeof path==="string"&&basename(path).startsWith("pixelwatch-store-client-")){retained.push(path);throw new Error("entry-fake-store-close-refusal");}originalRm(path,options);};syncBuiltinESMExports();
    try{
      let result:EntryResult;try{result=await world.run();}finally{fs.rmSync=originalRm;syncBuiltinESMExports();}
      expect(result).toMatchObject({status:"completed",exitCode:1,outcome:{exitCode:1,stored:true,project:true,warnings:["output-failed"]},source:{admission:{status:"stored"}},warnings:["store-close-failed","timing-disposal-failed"]});expect(result.warnings.length).toBeLessThanOrEqual(4);expect(new Set(result.warnings).size).toBe(result.warnings.length);expect(world.clock.disposed.filter(ms=>ms===600000)).toHaveLength(1);
      expect((await world.snapshot()).runs.has("99-a7")).toBe(true);expect(retained).toHaveLength(1);
    }finally{
      fs.rmSync=originalRm;syncBuiltinESMExports();
      for(const path of retained)cleanupNativeClient(path);
    }
  });
  it("prepare and finish precisely refuse absent approved dependencies",async()=>{
    await stored();for(const stage of ["prepare","finish"]){const world=entryWorld(bundle);world.environment["INPUT_STAGE"]=stage;fixedDependencies(await world.run());expect(world.tokenReads).toBe(0);expect(world.requests).toEqual([]);expect(world.pushes).toEqual([]);expect((await world.snapshot()).tip).toBeNull();}
  });
  it("two isolated actual-main builds have equal full artifacts and source-free runtime",async()=>{
    await stored();const second=await actualEntryBundle();expect(second.sourceRoot).not.toBe(bundle.sourceRoot);expect(second.sourceCommit).toBe(bundle.sourceCommit);expect(second.releaseCommit).toBe(bundle.releaseCommit);
    expect(second.artifacts.map(file=>({path:file.path,sha256:file.sha256}))).toEqual(bundle.artifacts.map(file=>({path:file.path,sha256:file.sha256})));for(const file of second.artifacts){expect(entryHash(file.bytes)).toBe(file.sha256);expect(Buffer.from(file.bytes).toString("utf8")).not.toContain(second.sourceRoot);expect(Buffer.from(file.bytes).toString("utf8")).not.toMatch(/(?:from|import\(|require\()\s*["'][^"']+\.ts["']/);}
    const world=entryWorld(second),result=await second.run(world.environment,world.ports);entryRecord(JSON.stringify(result));expect(result.source?.admission.status).toBe("stored");expect(result.outcome).toMatchObject({stored:true,project:true});expect((await world.snapshot()).runs.has("99-a7")).toBe(true);expect(entryFiles(second.releaseRoot).some(path=>path.endsWith(".ts")||path.includes("node_modules"))).toBe(false);
  });
  it("expiry at the actual native before-push boundary refuses a new unsent mutation",async()=>{
    await stored();const world=entryWorld(bundle);let reached=0;
    const result=await bundle.run(world.environment,{...world.ports,testRemote:{root:world.scratch.root,checkpoint(event){
      world.pushes.push(event);if(event.point==="before-push"){reached++;world.clock.milliseconds=600000;world.clock.work.abort();}
      return Promise.resolve();
    }}});entryRecord(JSON.stringify({result,reached,pushes:world.pushes,deadlines:world.clock.deadlines,disposed:world.clock.disposed}));
    expect(reached).toBe(1);expect(result.exitCode).toBe(1);expect(result.source?.admission.status==="stored").toBe(false);
    expect(result.outcome?.stored??false).toBe(false);expect(result.outcome?.project??false).toBe(false);
    expect(world.pushes.filter(event=>event.point==="after-push")).toEqual([]);expect((await world.snapshot()).tip).toBeNull();
    expect(world.clock.deadlines.filter(ms=>ms===600000)).toHaveLength(1);expect(world.clock.disposed.filter(ms=>ms===600000)).toHaveLength(1);
  });
  it("a held initial native pack read cancels and joins cleanup without changing retained data",async()=>{
    const {world,snapshot}=await stored();world.environment["INPUT_STAGE"]="maintenance";world.environment["GITHUB_EVENT_NAME"]="workflow_dispatch";
    const observed=entryHeldCheckpoint(bundle,world,"initial-read");
    expect(observed.proof.reached).toBe(1);expect(observed.proof.outerAborted).toBe(true);expect(observed.proof.milliseconds).toBe(600000);
    expect(observed.status).toBe(0);expect(observed.proof.phase).toBe("actual-entry-settled");expect(observed.proof.result).toMatchObject({exitCode:1});
    expect(observed.proof.result?.source?.admission.status==="stored").toBe(false);expect(observed.proof.checkpoints).toEqual([]);
    expect(observed.proof.clients).toHaveLength(1);expect(observed.proof.clients.every(client=>!client.remaining)).toBe(true);
    expect(observed.proof.disposed.filter(ms=>ms===600000)).toHaveLength(1);expect((await world.snapshot()).tip).toBe(snapshot.tip);
  });
  it("a held already-sent native checkpoint settles through genuine unknown-reply recovery",async()=>{
    await stored();const world=entryWorld(bundle),observed=entryHeldCheckpoint(bundle,world,"after-push");
    expect(observed.proof.reached).toBe(1);expect(observed.proof.outerAborted).toBe(true);expect(observed.proof.milliseconds).toBe(600000);
    expect(observed.status).toBe(0);expect(observed.proof.phase).toBe("actual-entry-settled");expect(observed.proof.result).toMatchObject({exitCode:0,source:{admission:{status:"stored"}},outcome:{stored:true,project:true}});
    expect(observed.proof.checkpoints.filter(event=>event.point==="before-push")).toHaveLength(1);expect(observed.proof.checkpoints.filter(event=>event.point==="after-push")).toHaveLength(1);
    expect(observed.proof.clients).toHaveLength(1);expect(observed.proof.clients.every(client=>!client.remaining)).toBe(true);
    expect(observed.proof.disposed.filter(ms=>ms===600000)).toHaveLength(1);expect((await world.snapshot()).runs.has("99-a7")).toBe(true);
  });
  it("the production clock default supplies canonical second timestamps to ingest and maintenance",async()=>{
    await stored();const world=entryWorld(bundle),{now,...ports}=world.ports;expect(typeof now).toBe("function");
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-04T00:00:00.123Z"));
    try{
      const result=await bundle.run(world.environment,ports);entryRecord(JSON.stringify(result));
      expect(result).toMatchObject({exitCode:0,source:{admission:{status:"stored"}},outcome:{stored:true,project:true}});
      const before=await world.snapshot();expect(before.runs.has("99-a7")).toBe(true);if(before.tip===null)throw new Error("entry-fixture-missing-tip");
      const author=world.scratch.git(["cat-file","commit",before.tip],undefined,world.scratch.remote).split("\n").find(line=>line.startsWith("author "));expect(author).toMatch(/^author [^\n]+ 1791072000 \+0000$/);
      world.environment["INPUT_STAGE"]="maintenance";world.environment["GITHUB_EVENT_NAME"]="workflow_dispatch";
      const maintenance=await bundle.run(world.environment,ports);entryRecord(JSON.stringify(maintenance));
      expect(maintenance.exitCode).toBe(0);expect(maintenance.maintenance?.status).toBe("unchanged");expect((await world.snapshot()).tip).toBe(before.tip);
    }finally{vi.useRealTimers();}
  });
  it("a genuine native lease conflict cannot strand an expired ignored admission retry delay",async()=>{
    await stored();const world=entryWorld(bundle),observed=entryHeldCheckpoint(bundle,world,"conflict-delay");
    expect(observed.proof.reached).toBe(1);expect(observed.proof.outerAborted).toBe(true);expect(observed.proof.milliseconds).toBe(600000);
    expect(observed.proof.delayCalls).toBe(1);expect(observed.proof.delayMilliseconds).toBe(142);expect(observed.proof.competingCalls).toBe(1);
    expect(observed.proof.competitorEvents.find(event=>event.point==="after-push")?.result).toBe("accepted");
    expect(observed.proof.checkpoints.filter(event=>event.point==="before-push")).toHaveLength(1);expect(observed.proof.checkpoints.filter(event=>event.point==="after-push")).toHaveLength(1);expect(observed.proof.checkpoints.find(event=>event.point==="after-push")?.result).toBe("conflict");
    expect(observed.status).toBe(0);expect(observed.proof.phase).toBe("actual-entry-settled");expect(observed.proof.result?.exitCode).toBe(1);expect(observed.proof.result?.source?.admission.status==="stored").toBe(false);expect(observed.proof.result?.outcome?.stored??false).toBe(false);expect(observed.proof.result?.outcome?.project??false).toBe(false);
    expect(observed.proof.clients).toHaveLength(2);expect(observed.proof.clients.every(client=>!client.remaining)).toBe(true);expect(observed.proof.disposed.filter(ms=>ms===600000)).toHaveLength(1);
    const after=await world.snapshot();expect(after.tip).toBe(observed.proof.competingTip);expect(after.store).toEqual(newStore("42"));expect(after.runs.size).toBe(0);expect(after.files.map(file=>file.path)).toEqual(["store.json"]);expect(await after.readFile("store.json")).toEqual(Uint8Array.from(canonicalBytes(newStore("42"))));
  });
  for(const [mode,target] of [["admission-read",3],["cas-read",4]] as const){
    it(`the actual unsent ${mode} pack cancels and joins its native resources`,async()=>{
      await stored();const world=entryWorld(bundle),observed=entryHeldCheckpoint(bundle,world,mode);
      expect(observed.proof.reached).toBe(1);expect(observed.proof.outerAborted).toBe(true);expect(observed.proof.milliseconds).toBe(600000);expect(observed.proof.packIndexes).toBe(target);expect(observed.proof.downloadedArtifacts).toBe(2);expect(observed.proof.checkpoints).toEqual([]);
      expect(observed.status).toBe(0);expect(observed.proof.phase).toBe("actual-entry-settled");expect(observed.proof.result?.exitCode).toBe(1);expect(observed.proof.result?.source?.admission.status==="stored").toBe(false);expect(observed.proof.result?.outcome?.stored??false).toBe(false);expect(observed.proof.result?.outcome?.project??false).toBe(false);
      expect(observed.proof.clients).toHaveLength(2);expect(observed.proof.clients.every(client=>!client.remaining)).toBe(true);expect(observed.proof.disposed.filter(ms=>ms===600000)).toHaveLength(1);
      const after=await world.snapshot();expect(after.tip).toBe(observed.proof.markerTip);expect(after.store).toEqual(newStore("42"));expect(after.runs.size).toBe(0);expect(after.files.map(file=>file.path)).toEqual(["store.json"]);expect(await after.readFile("store.json")).toEqual(Uint8Array.from(canonicalBytes(newStore("42"))));
    });
  }
  it("the native pack signal immediately follows outer cancellation and reaches the HTTP component unchanged",async()=>{
    await stored();const world=entryWorld(bundle),observed=entryHeldCheckpoint(bundle,world,"pack-signal");
    expect(observed.status).toBe(0);expect(observed.proof.reached).toBe(1);expect(observed.proof.nativePackPid).toBeGreaterThan(0);
    expect(observed.proof.packSignalImmediatelyAborted).toBe(true);expect(observed.proof.httpComponentSignalIdentical).toBe(true);expect(observed.proof.httpComponentFetchCalls).toBe(1);expect(observed.proof.httpComponentStreamTerminal).toBe(true);expect(observed.proof.rawSignalGetterReads).toBe(0);
    expect(observed.proof.result?.exitCode).toBe(1);expect(observed.proof.checkpoints).toEqual([]);expect(observed.proof.clients).toHaveLength(2);expect(observed.proof.clients.every(client=>!client.remaining)).toBe(true);expect((await world.snapshot()).tip).toBe(observed.proof.markerTip);
  });
});

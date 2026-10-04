import { createHash } from "node:crypto";
import { deriveStreams, generationId, prPointerPath, PROJECTION_VERSION, siteLocation, siteUrls, sizeLimits } from "@pixelwatch/core";
import { canonicalBytes, isGitHubId, parseDocument, type Run } from "@pixelwatch/schemas";
import { STORE_LIMITS, type StoreSnapshot } from "@pixelwatch/store";
import { validateTree } from "./admission-input.ts";
import { assembleSite } from "./assemble.ts";
import { captureContext, checkedDocument, checkedOid, copyBytes } from "./assembly-input.ts";
import { array, branch, environment, history, report, storedKind, warnings, type ProjectionScope } from "./projection-input.ts";
import { refuse, type AssembledFile, type AssembledSite, type PreparedProjection, type ProjectionDeferred, type ReadinessTarget } from "./types.ts";

const MAX_FILES=3*STORE_LIMITS.maxFiles+2*1001+16, MAX_TARGETS=1000;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const equal=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const categories=["html","app","api","stubs","data","blobs","derived","grace"] as const;
const reasons=["comment-disabled","pr-closed","pr-unavailable","no-eligible-run","pointer-mismatch","head-changed","comment-order-unproved"] as const;
interface Captured {readonly value:PreparedProjection;readonly snapshot:StoreSnapshot}
/** Persisted methods and hashes grant no authority: rebuild the actual fixed assembly. */
function capture(source:PreparedProjection):Captured {
  const schema:unknown=source.schemaVersion;if(schema!==1)refuse("projection-state-invalid");
  const context=captureContext(source.context), defaultBranch=branch(source.defaultBranch), ownedReport=report(source.report,defaultBranch);
  const ownedEnvironment=environment(source.environment,defaultBranch), deployment=history(source.deployment), store=checkedDocument("store",source.store);
  if(store.repositoryId!==context.repository.repositoryId)refuse("projection-state-invalid");
  const suppliedRecords=source.records, recordCount=suppliedRecords.length;
  if(!array(suppliedRecords)||!Number.isSafeInteger(recordCount)||recordCount<0||recordCount>STORE_LIMITS.maxFiles||recordCount!==store.runs.length)refuse("projection-state-invalid");
  const runs=new Map<string,Run>();
  for(let index=0;index<recordCount;index++) {
    const supplied=suppliedRecords[index];if(supplied===undefined)refuse("projection-state-invalid");
    const record=checkedDocument("run",supplied);if(runs.has(record.runKey))refuse("projection-state-invalid");runs.set(record.runKey,record);
  }
  const suppliedSite=source.site, storeTip=checkedOid(suppliedSite.storeTip), generation=suppliedSite.generation;
  if(suppliedSite.configCommit!==context.configCommit||suppliedSite.releaseCommit!==context.assets.releaseCommit
    || generation!==generationId({storeTip,configCommit:context.configCommit,releaseCommit:context.assets.releaseCommit,projectionVersion:PROJECTION_VERSION}))refuse("projection-state-invalid");
  const sourceFiles=suppliedSite.files,count=sourceFiles.length,limits=sizeLimits(context.config);
  if(!array(sourceFiles)||!Number.isSafeInteger(count)||count<0||count>MAX_FILES)refuse("projection-state-invalid");
  const files:AssembledFile[]=[],seen=new Set<string>();let totalBytes=0;
  const breakdown={html:0,app:0,api:0,stubs:0,data:0,blobs:0,derived:0,grace:0};
  for(let index=0;index<count;index++) {
    const file=sourceFiles[index];if(file===undefined)refuse("projection-state-invalid");
    const path=file.path,category=file.category,immutable=file.immutable,sha256=file.sha256;
    if(typeof path!=="string"||path.length>1024||seen.has(path)||!categories.includes(category)||typeof immutable!=="boolean")refuse("projection-state-invalid");
    const bytes=copyBytes(file.bytes,Math.min(limits.hardBytes-totalBytes,category==="blobs"||category==="derived"?STORE_LIMITS.maxPngBytes:limits.hardBytes));
    if(sha256!==hash(bytes))refuse("projection-state-invalid");
    seen.add(path);totalBytes+=bytes.byteLength;breakdown[category]+=bytes.byteLength;files.push({path,category,immutable,sha256,bytes});
  }
  if(suppliedSite.totalBytes!==totalBytes||suppliedSite.overSoftLimit!==(totalBytes>limits.softBytes)
    || categories.some(category=>suppliedSite.breakdown[category]!==breakdown[category]))refuse("projection-state-invalid");
  const site:AssembledSite={generation,storeTip,configCommit:context.configCommit,releaseCommit:context.assets.releaseCommit,
    urls:siteUrls(siteLocation(context.config,context.pages)),files,totalBytes,breakdown,overSoftLimit:totalBytes>limits.softBytes};
  const stored=new Map(files.filter(file=>storedKind(file.path)).map(file=>[file.path,file.bytes]));stored.set("store.json",canonicalBytes(store));
  validateTree({store,runs,files:stored,metadata:{timestamp:"2000-01-01T00:00:00Z"}},context.repository.repositoryId);
  const snapshot:StoreSnapshot={tip:storeTip,store,runs,files:[...stored].map(([path,bytes])=>({path,bytes:bytes.byteLength})),readFile:path=>{
    const bytes=stored.get(path);if(bytes===undefined)refuse("projection-state-invalid");return Promise.resolve(copyBytes(bytes,bytes.byteLength,bytes.byteLength));
  }};
  const streams=deriveStreams(store).filter(stream=>stream.streamId.startsWith("pr-")), retained=new Set(streams.map(stream=>stream.streamId.slice(3)));
  const sourceTargets=source.targets,targetCount=sourceTargets.length,sourceDeferred=source.deferred,deferredCount=sourceDeferred.length;
  if(!array(sourceTargets)||!array(sourceDeferred)||!Number.isSafeInteger(targetCount)||targetCount<0||!Number.isSafeInteger(deferredCount)||deferredCount<0||targetCount>MAX_TARGETS||deferredCount>MAX_TARGETS)refuse("projection-state-invalid");
  const covered=new Set<string>(),targets:ReadinessTarget[]=[],deferred:ProjectionDeferred[]=[];
  for(let index=0;index<targetCount;index++) {
    const value=sourceTargets[index];if(value===undefined)refuse("projection-state-invalid");
    const prNumber=value.prNumber,runKey=value.runKey,headSha=value.headSha,record=runs.get(runKey),stream=streams.find(item=>item.streamId===`pr-${prNumber}`);
    if(!isGitHubId(prNumber)||covered.has(prNumber)||!retained.has(prNumber)||record===undefined||stream?.latest!==runKey
      ||record.source.event!=="pull_request"||record.source.association.status!=="corroborated"||record.source.association.prNumber!==prNumber
      ||record.source.commits.head!==headSha||typeof headSha!=="string"||!/^[0-9a-f]{40}$/.test(headSha))refuse("projection-state-invalid");
    const file=files.find(item=>item.path===prPointerPath(prNumber));if(file===undefined)refuse("projection-state-invalid");
    const pointer=parseDocument("pr-pointer",file.bytes);
    if(!pointer.ok||pointer.value.prNumber!==prNumber||pointer.value.runKey!==runKey||pointer.value.headSha!==headSha||pointer.value.generation!==generation)refuse("projection-state-invalid");
    covered.add(prNumber);targets.push({prNumber,runKey,headSha});
  }
  for(let index=0;index<deferredCount;index++) {
    const value=sourceDeferred[index];if(value===undefined)refuse("projection-state-invalid");const prNumber=value.prNumber,reason=value.reason;
    if(!isGitHubId(prNumber)||covered.has(prNumber)||!retained.has(prNumber)||!reasons.includes(reason))refuse("projection-state-invalid");
    covered.add(prNumber);deferred.push({prNumber,reason});
  }
  if(covered.size!==retained.size)refuse("projection-state-invalid");
  const ownedWarnings=warnings(source.warnings);
  return {snapshot,value:{schemaVersion:1,context,defaultBranch,report:ownedReport,environment:ownedEnvironment,deployment,store,records:[...runs.values()],site,targets,deferred,
    ...(ownedWarnings.length===0?{}:{warnings:ownedWarnings})}};
}
export async function restorePrepared(source:PreparedProjection,scope:ProjectionScope):Promise<PreparedProjection> {
  try {
    const captured=capture(source),value=captured.value;
    const actual=await scope.wait(()=>assembleSite({...value.context,snapshot:captured.snapshot}),site=>site);
    if(actual.files.length!==value.site.files.length||actual.totalBytes!==value.site.totalBytes)refuse("projection-state-invalid");
    for(let index=0;index<actual.files.length;index++) {
      const expected=actual.files[index],supplied=value.site.files[index];
      if(expected===undefined||supplied===undefined||expected.path!==supplied.path||expected.category!==supplied.category
        ||expected.immutable!==supplied.immutable||expected.sha256!==supplied.sha256||!equal(expected.bytes,supplied.bytes))refuse("projection-state-invalid");
    }
    return {...value,site:actual};
  } catch {scope.check();return refuse("projection-state-invalid");}
}

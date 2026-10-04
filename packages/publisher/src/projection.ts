import { deriveStreams, prPointerPath, siteLocation, siteUrls } from "@pixelwatch/core";
import { compareRunOrder, isGitHubId, parseDocument, type Run } from "@pixelwatch/schemas";
import type { StoreSnapshot } from "@pixelwatch/store";
import { isOwnedCommentOperation, sanitizeForgeError, type BotComment, type CommentCleanupWarning, type CommentResult, type HttpTransport, type Timing } from "@pixelwatch/forge-github";
import { validateTree } from "./admission-input.ts";
import { assembleSite } from "./assemble.ts";
import { captureContext, checkedDocument, checkedOid, copyBytes, JSON_BYTES } from "./assembly-input.ts";
import { readCommentStamp, renderComment } from "./comment.ts";
import { array, bind, branch, environment, history, observe, ownSnapshot, prepareInput, ProjectionScope, pullRequest, report, repository, response, warnings } from "./projection-input.ts";
import { restorePrepared } from "./projection-state.ts";
import { waitForReadiness } from "./readiness.ts";
import { isSignalAborted } from "./signal-input.ts";
import { refuse, sanitizePublisherError, type PreparedProjection, type ProjectionCommentResult, type ProjectionDeferred, type ProjectionDeferredReason,
  type ProjectionDeploymentObservation, type ProjectionFinishDependencies, type ProjectionPreparation, type ProjectionPrepareDependencies,
  type ProjectionPrepareInput, type ProjectionResult, type PublisherContext, type ReadinessTarget } from "./types.ts";

function sameRepository(actual:PublisherContext["repository"],expected:PublisherContext["repository"]):void {
  if(actual.repositoryId!==expected.repositoryId||actual.owner!==expected.owner||actual.name!==expected.name)refuse("projection-input-invalid");
}
type Opened=Awaited<ReturnType<ProjectionPrepareDependencies["openStore"]>>;
interface StorePort {readonly read:()=>Promise<StoreSnapshot>;readonly close:()=>void|Promise<void>}
function opened(value:Opened):StorePort {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- bind retains the acquired resource receiver for close.
  const close=bind(value,value.close);
  try {const store=value.store;return {read:bind(store,store.read),close};}
  catch {try {const pending=close();if(pending!==undefined)observe(pending);}catch{/* Attempt acquired cleanup even if a later reader getter refuses. */}return refuse("projection-operation-failed");}
}
// eslint-disable-next-line @typescript-eslint/unbound-method -- bind retains the late acquired resource receiver for close.
function closeLate(value:Opened):void {const close=bind(value,value.close),pending=close();if(pending!==undefined)observe(pending);}
function closeCaptured(value:StorePort):void {const pending=value.close();if(pending!==undefined)observe(pending);}
async function getOwned(url:string,request:HttpTransport["request"],deadline:Timing["deadline"],scope:ProjectionScope):Promise<ReturnType<typeof response>> {
  const handle=scope.deadline({deadline},60000),controller=new AbortController(),removers:(()=>void)[]=[];
  try {
    for(const source of [scope.signal,handle.signal]) {
      removers.push(scope.listen(source,()=>{controller.abort();}));if(isSignalAborted(source))controller.abort();
    }
    return await scope.wait(()=>request(Object.freeze({method:"GET",url,headers:Object.freeze({accept:"application/json","cache-control":"no-cache"}),maxBytes:JSON_BYTES,signal:controller.signal})),response,undefined,controller.signal);
  } finally {for(const remove of removers)remove();handle.dispose();}
}
async function ownership(context:PublisherContext,deployment:PreparedProjection["deployment"],request:HttpTransport["request"],deadline:Timing["deadline"],scope:ProjectionScope):Promise<void> {
  const urls=siteUrls(siteLocation(context.config,context.pages));
  try {
    const served=await getOwned(urls.siteJson(),request,deadline,scope);
    if(served.status===200) {
      const site=parseDocument("site",served.body);
      if(!site.ok||site.value.repositoryId!==context.repository.repositoryId||site.value.basePath!==urls.prefix)refuse("projection-site-ownership-refused");
      return;
    }
    if(served.status!==404||deployment.priorDeploymentIds.length!==0)refuse("projection-site-ownership-refused");
    const root=await getOwned(context.pages.url,request,deadline,scope);
    if(root.status!==404)refuse("projection-site-ownership-refused");
  } catch {scope.check();refuse("projection-site-ownership-refused");}
}
/** Called by the single workflow-held project job; no lock acquisition or deployment occurs here. */
export async function prepareProjection(input:ProjectionPrepareInput,dependencies:ProjectionPrepareDependencies):Promise<ProjectionPreparation> {
  let scope:ProjectionScope|undefined,storePort:StorePort|undefined,proven:ProjectionPreparation|undefined;
  try {
    const captured=prepareInput(input),forge=dependencies.forge,metadata=dependencies.metadata,transport=dependencies.transport,timing=dependencies.timing;
    const readDefaultConfig=bind(forge,forge.readDefaultConfig),getPages=bind(forge,forge.getPages),getPullRequest=bind(forge,forge.getPullRequest);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Each method is captured once and bind preserves its original metadata receiver.
    const readEnvironment=bind(metadata,metadata.readEnvironment),readHistory=bind(metadata,metadata.readDeploymentHistory);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- bind preserves each captured transport/timing receiver.
    const openStore=bind(dependencies,dependencies.openStore),request=bind(transport,transport.request),deadline=bind(timing,timing.deadline);
    scope=new ProjectionScope({deadline},dependencies.signal);const active=scope;
    const policy=await active.wait(()=>readDefaultConfig(active.signal),value=>({repository:repository(value.repository),config:checkedDocument("config",value.config),configCommit:checkedOid(value.configSha)}));
    sameRepository(policy.repository,captured.repository);const defaultBranch=policy.repository.defaultBranch,identity=report(captured.report,defaultBranch);
    const pages=await active.wait(()=>getPages(active.signal),value=>{
      if(value===null)refuse("projection-pages-setup-required");const url=value.url,customDomain=value.customDomain;
      if(typeof url!=="string"||(customDomain!==null&&typeof customDomain!=="string"))refuse("projection-pages-setup-required");
      return {url,host:customDomain??`${policy.repository.owner.toLowerCase()}.github.io`};
    });
    const context=captureContext({config:policy.config,configCommit:policy.configCommit,pages,repository:captured.repository,assets:captured.assets});
    const env=await active.wait(()=>readEnvironment(defaultBranch,active.signal),value=>environment(value,defaultBranch));
    const deployment=await active.wait(()=>readHistory(defaultBranch,{...identity},active.signal),history);
    storePort=await active.wait(()=>openStore({repository:{...context.repository},defaultBranch,branch:context.config.store?.branch??"pixelwatch-data"}),opened,closeLate,active.signal,undefined,closeCaptured);
    const owned=await active.wait(storePort.read,value=>ownSnapshot(value,context.repository.repositoryId)),snapshot=owned.snapshot;
    if(snapshot.tip===null) {proven={status:"absent",repositoryId:context.repository.repositoryId};return proven;}
    const bytes=new Map<string,Uint8Array>();
    for(const file of snapshot.files)bytes.set(file.path,await active.wait(()=>owned.read(file.path),value=>copyBytes(value,file.bytes,file.bytes)));
    validateTree({store:snapshot.store,runs:snapshot.runs,files:bytes,metadata:{timestamp:"2000-01-01T00:00:00Z"}},context.repository.repositoryId);
    const privateSnapshot:StoreSnapshot={...snapshot,readFile:path=>{
      const body=bytes.get(path);if(body===undefined)refuse("projection-input-invalid");return Promise.resolve(copyBytes(body,body.byteLength,body.byteLength));
    }};
    const site=await active.wait(()=>assembleSite({...context,snapshot:privateSnapshot}),value=>value);
    const targets:ReadinessTarget[]=[],deferred:ProjectionDeferred[]=[];
    for(const stream of deriveStreams(snapshot.store)) {
      if(!stream.streamId.startsWith("pr-"))continue;const prNumber=stream.streamId.slice(3);
      const defer=(reason:ProjectionDeferredReason)=>{deferred.push({prNumber,reason});};
      if(context.config.comment?.enabled===false){defer("comment-disabled");continue;}
      let pr;
      try {pr=await active.wait(()=>getPullRequest(prNumber,active.signal),value=>pullRequest(value,prNumber));}
      catch {active.check();defer("pr-unavailable");continue;}
      if(pr.state==="closed"){defer("pr-closed");continue;}
      const eligible=stream.runs.map(key=>snapshot.runs.get(key)).filter((record):record is Run=>record!==undefined
        &&record.source.event==="pull_request"&&record.source.association.status==="corroborated"&&record.source.association.prNumber===prNumber&&record.source.commits.head===pr.headSha);
      eligible.sort((a,b)=>compareRunOrder({runKey:a.runKey,sourceCreatedAt:a.source.createdAt},{runKey:b.runKey,sourceCreatedAt:b.source.createdAt}));
      const selected=eligible.at(-1);if(selected===undefined){defer("no-eligible-run");continue;}
      const pointerFile=site.files.find(file=>file.path===prPointerPath(prNumber)),pointer=pointerFile===undefined?undefined:parseDocument("pr-pointer",pointerFile.bytes);
      if(stream.latest!==selected.runKey||pointer===undefined||!pointer.ok||pointer.value.runKey!==selected.runKey||pointer.value.headSha!==pr.headSha){defer("pointer-mismatch");continue;}
      targets.push({prNumber,runKey:selected.runKey,headSha:pr.headSha});
    }
    await ownership(context,deployment,request,deadline,active);
    proven={status:"prepared",projection:{schemaVersion:1,context,defaultBranch,report:identity,environment:env,deployment,store:snapshot.store,
      records:snapshot.store.runs.map(entry=>{const record=snapshot.runs.get(entry.runKey);if(record===undefined)refuse("projection-input-invalid");return record;}),site,targets,deferred}};
    return proven;
  } catch(error) {throw sanitizePublisherError(error,"projection-operation-failed");}
  finally {
    if(storePort!==undefined) {
      try {const pending=storePort.close();if(pending!==undefined){observe(pending);if(scope!==undefined)await scope.wait(()=>pending,()=>undefined);else await pending;}}
      catch {scope?.warning("store-close-failed");}
    }
    scope?.close();
    if(proven!==undefined&&scope!==undefined&&scope.warnings.length>0) {
      const result=proven.status==="prepared"?proven.projection:proven;
      (result as {warnings?:readonly typeof scope.warnings[number][]}).warnings=[...scope.warnings];
    }
  }
}
function commentReply(value:CommentResult):CommentResult {
  const status=value.status,sourceWarnings=value.warnings,cleanup:CommentCleanupWarning[]=[];
  if(sourceWarnings!==undefined){
    const count=sourceWarnings.length;
    if(!array(sourceWarnings)||!Number.isSafeInteger(count)||count<0||count>2)refuse("projection-operation-failed");
    for(let index=0;index<count;index++){
      const warning=sourceWarnings[index];if(warning===undefined||!["listener-cleanup-failed","timing-disposal-failed"].includes(warning)||cleanup.includes(warning))refuse("projection-operation-failed");cleanup.push(warning);
    }
  }
  const warnings=cleanup.length===0?{}:{warnings:cleanup};
  if(status==="deferred")return {status,...warnings};
  const commentId=value.commentId;
  if(!["unchanged","created","updated","recovered"].includes(status)||!isGitHubId(commentId))refuse("projection-operation-failed");
  return {status,commentId,...warnings};
}
/** Consume the exact privately prepared generation; never select from a later store snapshot. */
export async function finishProjection(prepared:PreparedProjection,observation:ProjectionDeploymentObservation,dependencies:ProjectionFinishDependencies):Promise<ProjectionResult> {
  let scope:ProjectionScope|undefined,proven:ProjectionResult|undefined;
  try {
    const outcome=observation.outcome;
    if(!["success","failure","cancelled","unknown","not-attempted"].includes(outcome))refuse("projection-input-invalid");
    const forge=dependencies.forge,readiness=dependencies.readiness,timing=readiness.timing,transport=readiness.transport;
    const sourceReconcile=forge.reconcileComment;
    const getRepository=bind(forge,forge.getRepository),getPullRequest=bind(forge,forge.getPullRequest),getPublishingBot=bind(forge,forge.getPublishingBot),reconcile=bind(forge,sourceReconcile);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- bind preserves each captured transport/timing receiver.
    const deadline=bind(timing,timing.deadline),delay=bind(timing,timing.delay),request=bind(transport,transport.request),now=bind(readiness,readiness.now);
    const sourceCheckpoint=readiness.checkpoint,checkpoint=sourceCheckpoint===undefined?undefined:bind(readiness,sourceCheckpoint);
    scope=new ProjectionScope({deadline},dependencies.signal,warnings(prepared.warnings));const active=scope;
    const captured=await restorePrepared(prepared,active);
    const readinessPorts={transport:{request},timing:{deadline:(milliseconds:number)=>active.deadline({deadline},milliseconds),delay},now,...(checkpoint===undefined?{}:{checkpoint})};
    const observed=await waitForReadiness({context:captured.context,site:captured.site,targets:captured.targets,signal:active.signal},readinessPorts);
    const comments:ProjectionCommentResult[]=[],records=new Map(captured.records.map(record=>[record.runKey,record]));
    proven={defaultBranch:captured.defaultBranch,reportWorkflowPath:captured.report.workflowPath,environmentId:captured.environment.environmentId,
      storeTip:captured.site.storeTip,generation:captured.site.generation,configCommit:captured.context.configCommit,releaseCommit:captured.context.assets.releaseCommit,
      deploymentId:captured.deployment.current.deploymentId,deployment:outcome,readiness:observed,comments,deferred:captured.deferred};
    if(observed.status!=="served") {for(const target of captured.targets)comments.push({...target,status:"deferred",reason:"readiness-pending"});return proven;}
    let botId:string;
    try {
      const actual=await active.wait(()=>getRepository(active.signal),repository);sameRepository(actual,captured.context.repository);
      if(actual.defaultBranch!==captured.defaultBranch)refuse("projection-operation-failed");
      botId=await active.wait(()=>getPublishingBot(active.signal),value=>{const id=value.botId;if(!isGitHubId(id))refuse("projection-operation-failed");return id;});
    } catch {for(const target of captured.targets)comments.push({...target,status:"failed",reason:"comment-operation-failed"});return proven;}
    for(const target of captured.targets) {
      const run=records.get(target.runKey);if(run===undefined)refuse("projection-state-invalid");
      const result=renderComment({context:captured.context,run,generation:captured.site.generation});
      if(result.status==="disabled"){comments.push({...target,status:"disabled"});continue;}
      let deferredReason:ProjectionDeferredReason|"readiness-pending"="comment-order-unproved";
      const guard=async(existing:BotComment|null):Promise<boolean>=>{
        try {
          active.check();
          deferredReason="readiness-pending";
          const fresh=await waitForReadiness({context:captured.context,site:captured.site,targets:[{...target}],signal:active.signal},readinessPorts);
          if(fresh.status!=="served"){deferredReason="readiness-pending";return false;}
          // Head/order are checked after the spaced served-byte proof, immediately before the write.
          deferredReason="pr-unavailable";active.check();const pr=await active.wait(()=>getPullRequest(target.prNumber,active.signal),value=>pullRequest(value,target.prNumber));
          if(pr.state==="closed"){deferredReason="pr-closed";return false;}
          if(pr.headSha!==target.headSha){deferredReason="head-changed";return false;}
          if(existing!==null) {
            const stamp=readCommentStamp(existing.body,captured.context.repository.repositoryId),previous=stamp===undefined?undefined:records.get(stamp.runKey);
            if(stamp===undefined||previous===undefined||previous.source.event!=="pull_request"||previous.source.association.status!=="corroborated"
              ||previous.source.association.prNumber!==target.prNumber||previous.source.commits.head!==stamp.headSha
              ||compareRunOrder({runKey:previous.runKey,sourceCreatedAt:previous.source.createdAt},{runKey:run.runKey,sourceCreatedAt:run.source.createdAt})>0) {
              deferredReason="comment-order-unproved";return false;
            }
          }
          active.check();return true;
        } catch {if(!isSignalAborted(active.signal))deferredReason="pr-unavailable";return false;}
      };
      const invoke=(body:string)=>{
        let genuine=false,everAuthorized=false;
        const invocation=Object.freeze({prNumber:target.prNumber,botId,body,signal:active.signal,beforeMutation:async(existing:BotComment|null)=>{
          const permitted=await guard(existing);if(permitted)everAuthorized=true;return permitted;
        }});
        const pending=active.wait(()=>reconcile(invocation),value=>{
          const reply=commentReply(value);for(const warning of reply.warnings??[])active.warning(warning);return reply;
        },undefined,active.signal,error=>sanitizeForgeError(error,"request-failed"),undefined,operation=>{
          genuine=isOwnedCommentOperation(operation,captured.context.repository.repositoryId,invocation);return genuine;
        });
        return {pending,owned:()=>genuine,neverAuthorized:()=>!everAuthorized};
      };
      let current:ReturnType<typeof invoke>|undefined;
      try {
        active.check();let reply:CommentResult;
        current=invoke(result.body);
        try {reply=await current.pending;}
        catch(error) {
          if(!current.owned()||sanitizeForgeError(error,"request-failed").code!=="comment-body-rejected")throw error;
          active.check();current=invoke(result.fallbackBody);reply=await current.pending;
        }
        if(reply.status==="deferred")comments.push({...target,status:"deferred",reason:deferredReason});
        else if(reply.status==="unchanged"&&!(await guard(null)))comments.push({...target,status:"deferred",reason:deferredReason});
        else comments.push({...target,status:reply.status,commentId:reply.commentId});
      } catch {
        // A genuine invocation that has never received permission cannot have sent a
        // mutation. Retry guards cannot erase an earlier permission or unknown write.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The real adapter awaits guard, which changes this private reason before rejecting.
        if(current?.owned()===true&&current.neverAuthorized()&&isSignalAborted(active.signal))comments.push({...target,status:"deferred",reason:deferredReason==="comment-order-unproved"?"readiness-pending":deferredReason});
        else comments.push({...target,status:"failed",reason:"comment-operation-failed"});
      }
    }
    return proven;
  } catch(error) {throw sanitizePublisherError(error,"projection-operation-failed");}
  finally {scope?.close();if(proven!==undefined&&scope!==undefined&&scope.warnings.length>0)(proven as {warnings?:readonly typeof scope.warnings[number][]}).warnings=[...scope.warnings];}
}
const quote=(value:string)=>`'${value.replaceAll("'","'\"'\"'")}'`;
/** Fixed diagnostics and recorded trusted workflow/ref only. */
export function renderProjectionSummary(result:ProjectionResult):string {
  try {
    const defaultBranch=branch(result.defaultBranch),workflow=result.reportWorkflowPath;
    if(typeof workflow!=="string"||!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(workflow)
      ||!isGitHubId(result.environmentId)||!isGitHubId(result.deploymentId)||!/^[0-9a-f]{64}$/.test(result.generation)
      ||!["success","failure","cancelled","unknown","not-attempted"].includes(result.deployment)
      ||!["served","pending"].includes(result.readiness.status)||result.comments.length>1000||result.deferred.length>1000)refuse("projection-input-invalid");
    const tip=checkedOid(result.storeTip),config=checkedOid(result.configCommit),release=checkedOid(result.releaseCommit);warnings(result.warnings);
    const lines=["PixelWatch projection",`Store: ${tip}`,`Generation: ${result.generation}`,`Config: ${config}`,`Release: ${release}`,
      `Environment: ${result.environmentId}`,`Deployment: ${result.deploymentId} (${result.deployment})`,
      result.readiness.status==="served"?"Readiness: served as observed from the runner":"Readiness: stored; deployment pending; comment pending"];
    for(const item of result.comments) {
      if(!isGitHubId(item.prNumber)||!["unchanged","created","updated","recovered","deferred","failed","disabled"].includes(item.status))refuse("projection-input-invalid");
      lines.push(`PR ${item.prNumber}: ${item.status}`);
    }
    lines.push("Run repair:","~~~sh",`gh workflow run ${quote(workflow.slice(".github/workflows/".length))} --ref ${quote(defaultBranch)}`,"~~~");
    return lines.join("\n");
  } catch(error) {throw sanitizePublisherError(error,"projection-input-invalid");}
}

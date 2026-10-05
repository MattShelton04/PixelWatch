import {isGitHubId,parseJson,type JsonObject,type JsonValue} from "../../../packages/schemas/src/index.ts";
import {copyBytes} from "../../../packages/publisher/src/assembly-input.ts";

export interface ActionInvocation {
  readonly stage: "ingest" | "maintenance" | "prepare" | "finish";
  readonly repository: {readonly owner:string;readonly name:string;readonly repositoryId:string};
  readonly workflowRepository: "MattShelton04/PixelWatch";
  readonly workflowSha: string;
  readonly runId:string;
  readonly attempt:number;
  readonly report:{readonly runId:string;readonly attempt:number;readonly workflowPath:string;readonly headSha:string;readonly ref:string;readonly runnerName:string};
  readonly event:Uint8Array;
}
function fail():never {throw new Error("pixelwatch-action: invocation-invalid");}
function controls(value:string,space=false):boolean {for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<(space?33:32)||code===127)return true;}return false;}
function record(value:JsonValue|undefined):JsonObject {
  if(value===null||typeof value!=="object"||Array.isArray(value))fail();return value;
}
function branch(value:string):boolean {
  return value.length<=1024&&value.startsWith("refs/heads/")&&value.length>11&&value.isWellFormed()
    &&!controls(value,true)&&!/[~^:?*[\\]/.test(value)&&!value.includes("..")&&!value.includes("@{")&&!value.includes("//")
    &&!value.endsWith(".")&&!value.endsWith("/")&&value.slice(11).split("/").every(part=>!part.startsWith(".")&&!part.endsWith(".lock"));
}
/** Read only trusted runner identity keys. Credentials never enter this capture. */
export function readInvocation(environment:Readonly<Record<string,string|undefined>>,event:Uint8Array,checkoutHead:string):ActionInvocation {
  try {
    const stage=environment["INPUT_STAGE"],eventName=environment["GITHUB_EVENT_NAME"],fullName=environment["GITHUB_REPOSITORY"],repositoryId=environment["GITHUB_REPOSITORY_ID"];
    const runId=environment["GITHUB_RUN_ID"],attemptText=environment["GITHUB_RUN_ATTEMPT"],headSha=environment["GITHUB_SHA"],ref=environment["GITHUB_REF"],runnerName=environment["RUNNER_NAME"];
    const workflowRef=environment["GITHUB_WORKFLOW_REF"],workflowRepository=environment["PIXELWATCH_WORKFLOW_REPOSITORY"],workflowSha=environment["PIXELWATCH_WORKFLOW_SHA"];
    if(stage!=="ingest"&&stage!=="maintenance"&&stage!=="prepare"&&stage!=="finish")fail();
    if((stage==="ingest"&&eventName!=="workflow_run")||(stage==="maintenance"&&eventName!=="workflow_dispatch")
      ||(eventName!=="workflow_run"&&eventName!=="workflow_dispatch"))fail();
    if(typeof fullName!=="string"||fullName.length>140||typeof repositoryId!=="string"||!isGitHubId(repositoryId))fail();
    const pieces=fullName.split("/"),owner=pieces[0],name=pieces[1];
    if(pieces.length!==2||owner===undefined||name===undefined||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
      ||!/^[A-Za-z0-9_.-]{1,100}$/.test(name)||name==="."||name==="..")fail();
    if(workflowRepository!=="MattShelton04/PixelWatch"||typeof workflowSha!=="string"||!/^[0-9a-f]{40}$/.test(workflowSha)||checkoutHead!==workflowSha)fail();
    if(typeof runId!=="string"||!isGitHubId(runId)||typeof attemptText!=="string"||!/^[1-9][0-9]{0,9}$/.test(attemptText))fail();
    const attempt=Number(attemptText);if(!Number.isSafeInteger(attempt)||attempt>2147483647)fail();
    if(typeof headSha!=="string"||!/^[0-9a-f]{40}$/.test(headSha)||typeof ref!=="string"||!branch(ref)
      ||typeof runnerName!=="string"||runnerName.length===0||runnerName.length>1024||!runnerName.isWellFormed()||controls(runnerName))fail();
    if(typeof workflowRef!=="string"||workflowRef.length>2048||!workflowRef.startsWith(`${fullName}/`))fail();
    const reference=workflowRef.slice(fullName.length+1),separator=reference.indexOf("@"),workflowPath=reference.slice(0,separator);
    if(separator<0||!/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.ya?ml$/.test(workflowPath)||reference.slice(separator+1)!==ref)fail();
    const bytes=copyBytes(event,1024*1024),payload=record(parseJson(bytes,{maxBytes:1024*1024,maxDepth:32})),repository=record(payload["repository"]);
    const eventId=repository["id"],eventFullName=repository["full_name"];
    if(typeof eventId!=="number"||!Number.isSafeInteger(eventId)||eventId<1||String(eventId)!==repositoryId||eventFullName!==fullName)fail();
    return Object.freeze({stage,repository:Object.freeze({owner,name,repositoryId}),workflowRepository,workflowSha,runId,attempt,
      report:Object.freeze({runId,attempt,workflowPath,headSha,ref,runnerName}),event:bytes});
  }catch{return fail();}
}

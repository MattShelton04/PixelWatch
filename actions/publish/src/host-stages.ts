import type {SourceJobResult,MaintenanceResult,ProjectionPreparation,PreparedProjection,ProjectionDeploymentObservation,ProjectionResult} from "../../../packages/publisher/src/types.ts";
import type {ActionInvocation} from "./host-input.ts";
import type {RuntimeRelease} from "./runtime-release.ts";
import {copyBytes} from "../../../packages/publisher/src/assembly-input.ts";
import {appendOutputs,stageSite,readStagedSite,readPreparedPayload,cleanupStagedSite,type StagedSite} from "./host-files.ts";
import {encodePreparedProjection,decodePreparedProjection,type CapsuleBinding} from "./prepared-capsule.ts";

/** These functions are constructed only by the trusted production entry point. */
export interface HostStagePorts {
  ingest(event:Uint8Array):Promise<SourceJobResult>;
  maintenance():Promise<MaintenanceResult>;
  prepare():Promise<ProjectionPreparation>;
  finish(prepared:PreparedProjection,observation:ProjectionDeploymentObservation):Promise<ProjectionResult>;
  renderProjectionSummary(result:ProjectionResult):string;
}
export interface HostStageInput {
  readonly invocation:ActionInvocation;
  readonly release:RuntimeRelease;
  readonly runnerTemp:string;
  readonly outputPath:string;
  readonly finish?:{readonly capsulePath:string;readonly capsuleSha256:string;readonly observation:ProjectionDeploymentObservation};
}
export interface HostStageOutcome {
  readonly stage:ActionInvocation["stage"];
  readonly exitCode:0|1;
  readonly stored:boolean;
  readonly project:boolean;
  readonly prepared:boolean;
  readonly summary:string;
  readonly warnings:readonly ("output-failed"|"private-cleanup-failed")[];
}
/** No publisher operation or credential is persisted in the private handoff. */
function binding(invocation:ActionInvocation,release:RuntimeRelease):CapsuleBinding {
  return {owner:invocation.repository.owner,name:invocation.repository.name,repositoryId:invocation.repository.repositoryId,
    ...invocation.report,workflowSha:invocation.workflowSha,sourceCommit:release.sourceCommit,release:release.version};
}
function fail():never{throw new Error("pixelwatch-action: stage-invalid");}
/** The real entry point supplies actual publisher operations; tests here exercise only dispatch/IO. */
export async function runHostStage(input:HostStageInput,ports:HostStagePorts):Promise<HostStageOutcome>{
  const stage=input.invocation.stage;
  let stored=false,project=false,prepared=false,exitCode:0|1=0,summary="PixelWatch stage failed; run repair from the trusted default-branch report workflow";
  let staged:StagedSite|undefined,mayCleanup=false;
  const warnings:Array<"output-failed"|"private-cleanup-failed">=[];
  try {
    if(!["ingest","maintenance","prepare","finish"].includes(stage))fail();
    // The invocation and runtime release have already passed the independent entry checks.
    const expected=binding(input.invocation,input.release),script=copyBytes(input.release.script,8*1024*1024);
    if(stage==="ingest") {
      const result=await ports.ingest(copyBytes(input.invocation.event,1024*1024));
      if(result.admission.status==="stored"&&result.projection==="pending"){stored=true;project=true;summary="PixelWatch: stored; deployment pending; run repair if projection does not finish";}
      else if(result.admission.status==="expired"&&result.projection==="not-retained")summary="PixelWatch: source expired under retention; projection not attempted";
      else fail();
      try{appendOutputs(input.outputPath,{stored:String(stored),project:String(project),projection:result.projection});}
      catch{warnings.push("output-failed");exitCode=1;}
    }else if(stage==="maintenance") {
      const result=await ports.maintenance();
      if(!["absent","unchanged","updated","recovered"].includes(result.status))fail();
      project=result.status!=="absent";summary=project?"PixelWatch: maintenance complete; deployment pending; run repair if projection does not finish":"PixelWatch: store absent; projection not attempted";
      try{appendOutputs(input.outputPath,{stored:"false",project:String(project),projection:project?"pending":"not-attempted"});}
      catch{warnings.push("output-failed");exitCode=1;}
    }else if(stage==="prepare") {
      const result=await ports.prepare();
      if(result.status==="absent") {
        if(result.repositoryId!==expected.repositoryId)fail();summary="PixelWatch: store absent; no Pages upload prepared";
        try{appendOutputs(input.outputPath,{prepared:"false"});}catch{warnings.push("output-failed");exitCode=1;}
      }else {
        const value=result.projection,payload=await encodePreparedProjection(value,expected);
        // Rebuilt data supplies both the configured prefix and privately owned exact file bytes.
        const owned=await decodePreparedProjection(payload,expected,script,value.site.files);
        staged=stageSite(input.runnerTemp,owned.site.urls.prefix,owned.site.files,payload);prepared=true;
        summary="PixelWatch: exact generation prepared; deployment pending";
        try{appendOutputs(input.outputPath,{prepared:"true",upload_root:staged.uploadRoot,capsule:staged.capsulePath,capsule_sha256:staged.capsuleSha256});}
        catch{warnings.push("output-failed");exitCode=1;mayCleanup=true;}
      }
    }else {
      const finish=input.finish;if(finish===undefined)fail();
      const capsulePath=finish.capsulePath,capsuleSha256=finish.capsuleSha256,observation={outcome:finish.observation.outcome};
      if(!["success","failure","cancelled","unknown","not-attempted"].includes(observation.outcome))fail();
      staged=readStagedSite(capsulePath,capsuleSha256,input.runnerTemp);
      const payload=readPreparedPayload(staged,input.runnerTemp);if(payload===undefined)fail();
      const value=await decodePreparedProjection(payload,expected,script,staged.files);
      // A foreign report never gains cleanup authority over another prepare's private files.
      mayCleanup=true;prepared=true;
      const result=await ports.finish(value,observation);summary=ports.renderProjectionSummary(result);
    }
  }catch{exitCode=1;}
  finally{
    if(mayCleanup&&staged!==undefined)try{cleanupStagedSite(staged,input.runnerTemp);}catch{warnings.push("private-cleanup-failed");}
  }
  return Object.freeze({stage,exitCode,stored,project,prepared,summary,warnings:Object.freeze(warnings)});
}

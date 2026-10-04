import {createHash} from "node:crypto";
import {types} from "node:util";
import {isAbsolute,join} from "node:path";
import {copyBytes} from "../../packages/publisher/src/assembly-input.ts";
import {readBoundedFile} from "../../actions/publish/src/host-files.ts";

export interface ReportCallerRelease {readonly releaseCommit:string;readonly version:string}
// This literal is updated only with independent review of the actual reusable workflow.
export const REVIEWED_REPORT_WORKFLOW_SHA256 = "cacf24fb75cec62a16989d61763f3633a7dc16fdda202dc47799c89599d5c619";
function fail():never {throw new Error("workflow-policy: reviewed-contract-refused");}
const MAX_WORKFLOW_BYTES=65536;
// eslint-disable-next-line @typescript-eslint/unbound-method -- The native getter is always called with Reflect.apply on the supplied view.
const nativeBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object,"buffer")?.get;
function ownedBytes(bytes:Uint8Array):Uint8Array {
  if(nativeBuffer===undefined||types.isProxy(bytes))fail();
  const buffer:unknown=Reflect.apply(nativeBuffer,bytes,[]);if(types.isSharedArrayBuffer(buffer))fail();
  return copyBytes(bytes,MAX_WORKFLOW_BYTES);
}
function pin(input:ReportCallerRelease):Readonly<ReportCallerRelease>{
  const supplied:unknown=input;if(typeof supplied!=="object"||supplied===null||types.isProxy(supplied))fail();
  const prototype:unknown=Object.getPrototypeOf(supplied);if(prototype!==Object.prototype&&prototype!==null)fail();
  const keys=Reflect.ownKeys(supplied);if(keys.length!==2||!keys.includes("releaseCommit")||!keys.includes("version"))fail();
  const descriptors=Object.getOwnPropertyDescriptors(supplied),commit=descriptors["releaseCommit"],version=descriptors["version"];
  if(commit===undefined||version===undefined||!("value" in commit)||!("value" in version))fail();
  const commitValue:unknown=commit.value,versionValue:unknown=version.value;
  if(typeof commitValue!=="string"||!/^[0-9a-f]{40}$/.test(commitValue)||typeof versionValue!=="string"||versionValue.length>40||!/^0\.1\.0(?:-rc\.[1-9][0-9]{0,18})?$/.test(versionValue))fail();
  return Object.freeze({releaseCommit:commitValue,version:versionValue});
}
function rendered(release:Readonly<ReportCallerRelease>,older:boolean):string{
  if(typeof older!=="boolean")fail();
  return `name: PixelWatch Report${older?" Older":""}\non:${older?"":" # zizmor: ignore[dangerous-triggers] ADR 0032: exact pinned caller; structural gate required"}\n${older?"":"  workflow_run:\n    workflows: [PixelWatch Capture]\n    types: [completed]\n"}  workflow_dispatch:\npermissions: {}\njobs:\n  report:\n    permissions:\n      actions: read\n      contents: write\n      pages: write\n      id-token: write\n      pull-requests: write\n    uses: MattShelton04/PixelWatch/.github/workflows/report.yml@${release.releaseCommit} # v${release.version}\n`;
}
/** Development policy only; it does not authorize publishing or any external mutation. */
export function renderReportCaller(release:ReportCallerRelease,older=false):string {try{return rendered(pin(release),older);}catch{return fail();}}
export function validateReportCaller(bytes:Uint8Array,release:ReportCallerRelease,older=false):Readonly<ReportCallerRelease> {
  try{const captured=pin(release),expected=new TextEncoder().encode(rendered(captured,older)),owned=ownedBytes(bytes);if(owned.byteLength!==expected.byteLength)fail();for(let index=0;index<expected.byteLength;index++)if(owned[index]!==expected[index])fail();return captured;}catch{return fail();}
}
/** The digest is supplied by the reviewed development policy, never caller context or env. */
export function verifyReviewedReportWorkflow(bytes:Uint8Array,reviewedSha256:string):void {
  try{if(typeof reviewedSha256!=="string"||!/^[0-9a-f]{64}$/.test(reviewedSha256)||createHash("sha256").update(ownedBytes(bytes)).digest("hex")!==reviewedSha256)fail();}catch{fail();}
}
/** Development consumer: the digest comes only from the reviewed literal above. */
export function verifyReportWorkflowTree(sourceRoot:string):void {
  try{if(typeof sourceRoot!=="string"||sourceRoot.length>4096||!isAbsolute(sourceRoot)||sourceRoot.includes("\0"))fail();
    verifyReviewedReportWorkflow(readBoundedFile(join(sourceRoot,".github","workflows","report.yml"),MAX_WORKFLOW_BYTES),REVIEWED_REPORT_WORKFLOW_SHA256);
  }catch{fail();}
}

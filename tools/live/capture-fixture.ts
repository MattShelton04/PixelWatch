/** Local setup/capture data tooling. It does not run a publisher or authorize live operations. */
import {types} from "node:util";
import {canonicalBytes,isGitHubId,parseJson} from "../../packages/schemas/src/index.ts";
import {encodePng} from "../../packages/core/src/png/encode.ts";
import {renderReportCaller,validateReportCaller} from "../release/workflow-policy.ts";
export interface CaptureRunIdentity {
  readonly runId:string;readonly attempt:string;readonly jobKey:string;
  readonly eventName:"pull_request"|"push"|"workflow_dispatch";
  readonly actor:{readonly login:string;readonly id:string};
  readonly repository:{readonly fullName:string;readonly id:string};
  readonly headSha:string;readonly baselineSha:string|null;readonly harnessSha:string;
  readonly pullRequest:null|{readonly number:string;readonly headRepository:{readonly fullName:string;readonly id:string};readonly baseRepositoryId:string;readonly eventBaseSha:string;readonly eventBaseRef:"main"};
}
export interface CaptureFixtureFile {readonly path:string;readonly bytes:Uint8Array}
export interface CapturePart {readonly artifactName:string;readonly files:readonly CaptureFixtureFile[];readonly receipt:Uint8Array}
export interface CaptureRc {readonly version:string;readonly sourceCommit:string;readonly releaseCommit:string}
export interface CaptureSetupInput {readonly sourceWorkflowId:string;readonly current:CaptureRc;readonly older:CaptureRc}
export const captureCaseIds=Object.freeze(["first-run","pr-same-repo","pr-fork","pr-fork-hostile","full-rerun","partial-rerun","stale-head","stored-deploy-fail-repair","queued-older-pin-after-newer"] as const);
export type CaptureCaseId=typeof captureCaseIds[number];

interface RawPart {artifactName:string;files:{path:string;bytes:Uint8Array}[];receipt:Uint8Array}
// This self-contained function is emitted as erasable JS for the source-side Node24 harness.
// Its only inputs are explicit runner data, fixed fixture state and precomputed synthetic PNGs.
// No receipt or bundle claim is authenticated source authority (01 §4.3; ADR0007).
function produce(identity:unknown,revision:unknown,shard:unknown,stateText:string,images:readonly string[],controlText?:string):RawPart {
  function invalid():never{throw new Error("live-capture: fixture-invalid");}
  function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
    if(typeof value!=="object"||value===null||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)invalid();
    const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.keys(descriptors).length!==keys.length)invalid();
    const captured:Record<string,unknown>={};for(const key of keys){const descriptor=descriptors[key];if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))invalid();captured[key]=descriptor.value;}return captured;
  }
  function string(value:unknown,pattern:RegExp):string {if(typeof value!=="string"||!pattern.test(value))invalid();return value;}
  function id(value:unknown):string{return string(value,/^[1-9][0-9]{0,18}$/);}
  function oid(value:unknown):string{return string(value,/^[0-9a-f]{40}$/);}
  function login(value:unknown):string{return string(value,/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);}
  function canonical(value:unknown):string {
    if(value===null||typeof value!=="object")return JSON.stringify(value);
    if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
    const record=value as Record<string,unknown>;return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  function repository(value:unknown,allowFork:boolean):{fullName:string;id:string;owner:string}{
    const input=exact(value,["fullName","id"]),fullName=string(input["fullName"],/^[A-Za-z0-9-]+\/pixelwatch-m2-live(?:-fork)?$/),[owner,name]=fullName.split("/");
    login(owner);if(name!=="pixelwatch-m2-live"&&(!allowFork||name!=="pixelwatch-m2-live-fork"))invalid();return {fullName,id:id(input["id"]),owner:owner as string};
  }
  const input=exact(identity,["runId","attempt","jobKey","eventName","actor","repository","headSha","baselineSha","harnessSha","pullRequest"]);
  const runId=id(input["runId"]),attempt=id(input["attempt"]),jobKey=string(input["jobKey"],/^capture$/),eventName=string(input["eventName"],/^(?:pull_request|push|workflow_dispatch)$/);
  const actor=exact(input["actor"],["login","id"]),actorValue={login:login(actor["login"]),id:id(actor["id"])},repo=repository(input["repository"],false);
  const headSha=oid(input["headSha"]),harnessSha=oid(input["harnessSha"]),baselineSha=input["baselineSha"]===null?null:oid(input["baselineSha"]);
  if(harnessSha!==headSha||eventName==="workflow_dispatch"&&baselineSha!==null)invalid();
  let pullRequest:CaptureRunIdentity["pullRequest"]=null;
  if(eventName==="pull_request"){
    if(baselineSha===null)invalid();const pr=exact(input["pullRequest"],["number","headRepository","baseRepositoryId","eventBaseSha","eventBaseRef"]),headRepo=repository(pr["headRepository"],true),baseRepositoryId=id(pr["baseRepositoryId"]);
    if(baseRepositoryId!==repo.id||headRepo.owner!==repo.owner||(headRepo.fullName===repo.fullName)!==(headRepo.id===repo.id)||pr["eventBaseRef"]!=="main")invalid();
    pullRequest={number:id(pr["number"]),headRepository:{fullName:headRepo.fullName,id:headRepo.id},baseRepositoryId,eventBaseSha:oid(pr["eventBaseSha"]),eventBaseRef:"main"};
  }else if(input["pullRequest"]!==null)invalid();
  if(revision!=="head"&&revision!=="base"||shard!==1&&shard!==2||revision==="base"&&baselineSha===null)invalid();
  function fixture(text:string):{value:number;failure:"none"|"shard-2-attempt-1";payload:"valid"|"forged-claims"|"unknown-version"}{
    if(Buffer.byteLength(text)>512)invalid();let parsed:unknown;try{parsed=JSON.parse(text);}catch{invalid();}
    const state=exact(parsed,["schemaVersion","value","failure","payload"]),value=state["value"],failure=state["failure"],payload=state["payload"];
    if(state["schemaVersion"]!==1||typeof value!=="number"||!Number.isInteger(value)||value<0||value>3||failure!=="none"&&failure!=="shard-2-attempt-1"||payload!=="valid"&&payload!=="forged-claims"&&payload!=="unknown-version"||canonical(state)!==text)invalid();return {value,failure,payload};
  }
  const target=fixture(stateText),control=controlText===undefined?target:fixture(controlText),value=target.value,failure=control.failure,payload=control.payload;
  if(failure==="shard-2-attempt-1"&&shard===2&&attempt==="1")throw new Error("live-capture: selected-fixture-failure");
  const capturedIdentity={runId,attempt,jobKey,eventName,actor:actorValue,repository:{fullName:repo.fullName,id:repo.id},headSha,baselineSha,harnessSha,pullRequest};
  const viewId=`shard-${String(shard)}`,artifactName=`pixelwatch-b1-a${attempt}-${revision}-app-s${String(shard)}-of2`,png=images[value*2+shard-1];if(png===undefined)invalid();
  const claims:Record<string,unknown>={revisionSha:revision==="base"?baselineSha:headSha,harnessSha,environment:{viewport:{width:16,height:16},deviceScaleFactor:1,colorScheme:"light",locale:"en-US",timezone:"UTC"}};
  if(payload!=="valid")Object.assign(claims,{runId:"999",attempt:"999",repositoryId:"999",actorId:"999",pullRequestNumber:"999"});
  // Distinct parts reach distinct boundaries: shard1 has valid ZIP names and an unknown
  // bundle version; shard2 has a known version and active files/malformed pixels.
  const bundle={schemaVersion:payload==="unknown-version"&&shard===1?2:1,revision,providerId:"app",attempt,shard:{index:shard,count:2},producer:{name:"pixelwatch-m2-fixture",version:"1"},claims,units:[{viewId,variantId:"desktop",state:"captured",labels:{title:`Fixture shard ${String(shard)}`,route:`/fixture/${viewId}`}}]};
  const files=[{path:"bundle.json",bytes:Buffer.from(canonical(bundle))},{path:`${viewId}.desktop.png`,bytes:payload==="unknown-version"?Buffer.from("invalid-fixture-png"):Buffer.from(png,"base64")}];
  if(payload==="unknown-version"&&shard===2)files.push({path:"index.html",bytes:Buffer.from("<script>throw new Error('capture fixture active file')</script>")},{path:".pixelwatch.json",bytes:Buffer.from('{"repositoryId":"999","schemaVersion":1}')});
  const receipt=Buffer.from(canonical({schemaVersion:1,identity:capturedIdentity,revision,shard,artifactName}));if(receipt.byteLength>16*1024)invalid();return {artifactName,files,receipt};
}

function fail():never {throw new Error("live-capture: fixture-invalid");}
function ownedFiles(files:readonly CaptureFixtureFile[]):readonly CaptureFixtureFile[]{
  return Object.freeze(files.map(file=>{const bytes=new Uint8Array(file.bytes);return Object.freeze({path:file.path,get bytes(){return new Uint8Array(bytes);}});}));
}
const NativeBytes=Uint8Array,typedPrototype=Object.getPrototypeOf(NativeBytes.prototype) as object;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Captured native getters and set are bound with Reflect.apply.
const nativeLength=Object.getOwnPropertyDescriptor(typedPrototype,"byteLength")?.get,nativeTag=Object.getOwnPropertyDescriptor(typedPrototype,Symbol.toStringTag)?.get,nativeSet=NativeBytes.prototype.set;
function stateText(bytes:Uint8Array):string {
  try{
    if(types.isProxy(bytes)||nativeLength===undefined||nativeTag===undefined)fail();const tag:unknown=Reflect.apply(nativeTag,bytes,[]),length:unknown=Reflect.apply(nativeLength,bytes,[]);
    if(tag!=="Uint8Array"||typeof length!=="number"||length>512)fail();const copy=new NativeBytes(length);Reflect.apply(nativeSet,copy,[bytes]);return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(copy);
  }catch{return fail();}
}
// Synthetic fixture pixels, generated by the existing canonical encoder at source tooling time.
// Four fixed values × two disjoint routes; no timestamps, PR/run IDs or credential data in pixels.
const images=Object.freeze(Array.from({length:8},(_,index)=>{
  const value=Math.floor(index/2),shard=index%2+1,data=Uint8Array.from({length:16*16*3},(_,offset)=>(value*61+shard*29+offset%3*17)&255);
  return Buffer.from(encodePng({width:16,height:16,channels:3,data})).toString("base64");
}));
export function buildCapturePart(identity:CaptureRunIdentity,revision:"base"|"head",shard:1|2,stateBytes:Uint8Array):CapturePart {
  const result=produce(identity,revision,shard,stateText(stateBytes),images),files=ownedFiles(result.files),receipt=new Uint8Array(result.receipt);
  return Object.freeze({artifactName:result.artifactName,files,get receipt(){return new Uint8Array(receipt);}});
}
function setupRecord(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(typeof value!=="object"||value===null||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const descriptors=Object.getOwnPropertyDescriptors(value);if(Object.keys(descriptors).length!==keys.length)fail();const result:Record<string,unknown>={};
  for(const key of keys){const descriptor=descriptors[key];if(descriptor===undefined||!Object.hasOwn(descriptor,"value"))fail();result[key]=descriptor.value;}return result;
}
function rc(value:unknown):CaptureRc {
  const input=setupRecord(value,["version","sourceCommit","releaseCommit"]),version=input["version"],sourceCommit=input["sourceCommit"],releaseCommit=input["releaseCommit"];
  if(typeof version!=="string"||typeof sourceCommit!=="string"||typeof releaseCommit!=="string"||!/^0\.1\.0-rc\.[1-9][0-9]{0,18}$/.test(version)||!/^[a-f0-9]{40}$/.test(sourceCommit)||!/^[a-f0-9]{40}$/.test(releaseCommit)||sourceCommit===releaseCommit)fail();
  return {version,sourceCommit,releaseCommit};
}
function standalone():string {
  return `// Standalone untrusted source-side fixture. Receipts are local claims, never uploaded authority.\nimport {closeSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,writeFileSync} from "node:fs";\nimport {pathToFileURL} from "node:url";\nconst images=${JSON.stringify(images)};\nconst produce=${produce.toString()};\n`+String.raw`
function canonical(value){
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}";
}
function readBounded(file,limit){
  const pathStat=lstatSync(file);if(!pathStat.isFile()||pathStat.isSymbolicLink()||pathStat.size>limit)throw new Error("live-capture: fixture-invalid");
  const fd=openSync(file,"r");try{
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit||stat.dev!==pathStat.dev||stat.ino!==pathStat.ino)throw new Error("live-capture: fixture-invalid");
    const bytes=Buffer.alloc(limit+1);let offset=0;while(offset<bytes.byteLength){const count=readSync(fd,bytes,offset,bytes.byteLength-offset,offset);if(count===0)break;offset+=count;}
    if(offset>limit)throw new Error("live-capture: fixture-invalid");return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,offset));
  }finally{closeSync(fd);}
}
export function capture(identity,revision,shard,stateText,controlText){return produce(identity,revision,shard,stateText,images,controlText);}
if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  try{
    if(process.argv.length!==4&&process.argv.length!==5)throw new Error("live-capture: fixture-invalid");
    const inputText=readBounded(process.argv[2],16*1024),input=JSON.parse(inputText);
    if(input===null||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="identity,revision,shard"||canonical(input)!==inputText)throw new Error("live-capture: fixture-invalid");
    const result=capture(input.identity,input.revision,input.shard,readBounded(process.argv[3],512),process.argv.length===5?readBounded(process.argv[4],512):undefined);
    mkdirSync("pixelwatch-bundle");for(const file of result.files)writeFileSync("pixelwatch-bundle/"+file.path,file.bytes,{flag:"wx"});
    writeFileSync(".pixelwatch-capture-receipt.json",result.receipt,{flag:"wx",mode:0o600});
    console.log("live-capture: produced "+result.artifactName);
  }catch(error){
    console.error(error instanceof Error&&error.message==="live-capture: selected-fixture-failure"?error.message:"live-capture: fixture-invalid");process.exitCode=1;
  }
}
`;
}
const captureWorkflow=[
  "name: PixelWatch Capture",
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "  workflow_dispatch:",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  refs:",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 5",
  "    outputs:",
  "      head: ${{ steps.select.outputs.head }}",
  "      base: ${{ steps.select.outputs.base }}",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "      - id: select",
  "        env:",
  "          EVENT: ${{ github.event_name }}",
  "          PR_HEAD: ${{ github.event.pull_request.head.sha }}",
  "          PR_BASE: ${{ github.event.pull_request.base.sha }}",
  "          PUSHED: ${{ github.sha }}",
  "        run: |",
  "          set -euo pipefail",
  "          base=\"\"",
  "          if [ \"${EVENT}\" = \"pull_request\" ]; then",
  "            head=\"${PR_HEAD}\"",
  "            base=\"$(git merge-base \"${PR_BASE}\" \"${PR_HEAD}\")\"",
  "          elif [ \"${EVENT}\" = \"push\" ]; then",
  "            head=\"${PUSHED}\"",
  "            base=\"$(git rev-parse --verify --quiet \"${PUSHED}^1\" || true)\"",
  "          elif [ \"${EVENT}\" = \"workflow_dispatch\" ]; then",
  "            head=\"${PUSHED}\"",
  "            base=\"\"",
  "          else",
  "            exit 2",
  "          fi",
  "          echo \"head=${head}\" >> \"${GITHUB_OUTPUT}\"",
  "          echo \"base=${base}\" >> \"${GITHUB_OUTPUT}\"",
  "  capture:",
  "    needs: refs",
  "    name: ${{ matrix.revision }} app s${{ matrix.shard }}",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 5",
  "    strategy:",
  "      fail-fast: false",
  "      matrix:",
  "        revision: [base, head]",
  "        shard: [1, 2]",
  "    steps:",
  "      - name: Check out the same head harness",
  "        if: matrix.revision == 'head' || needs.refs.outputs.base != ''",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          path: .harness",
  "          ref: ${{ needs.refs.outputs.head }}",
  "          repository: ${{ github.event.pull_request.head.repo.full_name || github.repository }}",
  "          persist-credentials: false",
  "      - name: Check out the selected application revision",
  "        if: matrix.revision == 'head' || needs.refs.outputs.base != ''",
  "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          path: .target",
  "          ref: ${{ matrix.revision == 'base' && needs.refs.outputs.base || needs.refs.outputs.head }}",
  "          repository: ${{ matrix.revision == 'base' && github.repository || github.event.pull_request.head.repo.full_name || github.repository }}",
  "          persist-credentials: false",
  "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  "        if: matrix.revision == 'head' || needs.refs.outputs.base != ''",
  "        with:",
  "          node-version: '24'",
  "      - name: Capture synthetic fixture pixels",
  "        if: matrix.revision == 'head' || needs.refs.outputs.base != ''",
  "        env:",
  "          RUN_ID: ${{ github.run_id }}",
  "          ATTEMPT: ${{ github.run_attempt }}",
  "          JOB_KEY: ${{ github.job }}",
  "          EVENT: ${{ github.event_name }}",
  "          ACTOR_ID: ${{ github.actor_id }}",
  "          ACTOR: ${{ github.actor }}",
  "          REPOSITORY_ID: ${{ github.repository_id }}",
  "          REPOSITORY: ${{ github.repository }}",
  "          HEAD_SHA: ${{ needs.refs.outputs.head }}",
  "          BASELINE_SHA: ${{ needs.refs.outputs.base }}",
  "          PR_NUMBER: ${{ github.event.pull_request.number }}",
  "          PR_HEAD_REPOSITORY_ID: ${{ github.event.pull_request.head.repo.id }}",
  "          PR_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}",
  "          PR_BASE_REPOSITORY_ID: ${{ github.event.pull_request.base.repo.id }}",
  "          PR_EVENT_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
  "          PR_EVENT_BASE_REF: ${{ github.event.pull_request.base.ref }}",
  "          REVISION: ${{ matrix.revision }}",
  "          SHARD: ${{ matrix.shard }}",
  "        run: |",
  "          set -euo pipefail",
  "          node --input-type=module <<'NODE'",
  "          import {writeFileSync} from \"node:fs\";",
  "          function canonical(value){if(value===null||typeof value!==\"object\")return JSON.stringify(value);if(Array.isArray(value))return \"[\"+value.map(canonical).join(\",\")+\"]\";return \"{\"+Object.keys(value).sort().map(key=>JSON.stringify(key)+\":\"+canonical(value[key])).join(\",\")+\"}\";}",
  "          const e=process.env;",
  "          const identity={runId:e.RUN_ID,attempt:e.ATTEMPT,jobKey:e.JOB_KEY,eventName:e.EVENT,actor:{login:e.ACTOR,id:e.ACTOR_ID},repository:{fullName:e.REPOSITORY,id:e.REPOSITORY_ID},headSha:e.HEAD_SHA,baselineSha:e.BASELINE_SHA||null,harnessSha:e.HEAD_SHA,pullRequest:e.EVENT===\"pull_request\"?{number:e.PR_NUMBER,headRepository:{fullName:e.PR_HEAD_REPOSITORY,id:e.PR_HEAD_REPOSITORY_ID},baseRepositoryId:e.PR_BASE_REPOSITORY_ID,eventBaseSha:e.PR_EVENT_BASE_SHA,eventBaseRef:e.PR_EVENT_BASE_REF}:null};",
  "          writeFileSync(\".pixelwatch-capture-identity.json\",canonical({identity,revision:e.REVISION,shard:Number(e.SHARD)}),{flag:\"wx\",mode:0o600});",
  "          NODE",
  "          node .harness/.pixelwatch/capture.mjs .pixelwatch-capture-identity.json .target/.pixelwatch/fixture.json .harness/.pixelwatch/fixture.json",
  "      - name: Upload only the capture part",
  "        if: success() && (matrix.revision == 'head' || needs.refs.outputs.base != '')",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: pixelwatch-b1-a${{ github.run_attempt }}-${{ matrix.revision }}-app-s${{ matrix.shard }}-of2",
  "          path: pixelwatch-bundle/",
  "          if-no-files-found: error",
  "          include-hidden-files: true",
  ""
].join("\n");
function caller(release:CaptureRc,older:boolean):string {
  try{const pin={releaseCommit:release.releaseCommit,version:release.version},rendered=renderReportCaller(pin,older);validateReportCaller(new TextEncoder().encode(rendered),pin,older);return rendered;}catch{return fail();}
}
/** Numeric allowlist and exact RCs must be observed/approved before these bytes are installed. */
export function buildCaptureSetup(input:CaptureSetupInput):readonly CaptureFixtureFile[] {
  const captured=setupRecord(input,["sourceWorkflowId","current","older"]),sourceWorkflowId=captured["sourceWorkflowId"];if(typeof sourceWorkflowId!=="string"||!isGitHubId(sourceWorkflowId))fail();
  const current=rc(captured["current"]),older=rc(captured["older"]);if(current.releaseCommit===older.releaseCommit||BigInt(current.version.slice(9))<=BigInt(older.version.slice(9)))fail();
  const config={schemaVersion:1,source:{workflowIds:[sourceWorkflowId],events:["pull_request","push","workflow_dispatch"]},providers:[{id:"app",shards:2}],store:{branch:"pixelwatch-data",prefix:"pixelwatch"},comparator:{version:1}};
  const encode=(value:string)=>new TextEncoder().encode(value);
  return ownedFiles([{path:".github/workflows/pixelwatch-capture.yml",bytes:encode(captureWorkflow)},{path:".github/workflows/pixelwatch-report-older.yml",bytes:encode(caller(older,true))},{path:".github/workflows/pixelwatch-report.yml",bytes:encode(caller(current,false))},{path:".pixelwatch/capture.mjs",bytes:encode(standalone())},{path:".pixelwatch/config.json",bytes:canonicalBytes(config)},{path:".pixelwatch/fixture.json",bytes:buildCaptureStimulus("first-run")[0]?.bytes??fail()}]);
}
/** Fixed data edits for real future driver stimuli; no field implies a live case passed. */
export function buildCaptureStimulus(caseId:CaptureCaseId,phase:"initial"|"new-head"="initial"):readonly CaptureFixtureFile[] {
  if(!captureCaseIds.includes(caseId)||!["initial","new-head"].includes(phase)||phase==="new-head"&&caseId!=="stale-head")fail();
  let value=caseId==="first-run"?0:caseId==="pr-fork"?2:caseId==="pr-fork-hostile"||caseId==="stored-deploy-fail-repair"?3:1;
  if(phase==="new-head")value=2;
  const bytes=canonicalBytes({schemaVersion:1,value,failure:caseId==="partial-rerun"?"shard-2-attempt-1":"none",payload:caseId==="pr-fork-hostile"?"unknown-version":"valid"});
  // Keep strict parser coverage as part of tooling too, rather than handing arbitrary JSON to CI.
  parseJson(bytes,{maxBytes:512,maxDepth:4});return ownedFiles([{path:".pixelwatch/fixture.json",bytes}]);
}

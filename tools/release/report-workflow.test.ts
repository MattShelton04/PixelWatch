// Static policy and local guard evidence. Actual released self-reference remains a live gate.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {describe,it} from "vitest";
import {assertNoSecrets,CANARY_TOKEN} from "../simulation/capture.ts";
import {runZizmor} from "../lint-workflows.ts";

const path=new URL("../../.github/workflows/report.yml",import.meta.url);
function workflow():string{return readFileSync(path,"utf8");}
function job(name:"ingest"|"project"):string {
  const text=workflow(),start=text.indexOf(`\n  ${name}:\n`);assert.ok(start>0);
  const end=text.indexOf("\n  project:\n",start+1);return text.slice(start,end<0?undefined:end);
}
function permissions(text:string):string[]{const match=/^ {4}permissions:\n((?: {6}[^\n]+\n)+)/m.exec(text);assert.ok(match?.[1]);return match[1].trim().split("\n").map(line=>line.trim()).sort();}
function guard(text:string):string {const match=/ {10}# BEGIN PIXELWATCH OWN JOB GUARD\n {10}node --input-type=module <<'PIXELWATCH_SELF'\n([\s\S]*?) {10}PIXELWATCH_SELF\n {10}# END PIXELWATCH OWN JOB GUARD/m.exec(text);assert.ok(match?.[1]);return match[1].split("\n").map(line=>line.replace(/^ {10}/," ").slice(1)).join("\n");}
function environment():NodeJS.ProcessEnv {const result:NodeJS.ProcessEnv={};for(const key of ["PATH","Path","SystemRoot","SYSTEMROOT","WINDIR","TMP","TEMP","TMPDIR"]){const value=process.env[key];if(value!==undefined)result[key]=value;}return result;}
describe("reusable report workflow policy and own identity guard (released/live acceptance pending)",()=>{
  it("top permissions are empty and ingest project receive exactly their normative sets",()=>{
    const text=workflow();assert.match(text,/^permissions: \{\}$/m);assert.match(text,/^ {2}workflow_call:$/m);
    assert.deepEqual(permissions(job("ingest")),["actions: read","contents: write","pull-requests: read"]);
    assert.deepEqual(permissions(job("project")),["contents: read","id-token: write","pages: write","pull-requests: write"]);
    assert.equal((text.match(/permissions:/g)??[]).length,3);assert.doesNotMatch(text,/secrets: inherit|pull_request_target/);
  });
  it("one project job owns the stable repository ID lock through fresh prepare deploy and finish",()=>{
    const text=workflow(),projection=job("project");assert.equal((text.match(/concurrency:/g)??[]).length,1);
    assert.match(projection,/group: pixelwatch-project-\$\{\{ github\.repository_id \}\}/);assert.match(projection,/cancel-in-progress: false/);
    assert.doesNotMatch(job("ingest"),/concurrency:/);assert.match(projection,/environment:\n {6}name: github-pages/);
    const prepare=projection.indexOf("stage: prepare"),upload=projection.indexOf("actions/upload-pages-artifact@"),deploy=projection.indexOf("actions/deploy-pages@"),finish=projection.indexOf("stage: finish");assert.ok(prepare>=0&&upload>prepare&&deploy>upload&&finish>deploy);
    assert.doesNotMatch(text,/^ {2}(?:comment|deploy):$/m);
  });
  it("hard ingestion refusal never starts a project and manual maintenance does not synthesize capture",()=>{
    assert.match(job("project"),/needs\.ingest\.result == 'success' && needs\.ingest\.outputs\.project == 'true'/);
    const ingest=job("ingest");assert.match(ingest,/github\.event_name == 'workflow_run'/);assert.match(ingest,/stage: ingest/);assert.match(ingest,/github\.event_name == 'workflow_dispatch'/);assert.match(ingest,/stage: maintenance/);
    assert.match(ingest,/project: \$\{\{ steps\.ingest\.outputs\.project \|\| steps\.maintenance\.outputs\.project \}\}/);
  });
  it("both jobs validate actual own job fields before fixed self checkout and verify HEAD before action",()=>{
    for(const name of ["ingest","project"] as const){const text=job(name);assert.match(text,/PIXELWATCH_JOB: \$\{\{ toJSON\(job\) \}\}/);
      assert.ok(text.indexOf("id: self")<text.indexOf("uses: actions/checkout@"));assert.match(text,/repository: \$\{\{ steps\.self\.outputs\.repository \}\}/);assert.match(text,/ref: \$\{\{ steps\.self\.outputs\.sha \}\}/);
      assert.match(text,/path: _pixelwatch/);assert.match(text,/persist-credentials: false/);assert.match(text,/HEAD[\s\S]*PIXELWATCH_WORKFLOW_SHA/);
      assert.ok(text.indexOf("id: head")<text.indexOf("uses: ./_pixelwatch/actions/publish"));assert.doesNotMatch(text,/ref: \$\{\{ github\.sha|repository: \$\{\{ github\.repository|workflow_ref/);
    }
    assert.equal(guard(job("ingest")),guard(job("project")));
  });
  it("blank short moving and foreign own identity refuse before output with fixed diagnostics",()=>{
    const source=guard(job("ingest")),root=mkdtempSync(join(tmpdir(),"pw-report-guard-"));
    try{const valid={workflow_repository:"MattShelton04/PixelWatch",workflow_sha:"a".repeat(40)};
      for(const identity of [{...valid,workflow_repository:""},{...valid,workflow_repository:"attacker/PixelWatch"},{...valid,workflow_sha:""},{...valid,workflow_sha:"a".repeat(7)},{...valid,workflow_sha:"main"},{...valid,workflow_sha:CANARY_TOKEN}]){
        const output=join(root,"must-not-exist"),result=spawnSync(process.execPath,["--import",pathToFileURL(resolve("tools/lib/no-network.ts")).href,"--input-type=module","-e",source],{env:{...environment(),PIXELWATCH_JOB:JSON.stringify(identity),GITHUB_OUTPUT:output,GH_TOKEN:CANARY_TOKEN,GITHUB_TOKEN:CANARY_TOKEN},encoding:"utf8",maxBuffer:4096,timeout:10_000,windowsHide:true});
        assert.equal(result.status,1);assert.equal(result.stdout,"");assert.equal(result.stderr,"PixelWatch: own workflow identity unavailable\n");assertNoSecrets([result.stdout,result.stderr]);assert.throws(()=>readFileSync(output));
      }
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it("valid immutable own identity emits only the fixed product repository and full SHA",()=>{
    const root=mkdtempSync(join(tmpdir(),"pw-report-guard-"));try{
      const output=join(root,"output"),result=spawnSync(process.execPath,["--import",pathToFileURL(resolve("tools/lib/no-network.ts")).href,"--input-type=module","-e",guard(job("project"))],{env:{...environment(),PIXELWATCH_JOB:JSON.stringify({workflow_repository:"MattShelton04/PixelWatch",workflow_sha:"a".repeat(40),workflow_ref:CANARY_TOKEN}),GITHUB_OUTPUT:output,GH_TOKEN:CANARY_TOKEN,GITHUB_TOKEN:CANARY_TOKEN},encoding:"utf8",maxBuffer:4096,timeout:10_000,windowsHide:true});
      assert.equal(result.status,0);assert.equal(result.stdout,"");assert.equal(result.stderr,"");assert.equal(readFileSync(output,"utf8"),`repository=MattShelton04/PixelWatch\nsha=${"a".repeat(40)}\n`);assertNoSecrets([readFileSync(output)]);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  it("official Pages upload preserves hidden generated markers and finish always observes the real step outcome",()=>{
    const projection=job("project");assert.match(projection,/actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/);assert.match(projection,/include-hidden-files: true/);assert.match(projection,/path: \$\{\{ steps\.prepare\.outputs\.upload_root \}\}/);
    assert.match(projection,/actions\/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5\.0\.1/);assert.match(projection,/always\(\) && steps\.prepare\.outputs\.prepared == 'true'/);assert.match(projection,/capsule: \$\{\{ steps\.prepare\.outputs\.capsule \}\}/);assert.match(projection,/capsule_sha256: \$\{\{ steps\.prepare\.outputs\.capsule_sha256 \}\}/);assert.match(projection,/steps\.deploy\.outcome == 'skipped' && 'not-attempted' \|\| steps\.deploy\.outcome/);
  });
  it("trusted jobs execute only pinned actions their own bundle and small fixed guards without caches installs or capture code",()=>{
    const text=workflow();for(const line of text.split("\n").filter(line=>line.includes("uses:")&&!line.includes("uses: ./_pixelwatch/actions/publish")))assert.match(line,/@[0-9a-f]{40} # v[0-9.]+$/);
    assert.doesNotMatch(text,/npm install|pnpm install|setup-node@|cache:|restore-cache|download-artifact@|harness|pull_request\.head/);
    assert.equal((text.match(/uses: actions\/checkout@/g)??[]).length,2);assert.equal((text.match(/uses: \.\/_pixelwatch\/actions\/publish/g)??[]).length,4);
  });
  it("only the four verified own action uses carry narrow annotations while insecure workflow audits still fail",()=>{
    const text=workflow(),uses=text.split("\n").filter(line=>line.includes("uses: ./_pixelwatch/actions/publish"));
    assert.equal(uses.length,4);for(const line of uses)assert.match(line,/uses: \.\/_pixelwatch\/actions\/publish # zizmor: ignore\[self-repository\] ADR 0032: own workflow SHA checkout and HEAD verified$/);
    assert.equal((text.match(/zizmor: ignore/g)??[]).length,4);assert.doesNotMatch(text,/ignore\[dangerous-triggers\]|ignore\[.*,/);
    const result=runZizmor([".github/workflows/report.yml","actions/publish/action.yml"],["--format","json"]);
    assertNoSecrets([result.stdout,result.stderr]);assert.equal(result.error,undefined);assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),[]);
    const insecure=runZizmor(["testdata/smoke/workflows/insecure.yml"],["--format","json"]);
    assertNoSecrets([insecure.stdout,insecure.stderr]);assert.equal(insecure.error,undefined);assert.notEqual(insecure.status,0);
    const findings=JSON.parse(insecure.stdout) as {ident:string}[];for(const ident of ["dangerous-triggers","artipacked","unpinned-uses","template-injection","excessive-permissions"])assert.ok(findings.some(finding=>finding.ident===ident));
  });
});

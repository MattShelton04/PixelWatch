import assert from "node:assert/strict";
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,relative,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {stripTypeScriptTypes} from "node:module";
import {createHash} from "node:crypto";
import {describe,it} from "vitest";
import {readInvocation} from "../src/host-input.ts";
import {appendOutputs,cleanupStagedSite,readBoundedFile,stageSite,verifyStagedSite,type SiteFile} from "../src/host-files.ts";
import {assertNoSecrets,CANARY_TOKEN} from "../../../tools/simulation/capture.ts";
import {derivedPath,encodePng} from "../../../packages/core/src/index.ts";
import {canonicalBytes,type Store} from "../../../packages/schemas/src/index.ts";
import {STORE_LIMITS} from "../../../packages/store/src/index.ts";
import {assembleSite} from "../../../packages/publisher/src/assemble.ts";

const oid="a".repeat(40),encoded=new TextEncoder();
function environment():Record<string,string|undefined>{return {INPUT_STAGE:"ingest",GITHUB_EVENT_NAME:"workflow_run",GITHUB_REPOSITORY:"adopter/visual-app",GITHUB_REPOSITORY_ID:"11",GITHUB_RUN_ID:"41",GITHUB_RUN_ATTEMPT:"2",GITHUB_SHA:"b".repeat(40),GITHUB_REF:"refs/heads/main",GITHUB_WORKFLOW_REF:"adopter/visual-app/.github/workflows/pixelwatch-report.yml@refs/heads/main",RUNNER_NAME:"trusted report runner",PIXELWATCH_WORKFLOW_REPOSITORY:"MattShelton04/PixelWatch",PIXELWATCH_WORKFLOW_SHA:oid};}
const event=()=>encoded.encode(JSON.stringify({repository:{id:11,full_name:"adopter/visual-app"},workflow_run:{id:30,run_attempt:1}}));
function fixture<T>(run:(root:string)=>T):T {
  const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"pixelwatch-host-spec-"));
  try{return run(root);}finally{const rel=relative(parent,realpathSync(root));assert.ok(rel.startsWith("pixelwatch-host-spec-")&&!rel.includes(sep)&&realpathSync(root)===root);rmSync(root,{recursive:true,force:false});}
}
function file(path:string,text:string):SiteFile {const bytes=encoded.encode(text);return {path,bytes,sha256:createHash("sha256").update(bytes).digest("hex")};}
function refused(run:()=>unknown):void {assert.throws(run,error=>{assert.ok(error instanceof Error);assertNoSecrets([error.stack??error.message]);return /^pixelwatch-action: [a-z-]+$/.test(error.message)&&!error.message.includes("not-implemented");});}

describe("trusted action invocation and private filesystem boundary (composition pending)",()=>{
  it("report identity uses the authenticated caller run independently of capture and reusable product identities",()=>{
    const context=readInvocation(environment(),event(),oid);
    assert.deepEqual(context.report,{runId:"41",attempt:2,workflowPath:".github/workflows/pixelwatch-report.yml",headSha:"b".repeat(40),ref:"refs/heads/main",runnerName:"trusted report runner"});
    for(const override of [{GITHUB_WORKFLOW_REF:`MattShelton04/PixelWatch/.github/workflows/report.yml@refs/heads/main`},{GITHUB_WORKFLOW_REF:"adopter/visual-app/.github/workflows/pixelwatch-report.yml@refs/tags/v1"},{GITHUB_REF:"refs/tags/v1"},{GITHUB_SHA:"main"},{RUNNER_NAME:""}])refused(()=>readInvocation({...environment(),...override},event(),oid));
  });
  it("caller repository selects adopter reads while job workflow SHA selects only product code",()=>{
    const input=event(),context=readInvocation(environment(),input,oid);input.fill(0);
    assert.deepEqual(context.repository,{owner:"adopter",name:"visual-app",repositoryId:"11"});
    assert.equal(context.workflowRepository,"MattShelton04/PixelWatch");assert.equal(context.workflowSha,oid);
    assert.equal(context.runId,"41");assert.equal(context.attempt,2);assert.deepEqual(context.event,event());
    refused(()=>readInvocation({...environment(),PIXELWATCH_WORKFLOW_REPOSITORY:"adopter/visual-app"},event(),oid));
    refused(()=>readInvocation(environment(),event(),"b".repeat(40)));
  });
  it("unknown stage event and identity refuse before credential reads",()=>{
    for(const override of [{INPUT_STAGE:"unknown"},{GITHUB_EVENT_NAME:"pull_request"},{GITHUB_REPOSITORY_ID:"12"},{PIXELWATCH_WORKFLOW_SHA:"main"},{GITHUB_RUN_ATTEMPT:"01"}]){
      let credentials=0;const values={...environment(),...override};Object.defineProperty(values,"GITHUB_TOKEN",{get(){credentials++;throw new Error(CANARY_TOKEN);}});
      refused(()=>readInvocation(values,event(),oid));assert.equal(credentials,0);
    }
  });
  it("event and result bytes are bounded before allocation or output",()=> { fixture(root=>{
    const source=join(root,"event.json"),output=join(root,"output");writeFileSync(source,event());writeFileSync(output,"");
    assert.deepEqual(readBoundedFile(source,1024),event());refused(()=>readBoundedFile(source,8));
    refused(()=>readInvocation(environment(),new Uint8Array(1024*1024+1),oid));
    appendOutputs(output,{projection:"pending",stored:"true"});assert.equal(readFileSync(output,"utf8"),"projection=pending\nstored=true\n");
    refused(()=> { appendOutputs(output,{projection:"pending\ntrusted=true"}); });assert.equal(readFileSync(output,"utf8"),"projection=pending\nstored=true\n");
  }); });
  it("staging uses the prefix once and keeps its private capsule outside the upload root",()=> { fixture(root=>{
    const staged=stageSite(root,"pixelwatch",[file("index.html","trusted entry"),file("site.json","{}")]);
    assert.equal(readFileSync(join(staged.uploadRoot,"pixelwatch","index.html"),"utf8"),"trusted entry");
    const capsuleRelative=relative(staged.uploadRoot,staged.capsulePath);assert.ok(capsuleRelative===".."||capsuleRelative.startsWith(`..${sep}`));
    assert.equal(readFileSync(staged.capsulePath,"utf8").includes(CANARY_TOKEN),false);verifyStagedSite(staged,root);
  }); });
  it("staging refuses links drive paths traversal active stored files and an extra late file",()=> { fixture(root=>{
    for(const path of ["../external","C:/external","\\\\server\\share","data/v1/evil.js","app/foreign/app.js","pixelwatch/index.html"]){refused(()=>stageSite(root,"pixelwatch",[file(path,CANARY_TOKEN)]));}
    const staged=stageSite(root,"pixelwatch",[file("index.html","trusted entry"),file("site.json","{}")]);
    writeFileSync(join(staged.uploadRoot,"late.js"),"unexpected");refused(()=> { verifyStagedSite(staged,root); });
    const externalDirectory=join(root,"outside");mkdirSync(externalDirectory);const external=join(externalDirectory,"external");writeFileSync(external,"owned outside output");const link=join(root,"event-link");
    symlinkSync(process.platform==="win32"?externalDirectory:external,link,process.platform==="win32"?"junction":"file");
    refused(()=>readBoundedFile(process.platform==="win32"?join(link,"external"):link,1024));
    assert.equal(readFileSync(external,"utf8"),"owned outside output");
  }); });
  it("file reads and outputs refuse ancestor links and multiply linked inodes",()=> { fixture(root=>{
    const actual=join(root,"actual");mkdirSync(actual);const eventPath=join(actual,"event.json");writeFileSync(eventPath,event());
    const linked=join(root,"linked");symlinkSync(actual,linked,"junction");refused(()=>readBoundedFile(join(linked,"event.json"),1024));
    const duplicate=join(actual,"duplicate.json");linkSync(eventPath,duplicate);refused(()=>readBoundedFile(eventPath,1024));refused(()=> { appendOutputs(duplicate,{stored:"true"}); });
    assert.deepEqual(readFileSync(eventPath),Buffer.from(event()));refused(()=>stageSite(linked,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]));
    assert.deepEqual(readdirSync(actual).sort(),["duplicate.json","event.json"]);
  }); });
  it("staging captures native bytes and refuses changed inventories without partial directories",()=> { fixture(root=>{
    const input=[file("index.html","entry"),file("site.json","{}")],entry=input[0];assert.ok(entry);Object.defineProperty(entry.bytes,"byteLength",{get(){throw new Error(CANARY_TOKEN);}});
    const staged=stageSite(root,"pixelwatch",input);entry.bytes.fill(0);verifyStagedSite(staged,root);
    writeFileSync(join(staged.uploadRoot,"pixelwatch","index.html"),"changed");refused(()=> { verifyStagedSite(staged,root); });
    const before=readdirSync(root).sort();for(const bad of [[file("index.html","entry"),file("index.html","entry"),file("site.json","{}")],[file("site.json","{}")],[{...file("index.html","entry"),sha256:"0".repeat(64)},file("site.json","{}")]])refused(()=>stageSite(root,"pixelwatch",bad));
    assert.deepEqual(readdirSync(root).sort(),before);
  }); });
  it("fixed outputs refuse unknown keys before getters and oversized values before append",()=> { fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");let reads=0;const values={projection:"pending"};Object.defineProperty(values,"GITHUB_TOKEN",{enumerable:true,get(){reads++;throw new Error(CANARY_TOKEN);}});
    refused(()=> { appendOutputs(output,values); });assert.equal(reads,0);refused(()=> { appendOutputs(output,{projection:"x".repeat(8193)}); });assert.equal(readFileSync(output,"utf8"),"");
  }); });
  it("terminal cleanup uses fresh runner authority and refuses a moved linked ancestor",()=> { fixture(root=>{
    const container=join(root,"container");mkdirSync(container);const staged=stageSite(container,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]);
    const moved=join(root,"moved");renameSync(container,moved);symlinkSync(moved,container,"junction");refused(()=> { cleanupStagedSite(staged,container); });
    const movedUpload=join(moved,relative(container,staged.uploadRoot));assert.equal(readFileSync(join(movedUpload,"pixelwatch","index.html"),"utf8"),"entry");
    rmSync(container);renameSync(moved,container);verifyStagedSite(staged,container);refused(()=> { cleanupStagedSite(staged,root); });cleanupStagedSite(staged,container);assert.equal(existsSync(staged.uploadRoot),false);
  }); });
  it("upload outputs cannot name the private capsule or replay a cleaned directory",()=> {fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]);
    refused(()=>{appendOutputs(output,{upload_root:staged.capsulePath});});assert.equal(readFileSync(output,"utf8"),"");
    appendOutputs(output,{upload_root:staged.uploadRoot,capsule:staged.capsulePath});cleanupStagedSite(staged,root);const prior=readFileSync(output,"utf8");refused(()=>{appendOutputs(output,{upload_root:staged.uploadRoot});});assert.equal(readFileSync(output,"utf8"),prior);
  });});
  it("issued path outputs recheck ownership after a late directory replacement",()=> {fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]);
    const moved=join(root,"moved-upload");renameSync(staged.uploadRoot,moved);symlinkSync(moved,staged.uploadRoot,"junction");refused(()=>{appendOutputs(output,{upload_root:staged.uploadRoot});});
    assert.equal(readFileSync(output,"utf8"),"");assert.equal(readFileSync(join(moved,"pixelwatch","index.html"),"utf8"),"entry");
  });});
  it("all recognized output getters are captured before final staged path validation",()=> {fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]),moved=join(root,"moved-upload");let reads=0;
    const values={upload_root:staged.uploadRoot,get stored(){reads++;renameSync(staged.uploadRoot,moved);symlinkSync(moved,staged.uploadRoot,"junction");return "true";}};
    refused(()=>{appendOutputs(output,values);});assert.equal(reads,1);assert.equal(readFileSync(output,"utf8"),"");assert.equal(readFileSync(join(moved,"pixelwatch","index.html"),"utf8"),"entry");
  });});
  it("minted inventory capsule bytes cannot change within the same inode",()=> {fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]),original=readFileSync(staged.capsulePath);
    writeFileSync(staged.capsulePath,"{}");refused(()=>{verifyStagedSite(staged,root);});refused(()=>{appendOutputs(output,{capsule:staged.capsulePath});});assert.equal(readFileSync(output,"utf8"),"");refused(()=>{cleanupStagedSite(staged,root);});assert.equal(existsSync(staged.uploadRoot),true);
    writeFileSync(staged.capsulePath,original);verifyStagedSite(staged,root);cleanupStagedSite(staged,root);assert.equal(existsSync(staged.capsulePath),false);
  });});
  it("complete actual generated inventories have their own bound above the store listing",async()=>{
    const store:Store={schemaVersion:1,marker:"pixelwatch-store",repositoryId:"11",dataVersion:1,txn:0,runs:[]},bodies=new Map<string,Uint8Array>([["store.json",canonicalBytes(store)]]);
    for(let index=0;index<STORE_LIMITS.maxFiles-1;index++){const png=encodePng({width:1,height:1,channels:3,data:Uint8Array.of(index&255,(index>>>8)&255,(index>>>16)&255)});bodies.set(derivedPath(createHash("sha256").update(png).digest("hex")),png);}
    assert.equal(bodies.size,STORE_LIMITS.maxFiles);
    const site=await assembleSite({config:{schemaVersion:1,source:{workflowIds:["9"],events:["workflow_dispatch"]},providers:[{id:"p",shards:1}]},configCommit:oid,pages:{url:"https://adopter.github.io/visual-app/",host:"adopter.github.io"},repository:{repositoryId:"11",owner:"adopter",name:"visual-app"},assets:{release:"0.1.0-rc.1",releaseCommit:"b".repeat(40),script:encoded.encode("(()=>{})();")},snapshot:{tip:"c".repeat(40),store,runs:new Map(),files:[...bodies].map(([path,bytes])=>({path,bytes:bytes.byteLength})),readFile:path=>{const bytes=bodies.get(path);assert.ok(bytes);return Promise.resolve(bytes);}}});
    assert.equal(site.files.length,100008);assert.ok(site.totalBytes<STORE_LIMITS.maxTreeBytes);
    fixture(root=>{const files=[...site.files],first=files[0];assert.ok(first);let captured=0;files[0]={...first,get bytes():Uint8Array{captured++;throw new Error(CANARY_TOKEN);}};refused(()=>stageSite(root,"pixelwatch",files));assert.equal(captured,1);assert.deepEqual(readdirSync(root),[]);});
  });
  it("private inventory counts exact canonical bytes below and above the unchanged capsule cap",async()=>{
    // This serialization seam uses actual helper code and simulated captured inode metadata.
    // It never claims that the large physical site has been staged or can authorize cleanup.
    const helperUrl=new URL("../src/host-files.ts",import.meta.url),source=readFileSync(helperUrl,"utf8");
    const transformed=source.replaceAll(/from "(\.\.\/[^"\n]+)"/g,(_match,path:string)=>`from ${JSON.stringify(new URL(path,helperUrl).href)}`)+"\nexport {inventory as inventoryForReview};\n";
    const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"pixelwatch-host-spec-"));
    try {
      const modulePath=join(root,"inventory.mjs");writeFileSync(modulePath,stripTypeScriptTypes(transformed,{mode:"strip",sourceUrl:helperUrl.href}));
      const module:unknown=await import(pathToFileURL(modulePath).href);
      assert.ok(typeof module==="object"&&module!==null&&"inventoryForReview" in module&&typeof module.inventoryForReview==="function");
      const inventory=module.inventoryForReview as (value:unknown)=>Uint8Array,maximum=64*1024*1024;
      const taskRoot=join(root,"pixelwatch-stage-abcdef"),uploadRoot=join(taskRoot,"upload"),capsulePath=join(taskRoot,"state.json"),prefix="pixelwatch";
      const identity=(path:string)=>({path,dev:"123456789",ino:"123456789012345678"});
      const files=Array.from({length:100008},(_,index)=>file(`derived/${index.toString(16).padStart(64,"0")}.png`,"x"));
      const directories=[root,dirname(root),taskRoot,uploadRoot,join(uploadRoot,prefix),join(uploadRoot,prefix,"derived")].map(identity);
      const identities=files.map(value=>identity(join(uploadRoot,prefix,value.path))),value={taskRoot,uploadRoot,capsulePath,prefix,directories,identities,files};
      const expected=canonicalBytes({schemaVersion:1,taskRoot,uploadRoot,capsulePath,prefix,directories,identities,files:files.map(value=>({path:value.path,bytes:value.bytes.byteLength,sha256:value.sha256}))});
      assert.ok(expected.byteLength<maximum);assert.deepEqual(inventory(value),expected);
      const longer={...value,identities:identities.map(item=>({...item,path:join(root,"x".repeat(300),relative(root,item.path))}))};
      const over=canonicalBytes({schemaVersion:1,taskRoot,uploadRoot,capsulePath,prefix,directories,identities:longer.identities,files:files.map(value=>({path:value.path,bytes:value.bytes.byteLength,sha256:value.sha256}))});
      assert.ok(over.byteLength>maximum);refused(()=>{inventory(longer);});
      const escaped={...value,taskRoot:taskRoot+"é😀\"\\",files:[file("index.html","x")],identities:[identity(join(uploadRoot,"é😀\"\\"))]};
      assert.deepEqual(inventory(escaped),canonicalBytes({schemaVersion:1,taskRoot:escaped.taskRoot,uploadRoot,capsulePath,prefix,directories,identities:escaped.identities,files:[{path:"index.html",bytes:1,sha256:escaped.files[0]?.sha256}]}));
    }finally{const rel=relative(parent,realpathSync(root));assert.ok(rel.startsWith("pixelwatch-host-spec-")&&!rel.includes(sep)&&realpathSync(root)===root);rmSync(root,{recursive:true,force:false});}
  });
});

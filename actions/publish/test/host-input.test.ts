import assert from "node:assert/strict";
import fs,{existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,relative,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {stripTypeScriptTypes,syncBuiltinESMExports} from "node:module";
import {createHash} from "node:crypto";
import {describe,it} from "vitest";
import {readInvocation} from "../src/host-input.ts";
import {appendOutputs,cleanupStagedSite,readBoundedFile,readPreparedPayload,readStagedSite,stageSite,verifyStagedSite,type SiteFile} from "../src/host-files.ts";
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
  it("private prepared payload captures native bytes before file getters and survives a separate restart",()=>{fixture(root=>{
    const payload=encoded.encode("{\"prepared\":1}"),expected=Uint8Array.from(payload),input=[file("index.html","entry"),file("site.json","{}")];let nativeReads=0;
    Object.defineProperty(payload,"byteLength",{get(){nativeReads++;throw new Error(CANARY_TOKEN);}});
    const first=input[0];assert.ok(first);input[0]={...first,get bytes(){payload.fill(0);return first.bytes;}};
    const staged=stageSite(root,"pixelwatch",input,payload);assert.equal(nativeReads,0);assert.deepEqual(staged.preparedPayload,{bytes:expected.byteLength,sha256:createHash("sha256").update(expected).digest("hex")});
    const privatePath=join(staged.taskRoot,"prepared.json");assert.deepEqual(readFileSync(privatePath),Buffer.from(expected));assert.equal(existsSync(join(staged.uploadRoot,"prepared.json")),false);
    const restarted=readStagedSite(staged.capsulePath,staged.capsuleSha256,root);assert.deepEqual(readPreparedPayload(restarted,root),expected);assert.deepEqual(restarted.files,staged.files);
    const read=readPreparedPayload(restarted,root);assert.ok(read);read.fill(0);assert.deepEqual(readPreparedPayload(restarted,root),expected);cleanupStagedSite(restarted,root);assert.equal(existsSync(staged.taskRoot),false);
  });});
  it("restart authenticates legacy inventory content without inventing a persisted state self inode",()=>{fixture(root=>{
    const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")]),original=readFileSync(staged.capsulePath),saved=join(root,"old-state.json");
    assert.equal(readPreparedPayload(readStagedSite(staged.capsulePath,staged.capsuleSha256,root),root),undefined);
    renameSync(staged.capsulePath,saved);writeFileSync(staged.capsulePath,original);refused(()=>{verifyStagedSite(staged,root);});
    const restarted=readStagedSite(staged.capsulePath,staged.capsuleSha256,root);verifyStagedSite(restarted,root);writeFileSync(staged.capsulePath,"{}");refused(()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,root));
    writeFileSync(staged.capsulePath,original);cleanupStagedSite(restarted,root);assert.equal(readFileSync(saved).equals(original),true);
  });});
  it("state and prepared payload share one exact private metadata allowance",async()=>{
    const helperUrl=new URL("../src/host-files.ts",import.meta.url),source=readFileSync(helperUrl,"utf8"),transformed=source.replaceAll(/from "(\.\.\/[^"\n]+)"/g,(_match,path:string)=>`from ${JSON.stringify(new URL(path,helperUrl).href)}`)+"\nexport {inventory as inventoryForReview};\n";
    const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"pixelwatch-host-spec-"));
    try{
      const modulePath=join(root,"payload-inventory.mjs");writeFileSync(modulePath,stripTypeScriptTypes(transformed,{mode:"strip",sourceUrl:helperUrl.href}));const module:unknown=await import(pathToFileURL(modulePath).href);assert.ok(typeof module==="object"&&module!==null&&"inventoryForReview" in module&&typeof module.inventoryForReview==="function");const inventory=module.inventoryForReview as (value:unknown)=>Uint8Array;
      const taskRoot=join(root,"pixelwatch-stage-abcdef"),uploadRoot=join(taskRoot,"upload"),capsulePath=join(taskRoot,"state.json"),identity=(path:string)=>({path,dev:"1",ino:"2"}),files=[file("index.html","é😀\"\\"),file("site.json","{}")],directories=[root,dirname(root),taskRoot,uploadRoot].map(identity),identities=[identity(join(taskRoot,"prepared.json")),...files.map(item=>identity(join(uploadRoot,"pixelwatch",item.path)))],base={taskRoot,uploadRoot,capsulePath,prefix:"pixelwatch",directories,identities,files};
      const manifest=files.map(item=>({path:item.path,bytes:item.bytes.byteLength,sha256:item.sha256})),descriptor={bytes:1,sha256:"a".repeat(64)},document={schemaVersion:1,...base,files:manifest,preparedPayload:descriptor};let length=canonicalBytes(document).byteLength,remaining=64*1024*1024-length;
      for(let index=0;index<3;index++){descriptor.bytes=remaining;length=canonicalBytes(document).byteLength;remaining=64*1024*1024-length;}descriptor.bytes=remaining;
      const exact=canonicalBytes(document);assert.equal(exact.byteLength+descriptor.bytes,64*1024*1024);assert.deepEqual(inventory({...base,preparedPayload:descriptor}),exact);
      refused(()=>inventory({...base,preparedPayload:{...descriptor,bytes:descriptor.bytes+1}}));refused(()=>inventory({...base,preparedPayload:{...descriptor,bytes:64*1024*1024+1}}));
    }finally{const rel=relative(parent,realpathSync(root));assert.ok(rel.startsWith("pixelwatch-host-spec-")&&!rel.includes(sep)&&realpathSync(root)===root);rmSync(root,{recursive:true,force:false});}
  });
  it("private prepared bytes and metadata cannot be rewritten within their original inodes",()=>{fixture(root=>{
    const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")],encoded.encode("{\"proof\":1}")),path=join(staged.taskRoot,"prepared.json"),original=readFileSync(path);verifyStagedSite(staged,root);
    writeFileSync(path,"{\"proof\":2}");for(const operation of [()=>{verifyStagedSite(staged,root);},()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,root),()=>readPreparedPayload(staged,root),()=>{cleanupStagedSite(staged,root);}])refused(operation);assert.equal(existsSync(staged.uploadRoot),true);
    writeFileSync(path,original);const restarted=readStagedSite(staged.capsulePath,staged.capsuleSha256,root);refused(()=>{verifyStagedSite({...restarted,preparedPayload:{bytes:original.byteLength,sha256:"0".repeat(64)}},root);});verifyStagedSite(restarted,root);cleanupStagedSite(restarted,root);
  });});
  it("restart and terminal cleanup refuse private aliases late files and moved runner ancestors",()=>{fixture(root=>{
    const anchor=join(root,"runner");mkdirSync(anchor);const staged=stageSite(anchor,"pixelwatch",[file("index.html","entry"),file("site.json","{}")],encoded.encode("{}")),path=join(staged.taskRoot,"prepared.json");readStagedSite(staged.capsulePath,staged.capsuleSha256,anchor);
    const alias=join(root,"alias");linkSync(path,alias);refused(()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,anchor));refused(()=>{cleanupStagedSite(staged,anchor);});rmSync(alias);
    const late=join(staged.taskRoot,"late.json");writeFileSync(late,"{}");refused(()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,anchor));rmSync(late);
    const moved=join(root,"moved");renameSync(anchor,moved);symlinkSync(moved,anchor,"junction");refused(()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,anchor));refused(()=>{cleanupStagedSite(staged,anchor);});assert.equal(readFileSync(join(moved,relative(anchor,path)),"utf8"),"{}");rmSync(anchor);renameSync(moved,anchor);cleanupStagedSite(staged,anchor);
  });});
  it("restart validates structural inventory metadata and fixed private names before authority",()=>{fixture(root=>{
    const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")],encoded.encode("{}")),original=readFileSync(staged.capsulePath);readStagedSite(staged.capsulePath,staged.capsuleSha256,root);
    const value=JSON.parse(original.toString("utf8")) as Record<string,unknown>,files=value["files"] as Array<Record<string,unknown>>,identities=value["identities"] as Array<Record<string,unknown>>;
    for(const invalid of [{...value,schemaVersion:2},{...value,extra:CANARY_TOKEN},{...value,taskRoot:root},{...value,capsulePath:join(root,"foreign.json")},{...value,files:[...files,files[0]]},{...value,identities:[...identities,identities[0]]},{...value,preparedPayload:{bytes:2,sha256:"0".repeat(64)}},{...value,files:files.map((item,index)=>index===0?{...item,path:"../external"}:item)}]){
      const bytes=canonicalBytes(invalid);writeFileSync(staged.capsulePath,bytes);refused(()=>readStagedSite(staged.capsulePath,createHash("sha256").update(bytes).digest("hex"),root));
    }
    writeFileSync(staged.capsulePath,original);const duplicate=encoded.encode(original.toString("utf8").replace("{","{\"schemaVersion\":1,"));writeFileSync(staged.capsulePath,duplicate);refused(()=>readStagedSite(staged.capsulePath,createHash("sha256").update(duplicate).digest("hex"),root));
    writeFileSync(staged.capsulePath,original);refused(()=>readStagedSite(staged.capsulePath,"0".repeat(64),root));refused(()=>readStagedSite(staged.capsulePath,staged.capsuleSha256,dirname(root)));cleanupStagedSite(staged,root);
  });});
  it("restart digest outputs belong to the same issued capsule and capture getters once",()=>{fixture(root=>{
    const output=join(root,"output");writeFileSync(output,"");const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")],encoded.encode("{}")),second=stageSite(root,"pixelwatch",[file("index.html","different"),file("site.json","{}")]);
    let reads=0;appendOutputs(output,{capsule:staged.capsulePath,get capsule_sha256(){reads++;return staged.capsuleSha256;}});assert.equal(reads,1);const prior=`capsule=${staged.capsulePath}\ncapsule_sha256=${staged.capsuleSha256}\n`;assert.equal(readFileSync(output,"utf8"),prior);
    for(const values of [{capsule_sha256:staged.capsuleSha256},{capsule:staged.capsulePath,capsule_sha256:"0".repeat(64)},{capsule:staged.capsulePath,capsule_sha256:second.capsuleSha256},{capsule:staged.capsulePath,capsule_sha256:staged.capsuleSha256.toUpperCase()}])refused(()=>{appendOutputs(output,values);});assert.equal(readFileSync(output,"utf8"),prior);
    const changed={capsule:staged.capsulePath,get capsule_sha256(){writeFileSync(join(staged.taskRoot,"prepared.json"),"[]");return staged.capsuleSha256;}};refused(()=>{appendOutputs(output,changed);});assert.equal(readFileSync(output,"utf8"),prior);cleanupStagedSite(second,root);
  });});
  it("private payload inode proofs survive every terminal bounded read close boundary",()=>{
    const observations:Array<{mode:string;exchanged:boolean;refused:boolean}>=[];
    for(const mode of ["payload","restart","verify","cleanup","output"])fixture(root=>{
      const staged=stageSite(root,"pixelwatch",[file("index.html","entry"),file("site.json","{}")],encoded.encode("{\"prepared\":1}")),path=join(staged.taskRoot,"prepared.json"),original=readFileSync(path),before=lstatSync(path,{bigint:true}),opened=new Set<number>(),output=join(root,"output");writeFileSync(output,"");
      const originalOpen=fs.openSync,originalClose=fs.closeSync;let exchanged=false,isRefused=false;
      try{
        fs.openSync=(...args:unknown[])=>{const fd=Reflect.apply(originalOpen,fs,args) as number;if(args[0]===path)opened.add(fd);return fd;};
        fs.closeSync=(fd:number)=>{originalClose(fd);if(opened.delete(fd)&&!exchanged){exchanged=true;renameSync(path,join(root,"retained-original-prepared.json"));writeFileSync(path,original);const after=lstatSync(path,{bigint:true});assert.ok(before.dev!==after.dev||before.ino!==after.ino);}};syncBuiltinESMExports();
        try{if(mode==="payload")readPreparedPayload(staged,root);else if(mode==="restart")readStagedSite(staged.capsulePath,staged.capsuleSha256,root);else if(mode==="verify")verifyStagedSite(staged,root);else if(mode==="cleanup")cleanupStagedSite(staged,root);else appendOutputs(output,{capsule:staged.capsulePath,capsule_sha256:staged.capsuleSha256});}
        catch(error){assert.ok(error instanceof Error);assertNoSecrets([error.stack??error.message]);isRefused=/^pixelwatch-action: [a-z-]+$/.test(error.message);}
      }finally{fs.openSync=originalOpen;fs.closeSync=originalClose;syncBuiltinESMExports();}
      observations.push({mode,exchanged,refused:isRefused});
    });
    assert.deepEqual(observations,["payload","restart","verify","cleanup","output"].map(mode=>({mode,exchanged:true,refused:true})));
  });
  it("restart cleanup removes the complete actual assembled sibling tree and preserves outside files",async()=>{
    const store:Store={schemaVersion:1,marker:"pixelwatch-store",repositoryId:"11",dataVersion:1,txn:0,runs:[]},bytes=canonicalBytes(store);
    const site=await assembleSite({config:{schemaVersion:1,source:{workflowIds:["9"],events:["workflow_dispatch"]},providers:[{id:"p",shards:1}]},configCommit:oid,pages:{url:"https://adopter.github.io/visual-app/",host:"adopter.github.io"},repository:{repositoryId:"11",owner:"adopter",name:"visual-app"},assets:{release:"0.1.0-rc.1",releaseCommit:"b".repeat(40),script:encoded.encode("/* staging I/O fixture, not production-host evidence */")},snapshot:{tip:"c".repeat(40),store,runs:new Map(),files:[{path:"store.json",bytes:bytes.byteLength}],readFile:()=>Promise.resolve(bytes)}});
    assert.ok(site.files.some(item=>item.path.startsWith("api/v1/schemas/")));assert.ok(site.files.some(item=>item.path.startsWith("app/")));
    fixture(root=>{
      const sentinel=join(root,"outside-stage.txt"),sentinelBytes=encoded.encode("outside stage survives");writeFileSync(sentinel,sentinelBytes);
      const staged=stageSite(root,site.urls.prefix,site.files,encoded.encode("{\"prepared\":1}")),restarted=readStagedSite(staged.capsulePath,staged.capsuleSha256,root);
      verifyStagedSite(restarted,root);cleanupStagedSite(restarted,root);
      assert.equal(existsSync(staged.taskRoot),false);assert.deepEqual(readFileSync(sentinel),Buffer.from(sentinelBytes));assert.deepEqual(readdirSync(root),["outside-stage.txt"]);
    });
  });
});

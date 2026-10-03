import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { addRun, appScriptPath, blobPath, encodePng, newStore, pixelHash, planHousekeeping, projectChanges, runRecordPath, siteLocation, siteUrls, type StoreTree } from "@pixelwatch/core";
import { canonicalBytes, parseDocument, type Config, type Run } from "@pixelwatch/schemas";
import { buildViewerAssets } from "../../../tools/viewer/build.ts";
import { renderEntry } from "../../viewer/src/entry.ts";
import { assembleSite } from "../src/assemble.ts";
import { measureSite } from "../src/sizing.ts";
import { PublisherError, type PublisherContext } from "../src/types.ts";
const oid = (value: string) => value.repeat(40);
function required<T>(value:T|undefined|null):T {if(value===undefined||value===null)throw new Error("missing fixture value");return value;}
let script: Uint8Array;
beforeAll(async()=>{script=(await buildViewerAssets("0.1.0-rc.1")).script;});
function fixture():{context:PublisherContext;tree:StoreTree;files:Map<string,Uint8Array>} {
  const parsed=parseDocument("run",readFileSync(new URL("../../../testdata/schemas/run/valid/initial-commit-no-baseline.json",import.meta.url))); if(!parsed.ok)throw new Error("bad fixture");
  const pixels={width:4,height:4,channels:3 as const,data:new Uint8Array(48).fill(125)}; const png=encodePng(pixels); const pixel=pixelHash(pixels); let store=newStore(parsed.value.source.repositoryId); const runs=new Map<string,Run>();
  for(const [index,id] of ["5","6","99999"].entries()){const run=structuredClone(parsed.value);run.runKey=`${id}-a1`;run.source.runId=id;run.source.createdAt=`2026-09-${String(20+index).padStart(2,"0")}T00:00:00Z`;required(run.results[0]).head={state:"captured",pixelHash:pixel,width:4,height:4};runs.set(run.runKey,run);store=addRun(store,run).store;}
  const files=new Map<string,Uint8Array>([["store.json",canonicalBytes(store)],[blobPath(pixel),png],...[...runs].map(([key,run]):[string,Uint8Array]=>[runRecordPath(key),canonicalBytes(run)])]);
  const config:Config={schemaVersion:1,source:{workflowIds:["123456"],events:["push"]},providers:[{id:"fixture",shards:1}]};
  return {context:{config,configCommit:oid("3"),pages:{url:"https://owner.github.io/repo/",host:"owner.github.io"},repository:{repositoryId:store.repositoryId,owner:"owner",name:"repo"},assets:{release:"0.1.0-rc.1",releaseCommit:oid("4"),script}},tree:{store,runs,files:[...files].map(([path,bytes])=>({path,bytes:bytes.byteLength}))},files};
}
describe("real final site size planning",()=>{
  it("uses exact final renderer and trusted app sizes without caller size overrides",()=>{
    const w=fixture();const sizes=measureSite({...w.context,tree:w.tree});const urls=siteUrls(siteLocation(w.context.config,w.context.pages));
    expect(sizes.fixed.find(file=>file.path === "index.html")?.bytes).toBe(renderEntry({urls,repository:w.context.repository,assets:w.context.assets}).byteLength);
    expect(sizes.fixed.find(file=>file.path === appScriptPath(w.context.assets.release))?.bytes).toBe(script.byteLength);
    for(const [key,run] of w.tree.runs)expect(sizes.permalink(key)).toBe(renderEntry({urls,repository:w.context.repository,assets:w.context.assets,changes:projectChanges(run,urls)}).byteLength);
    expect(()=>sizes.permalink("42-a1")).toThrow(PublisherError);
  });
  it("conservatively bounds exact assembly bytes for every retained subset",async()=>{
    const w=fixture();const sizes=measureSite({...w.context,tree:w.tree});const keys=[...w.tree.runs.keys()];
    for(let mask=0;mask<1<<keys.length;mask++){
      const kept=keys.filter((_,index)=>(mask&(1<<index))!==0);const store={...w.tree.store,runs:w.tree.store.runs.filter(entry=>kept.includes(entry.runKey))};const runs=new Map([...w.tree.runs].filter(([key])=>kept.includes(key)));
      const paths=new Set(["store.json",...kept.map(runRecordPath),...(kept.length===0?[]:[...w.files.keys()].filter(path=>path.startsWith("blobs/")))]); const tree={store,runs,files:w.tree.files.filter(file=>paths.has(file.path))};
      const plan=planHousekeeping({...tree,policy:{mainRuns:100,runsPerPr:100,prStreams:100},limits:{softBytes:1,hardBytes:1024*1024*1024},now:"2026-10-03T00:00:00Z",prStates:new Map(),projected:sizes});expect(plan.ok).toBe(true);if(!plan.ok)throw new Error("unexpected refusal");
      const actual=await assembleSite({...w.context,snapshot:{...tree,tip:oid("5"),readFile:(path)=>Promise.resolve(required(w.files.get(path)))}});
      expect(actual.totalBytes).toBeLessThanOrEqual(plan.budget.totalBytes);
      for(const category of ["html","app","api","stubs","data","blobs","derived","grace"] as const)expect(actual.breakdown[category]).toBeLessThanOrEqual(plan.budget.breakdown[category]);
    }
  });
  it("captures pure sizing inputs so later caller mutation cannot change any returned size",()=>{
    const w=fixture();const expected=measureSite({...w.context,tree:w.tree});const assets={...w.context.assets,script:Uint8Array.from(script)};const actual=measureSite({...w.context,assets,tree:w.tree});
    assets.script.fill(0);(assets as {release:string}).release="../bad";w.context.config.store={prefix:"foreign"};for(const run of w.tree.runs.values())required(run.results[0]).labels={title:"altered"};(w.tree.runs as Map<string,Run>).clear();
    expect(actual.fixed).toEqual(expected.fixed);for(const key of ["5-a1","6-a1","99999-a1"]){expect(actual.changes(key)).toBe(expected.changes(key));expect(actual.permalink(key)).toBe(expected.permalink(key));}expect(actual.stream("main",["5-a1","6-a1"])).toBe(expected.stream("main",["5-a1","6-a1"]));
  });
  it("validates complete unknown and missing pre retention graph before producing sizes",()=>{
    for(const change of ["version","missing","active"]){const w=fixture();if(change==="version")(required(w.tree.runs.get("5-a1")).versions as {data:number}).data=2;if(change==="missing")(w.tree as {files:StoreTree["files"]}).files=w.tree.files.filter(file=>!file.path.startsWith("blobs/"));if(change==="active")(w.tree as {files:StoreTree["files"]}).files=[...w.tree.files,{path:"app/0.0.1/app.js",bytes:1}];expect(()=>measureSite({...w.context,tree:w.tree})).toThrow(PublisherError);}
  });
  it("sanitizes synchronous sizing metadata errors without invoking poisoned diagnostic accessors",()=>{
    const w=fixture();const forged=Object.create(PublisherError.prototype) as PublisherError;let accessors=0;for(const field of ["code","message","stack","cause"])Object.defineProperty(forged,field,{get:()=>{accessors++;return "FAKE_SIZING_TOKEN_532af";}});
    const input={...w.context,tree:w.tree};Object.defineProperty(input,"configCommit",{get:()=>{throw forged;}});let error:unknown;try{measureSite(input);}catch(value){error=value;}
    expect(accessors).toBe(0);expect(error===forged).toBe(false);expect(error).toBeInstanceOf(PublisherError);expect((error as PublisherError).code).toBe("publisher-input-invalid");expect(String(error)+JSON.stringify(error)+((error as Error).stack??"")).not.toContain("FAKE_SIZING_TOKEN_532af");expect(accessors).toBe(0);
  });
});

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs,{existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmdirSync,rmSync,symlinkSync,truncateSync,writeFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {join,relative,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {afterAll,describe,it} from "vitest";
import {canonicalBytes} from "../../../packages/schemas/src/canonical.ts";
import {assertNoSecrets,CANARY_TOKEN,SIGNED_URL} from "../../../tools/simulation/capture.ts";
import {readRuntimeRelease,type RuntimeRelease} from "../src/runtime-release.ts";

const sourceCommit="a".repeat(40),version="0.1.0-rc.1",paths=["app.js","index.js","png-worker.js"] as const;
const maximum=8*1024*1024,metadataMaximum=1024*1024,raw:(string|Uint8Array)[]=[];
interface Metadata {schemaVersion:number;version:string;sourceCommit:string;target:string;artifacts:{path:string;bytes:number;sha256:string}[];dependencies:{name:string;version:string;license:string}[]}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function record(value:string|Uint8Array):void {assertNoSecrets([value]);raw.push(value);}
function fixture(run:(root:string,metadata:Metadata)=>void):void {
  const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"pixelwatch-runtime-release-spec-"));
  try {
    const artifacts=paths.map(path=>{const bytes=Buffer.from(`/* release I/O tooling fixture: ${path} */\n`);writeFileSync(join(root,path),bytes);return {path,bytes:bytes.byteLength,sha256:hash(bytes)};});
    const metadata:Metadata={schemaVersion:1,version,sourceCommit,target:"node24",artifacts,dependencies:[{name:"ajv",version:"8.20.0",license:"MIT"},{name:"fast-deep-equal",version:"3.1.3",license:"MIT"}]};
    writeFileSync(join(root,"release.json"),canonicalBytes(metadata));run(root,metadata);
  }finally {
    const location=relative(parent,realpathSync(root));assert.ok(location.startsWith("pixelwatch-runtime-release-spec-")&&!location.includes(sep)&&realpathSync(root)===root);
    rmSync(root,{recursive:true,force:false});
  }
}
const hostUrl=(root:string)=>pathToFileURL(join(root,"index.js")).href;
function load(root:string):RuntimeRelease {const result=readRuntimeRelease(hostUrl(root),version,sourceCommit);record(result.script);record(result.pngWorkerUrl.href);return result;}
function refused(run:()=>unknown):void {
  assert.throws(run,error=>{assert.ok(error instanceof Error);record(error.stack??error.message);return /^pixelwatch-action: release-invalid$/.test(error.message);});
}
function changed(root:string,metadata:Metadata,mutate:(value:Metadata)=>void):void {const next=structuredClone(metadata);mutate(next);writeFileSync(join(root,"release.json"),canonicalBytes(next));refused(()=>load(root));}
function observeReads(run:(observed:{reads:number;bundleReads:number})=>void):void {
  const originalOpen=fs.openSync,originalClose=fs.closeSync,originalRead=fs.readSync,opened=new Map<number,string>(),observed={reads:0,bundleReads:0};
  try {
    fs.openSync=(...args:unknown[])=>{const descriptor=Reflect.apply(originalOpen,fs,args) as number;opened.set(descriptor,String(args[0]));return descriptor;};
    fs.readSync=(...args:unknown[])=>{observed.reads++;if(paths.some(path=>opened.get(args[0] as number)?.endsWith(sep+path)))observed.bundleReads++;return Reflect.apply(originalRead,fs,args) as number;};
    fs.closeSync=(descriptor:number)=>{opened.delete(descriptor);originalClose(descriptor);};syncBuiltinESMExports();run(observed);
  }finally {fs.openSync=originalOpen;fs.closeSync=originalClose;fs.readSync=originalRead;syncBuiltinESMExports();}
}

afterAll(()=>{
  assertNoSecrets(raw);const directory=new URL("../../../.tools/logs/",import.meta.url);mkdirSync(directory,{recursive:true});
  writeFileSync(new URL("runtime-release-raw.json",directory),JSON.stringify({productionHost:false,outputs:raw.map(value=>typeof value==="string"?value:Buffer.from(value).toString("base64"))}));
  writeFileSync(new URL("runtime-release-raw-scan.json",directory),JSON.stringify({values:raw.length,bytes:raw.reduce((total,value)=>total+(typeof value==="string"?Buffer.byteLength(value):value.byteLength),0),failures:0}));
});

describe("fixed sibling runtime release I/O (tooling fixtures, production host pending)",()=>{
  it("valid canonical metadata returns owned app bytes and only the fixed sibling worker URL",()=>{fixture((root,metadata)=>{
    const result=load(root);assert.equal(result.version,version);assert.equal(result.sourceCommit,sourceCommit);assert.ok(Object.isFrozen(result));
    assert.deepEqual(result.script,Uint8Array.from(readFileSync(join(root,"app.js"))));assert.equal(result.pngWorkerUrl.href,pathToFileURL(join(root,"png-worker.js")).href);
    const bytes=result.script;bytes.fill(0);const url=result.pngWorkerUrl;url.pathname="/foreign.js";assert.equal(hash(result.script),metadata.artifacts[0]?.sha256);assert.equal(result.pngWorkerUrl.href,pathToFileURL(join(root,"png-worker.js")).href);
    writeFileSync(join(root,"app.js"),"later replacement");assert.equal(hash(result.script),metadata.artifacts[0]?.sha256);
  });});
  it("final and RC versions use the exact embedded version and source SHA",()=>{fixture((root,metadata)=>{
    for(const release of ["0.1.0","0.1.0-rc.19"]){writeFileSync(join(root,"release.json"),canonicalBytes({...metadata,version:release}));const result=readRuntimeRelease(hostUrl(root),release,sourceCommit);record(result.script);assert.equal(result.version,release);}
    for(const embedded of ["0.1.0-rc.0","0.2.0",CANARY_TOKEN+SIGNED_URL])refused(()=>readRuntimeRelease(hostUrl(root),embedded,sourceCommit));
    for(const sha of ["main","a".repeat(39),sourceCommit.toUpperCase(),CANARY_TOKEN+SIGNED_URL])refused(()=>readRuntimeRelease(hostUrl(root),version,sha));
    writeFileSync(join(root,"release.json"),canonicalBytes(metadata));refused(()=>readRuntimeRelease(hostUrl(root),"0.1.0",sourceCommit));refused(()=>readRuntimeRelease(hostUrl(root),version,"b".repeat(40)));
  });});
  it("unknown schema target version source and metadata fields refuse before bundle reads",()=>{fixture((root,metadata)=>{
    for(const mutate of [(value:Metadata)=>{value.schemaVersion=2;},(value:Metadata)=>{value.target="node22";},(value:Metadata)=>{value.version="0.1.0";},(value:Metadata)=>{value.sourceCommit="b".repeat(40);},(value:Metadata)=>{Object.assign(value,{extra:CANARY_TOKEN+SIGNED_URL});}])observeReads(observed=>{changed(root,metadata,mutate);assert.equal(observed.bundleReads,0);});
  });});
  it("artifact sizes hashes duplicates order and foreign paths cannot select a sibling",()=>{fixture((root,metadata)=>{
    for(const mutate of [
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts[0].bytes++;},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts[0].sha256="0".repeat(64);},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts[0].bytes=0;},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts[0].bytes=-1;},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts[0].sha256="A".repeat(64);},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);value.artifacts.push(value.artifacts[0]);},
      (value:Metadata)=>{value.artifacts.reverse();},
      (value:Metadata)=>{value.artifacts.pop();},
      (value:Metadata)=>{assert.ok(value.artifacts[0]);Object.assign(value.artifacts[0],{extra:CANARY_TOKEN});},
    ])changed(root,metadata,mutate);
    for(const path of ["../foreign.js","./app.js","other/app.js","C:/foreign.js","\\\\server\\share\\app.js",SIGNED_URL])changed(root,metadata,value=>{assert.ok(value.artifacts[0]);value.artifacts[0].path=path;});
  });});
  it("all three bundle hashes are checked without executing any bundle",()=>{fixture((root,metadata)=>{
    for(const path of paths){const original=readFileSync(join(root,path)),altered=Buffer.from(original),first=altered[0];assert.ok(first!==undefined);altered[0]=first^1;writeFileSync(join(root,path),altered);refused(()=>load(root));writeFileSync(join(root,path),original);}
    assert.equal(hash(load(root).script),metadata.artifacts[0]?.sha256);
  });});
  it("license inventory must remain deterministic nonempty exact and bounded",()=>{fixture((root,metadata)=>{
    for(const mutate of [(value:Metadata)=>{value.dependencies=[];},(value:Metadata)=>{value.dependencies.reverse();},(value:Metadata)=>{assert.ok(value.dependencies[0]);value.dependencies.push(value.dependencies[0]);},(value:Metadata)=>{assert.ok(value.dependencies[0]);Object.assign(value.dependencies[0],{extra:CANARY_TOKEN});}])changed(root,metadata,mutate);
    for(const [key,limit] of [["name",214],["version",100],["license",1024]] as const)for(const value of ["","x".repeat(limit+1),"line\nbreak"]){changed(root,metadata,next=>{assert.ok(next.dependencies[0]);next.dependencies[0][key]=value;});}
  });});
  it("noncanonical duplicate-key malformed UTF-8 and unknown JSON shapes refuse",()=>{fixture((root,metadata)=>{
    const original=Buffer.from(canonicalBytes(metadata));
    for(const bytes of [Buffer.concat([original,Buffer.from("\n")]),Buffer.from(original.toString("utf8").replace("{",'{"schemaVersion":1,')),Buffer.from(JSON.stringify(metadata,null,2)),Buffer.from([0xff]),Buffer.from("[]"),Buffer.from("null"),Buffer.from('{"schemaVersion":1.0}')]){writeFileSync(join(root,"release.json"),bytes);refused(()=>load(root));}
  });});
  it("absent metadata or any bundle refuses even when source TypeScript exists",()=>{fixture(root=>{
    mkdirSync(join(root,"src"));writeFileSync(join(root,"src","main.ts"),"throw new Error('source is forbidden')");writeFileSync(join(root,"src","worker.ts"),"throw new Error('source is forbidden')");
    for(const path of ["release.json",...paths]){const location=join(root,path),saved=join(root,`${path}.saved`);renameSync(location,saved);refused(()=>load(root));assert.equal(existsSync(location),false);renameSync(saved,location);}
  });});
  it("host locations must be canonical file URLs for index.js with no returned or alternate path",()=>{fixture(root=>{
    for(const url of [SIGNED_URL,hostUrl(root)+"?ignored=1",hostUrl(root)+"#ignored",pathToFileURL(join(root,"app.js")).href,pathToFileURL(join(root,"src","main.ts")).href,pathToFileURL(join(root,"index.js")).href.replace("index.js","%69ndex.js"),CANARY_TOKEN])refused(()=>readRuntimeRelease(url,version,sourceCommit));
  });});
  it("metadata and total bundle limits refuse before any over-budget body allocation or read",()=>{fixture((root,metadata)=>{
    truncateSync(join(root,"release.json"),metadataMaximum+1);observeReads(observed=>{refused(()=>load(root));assert.equal(observed.reads,0);});
    changed(root,metadata,value=>{assert.ok(value.artifacts[0]);value.artifacts[0].bytes=maximum+1;});
    const sizes=[maximum-1,1,1];const over={...metadata,artifacts:metadata.artifacts.map((entry,index)=>({...entry,bytes:sizes[index]??0}))};writeFileSync(join(root,"release.json"),canonicalBytes(over));
    observeReads(observed=>{refused(()=>load(root));assert.equal(observed.bundleReads,0);});
    writeFileSync(join(root,"release.json"),canonicalBytes(metadata));truncateSync(join(root,"png-worker.js"),maximum+1);observeReads(observed=>{refused(()=>load(root));assert.equal(observed.bundleReads,0);});
  });});
  it("links junction ancestors and multiply linked bundle or metadata inodes refuse",()=>{fixture(root=>{
    const alias=join(root,"alias");symlinkSync(root,alias,"junction");refused(()=>readRuntimeRelease(hostUrl(alias),version,sourceCommit));rmSync(alias);
    for(const path of ["release.json",...paths]){const linked=join(root,`${path}.hardlink`);linkSync(join(root,path),linked);refused(()=>load(root));rmSync(linked);}
    for(const path of ["release.json",...paths]){const location=join(root,path),saved=join(root,`${path}.saved`);renameSync(location,saved);mkdirSync(location);refused(()=>load(root));rmdirSync(location);renameSync(saved,location);}
  });});
  it("every retained ancestor inode is checked across release reads",()=>{fixture(root=>{
    const directory=join(root,"release"),moved=join(root,"retained-release");mkdirSync(directory);for(const path of ["release.json",...paths])writeFileSync(join(directory,path),readFileSync(join(root,path)));
    const originalClose=fs.closeSync,originalOpen=fs.openSync,opened=new Set<number>();let exchanged=false;
    try {fs.openSync=(...args:unknown[])=>{const descriptor=Reflect.apply(originalOpen,fs,args) as number;if(args[0]===join(directory,"release.json"))opened.add(descriptor);return descriptor;};
      fs.closeSync=(descriptor:number)=>{originalClose(descriptor);if(opened.delete(descriptor)&&!exchanged){exchanged=true;renameSync(directory,moved);mkdirSync(directory);for(const path of ["release.json",...paths])writeFileSync(join(directory,path),readFileSync(join(moved,path)));}};syncBuiltinESMExports();refused(()=>load(directory));
    }finally {fs.closeSync=originalClose;fs.openSync=originalOpen;syncBuiltinESMExports();}
    assert.equal(exchanged,true);assert.equal(existsSync(join(moved,"app.js")),true);
  });});
  it("bundle and metadata pathname swaps at terminal close cannot return foreign authority",()=>{fixture(root=>{
    for(const path of ["release.json",...paths]){
      const location=join(root,path),original=readFileSync(location),before=lstatSync(location,{bigint:true}),saved=join(root,`${path}.retained`),originalClose=fs.closeSync,originalOpen=fs.openSync,opened=new Set<number>();let exchanged=false;
      try {fs.openSync=(...args:unknown[])=>{const descriptor=Reflect.apply(originalOpen,fs,args) as number;if(args[0]===location)opened.add(descriptor);return descriptor;};
        fs.closeSync=(descriptor:number)=>{originalClose(descriptor);if(opened.delete(descriptor)&&!exchanged){exchanged=true;renameSync(location,saved);writeFileSync(location,original);const after=lstatSync(location,{bigint:true});assert.ok(before.dev!==after.dev||before.ino!==after.ino);}};syncBuiltinESMExports();refused(()=>load(root));
      }finally {fs.closeSync=originalClose;fs.openSync=originalOpen;syncBuiltinESMExports();}
      assert.equal(exchanged,true);rmSync(location);renameSync(saved,location);
    }
  });});
  it("runtime validation never reads or enumerates ambient GH or GITHUB_TOKEN",()=>{fixture(root=>{
    const original=process.env;let credentials=0;
    const trapped=new Proxy(original,{get(target,key){if(key==="GH_TOKEN"||key==="GITHUB_TOKEN"){credentials++;throw new Error(CANARY_TOKEN+SIGNED_URL);}return typeof key==="string"?target[key]:undefined;},ownKeys(){credentials++;throw new Error(CANARY_TOKEN+SIGNED_URL);}});
    let result:RuntimeRelease|undefined;try {process.env=trapped;result=readRuntimeRelease(hostUrl(root),version,sourceCommit);}finally {process.env=original;}
    assert.equal(credentials,0);assert.ok(result);record(result.script);assert.equal(result.version,version);
  });});
});

import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,type BigIntStats} from "node:fs";
import {basename,dirname,isAbsolute,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {canonicalBytes} from "../../../packages/schemas/src/canonical.ts";
import {parseJson,type JsonObject,type JsonValue} from "../../../packages/schemas/src/json.ts";

export interface RuntimeRelease {
  readonly version:string;
  readonly sourceCommit:string;
  readonly script:Uint8Array;
  readonly pngWorkerUrl:URL;
}

// Match the existing release compiler output budget; metadata has the existing JSON bound.
const MAX_BUNDLE_BYTES=8*1024*1024,MAX_METADATA_BYTES=1024*1024;
const BUNDLES=["app.js","index.js","png-worker.js"] as const;
interface FileProof {readonly path:string;readonly stat:BigIntStats}
interface Artifact {readonly path:typeof BUNDLES[number];readonly bytes:number;readonly sha256:string}
function fail():never {throw new Error("pixelwatch-action: release-invalid");}
function controls(value:string):boolean {for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<32||code===127)return true;}return false;}
function version(value:string):boolean {return typeof value==="string"&&value.length<=40&&/^0\.1\.0(?:-rc\.[1-9][0-9]{0,18})?$/.test(value);}
function sourceCommit(value:string):boolean {return typeof value==="string"&&/^[0-9a-f]{40}$/.test(value);}
function absolute(path:string):void {if(path.length===0||path.length>4096||!path.isWellFormed()||controls(path)||!isAbsolute(path)||resolve(path)!==path)fail();}
function directory(path:string):BigIntStats {
  absolute(path);const stat=lstatSync(path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)fail();return stat;
}
function ancestors(path:string):FileProof[] {
  const parents:FileProof[]=[];let parent=dirname(path);
  for(let depth=0;depth<256;depth++){parents.push({path:parent,stat:directory(parent)});const next=dirname(parent);if(next===parent)return parents.reverse();parent=next;}
  return fail();
}
function sameInode(actual:BigIntStats,expected:BigIntStats):boolean {return actual.dev===expected.dev&&actual.ino===expected.ino;}
function checkAncestors(parents:readonly FileProof[]):void {for(const parent of parents)if(!sameInode(directory(parent.path),parent.stat))fail();}
function regular(path:string):BigIntStats {
  absolute(path);const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||realpathSync(path)!==path)fail();return stat;
}
function sameFile(actual:BigIntStats,expected:BigIntStats):boolean {
  return actual.isFile()&&actual.nlink===1n&&sameInode(actual,expected)&&actual.size===expected.size&&actual.mtimeNs===expected.mtimeNs&&actual.ctimeNs===expected.ctimeNs;
}
function checkFiles(files:readonly FileProof[],parents:readonly FileProof[]):void {checkAncestors(parents);for(const file of files)if(!sameFile(regular(file.path),file.stat))fail();}
function proof(path:string,maximum:number,expectedSize?:number):FileProof {
  const stat=regular(path);if(stat.size<=0n||stat.size>BigInt(maximum)||(expectedSize!==undefined&&stat.size!==BigInt(expectedSize)))fail();return {path,stat};
}
/** Retain inode/size/time and the complete ancestor proof before allocation and after close. */
function readOwned(file:FileProof,parents:readonly FileProof[]):Uint8Array {
  checkFiles([file],parents);const descriptor=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Uint8Array;
  try {
    if(!sameFile(fstatSync(descriptor,{bigint:true}),file.stat))fail();checkFiles([file],parents);
    const size=Number(file.stat.size);bytes=new Uint8Array(size);
    for(let offset=0;offset<size;){const count=readSync(descriptor,bytes,offset,size-offset,offset);if(count===0)fail();offset+=count;}
    if(readSync(descriptor,new Uint8Array(1),0,1,size)!==0||!sameFile(fstatSync(descriptor,{bigint:true}),file.stat))fail();checkFiles([file],parents);
  }finally {closeSync(descriptor);}
  checkFiles([file],parents);return bytes;
}
function record(value:JsonValue|undefined,keys:readonly string[]):JsonObject {
  if(value===null||typeof value!=="object"||Array.isArray(value))fail();const actual=Object.keys(value);
  if(actual.length!==keys.length||actual.some(key=>!keys.includes(key)))fail();return value;
}
function inventory(bytes:Uint8Array,expectedVersion:string,expectedSourceCommit:string):Artifact[] {
  const value=parseJson(bytes,{maxBytes:MAX_METADATA_BYTES,maxDepth:8}),metadata=record(value,["schemaVersion","version","sourceCommit","target","artifacts","dependencies"]);
  if(metadata["schemaVersion"]!==1||metadata["version"]!==expectedVersion||metadata["sourceCommit"]!==expectedSourceCommit||metadata["target"]!=="node24")fail();
  const entries=metadata["artifacts"];if(!Array.isArray(entries)||entries.length!==BUNDLES.length)fail();let total=0;
  const artifacts=entries.map((entry,index)=>{
    const item=record(entry,["path","bytes","sha256"]),path=BUNDLES[index],size=item["bytes"],sha256=item["sha256"];
    if(path===undefined||item["path"]!==path||typeof size!=="number"||!Number.isSafeInteger(size)||size<1||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256))fail();
    total+=size;if(total>MAX_BUNDLE_BYTES)fail();return {path,bytes:size,sha256};
  });
  const dependencies=metadata["dependencies"];if(!Array.isArray(dependencies)||dependencies.length===0)fail();let previous="";
  for(const dependency of dependencies){
    const item=record(dependency,["name","version","license"]);
    for(const [key,maximum] of [["name",214],["version",100],["license",1024]] as const){const text=item[key];if(typeof text!=="string"||text.length===0||text.length>maximum||!text.isWellFormed()||controls(text))fail();}
    const name=item["name"];if(typeof name!=="string"||name<=previous)fail();previous=name;
  }
  if(!Buffer.from(bytes).equals(canonicalBytes(value)))fail();return artifacts;
}

/** Only import.meta.url of the bundled host is authority; metadata never supplies a path. */
export function readRuntimeRelease(hostUrl:string,expectedVersion:string,expectedSourceCommit:string):RuntimeRelease {
  try {
    if(!version(expectedVersion)||!sourceCommit(expectedSourceCommit)||typeof hostUrl!=="string"||hostUrl.length>8192)fail();
    const url=new URL(hostUrl);if(url.protocol!=="file:"||url.search!==""||url.hash!=="")fail();const hostPath=fileURLToPath(url);absolute(hostPath);
    if(basename(hostPath)!=="index.js"||pathToFileURL(hostPath).href!==hostUrl)fail();
    const parents=ancestors(hostPath),root=dirname(hostPath),metadata=proof(join(root,"release.json"),MAX_METADATA_BYTES);
    const artifacts=inventory(readOwned(metadata,parents),expectedVersion,expectedSourceCommit);
    // Stat every fixed bundle and its aggregate budget before allocating any bundle body.
    const files=artifacts.map(artifact=>proof(join(root,artifact.path),MAX_BUNDLE_BYTES,artifact.bytes)),retained=[metadata,...files];checkFiles(retained,parents);
    let app:Uint8Array|undefined;
    for(let index=0;index<files.length;index++){
      const file=files[index],artifact=artifacts[index];if(file===undefined||artifact===undefined)fail();checkFiles(retained,parents);const bytes=readOwned(file,parents);
      if(createHash("sha256").update(bytes).digest("hex")!==artifact.sha256)fail();if(artifact.path==="app.js")app=bytes;
    }
    checkFiles(retained,parents);if(app===undefined)fail();const owned=app,worker=pathToFileURL(join(root,"png-worker.js")).href;
    return Object.freeze({version:expectedVersion,sourceCommit:expectedSourceCommit,get script(){return Uint8Array.from(owned);},get pngWorkerUrl(){return new URL(worker);}});
  }catch {return fail();}
}

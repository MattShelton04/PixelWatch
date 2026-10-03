import {createHash} from "node:crypto";
import {closeSync,constants,fstatSync,lstatSync,mkdirSync,mkdtempSync,openSync,readSync,readdirSync,realpathSync,rmdirSync,unlinkSync,writeSync,type BigIntStats} from "node:fs";
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {classifyStorePath} from "../../../packages/core/src/index.ts";
import {canonicalBytes,isGitHubId,parseJson,parseRunKey} from "../../../packages/schemas/src/index.ts";
import {STORE_LIMITS} from "../../../packages/store/src/index.ts";
import {copyBytes} from "../../../packages/publisher/src/assembly-input.ts";

export interface SiteFile {readonly path:string;readonly bytes:Uint8Array;readonly sha256:string}
export interface FileIdentity {readonly path:string;readonly dev:string;readonly ino:string}
export interface StagedSite {
  readonly taskRoot:string;readonly uploadRoot:string;readonly capsulePath:string;readonly capsuleSha256:string;readonly prefix:string;
  readonly directories:readonly FileIdentity[];readonly identities:readonly FileIdentity[];readonly files:readonly SiteFile[];
  readonly preparedPayload?:{readonly bytes:number;readonly sha256:string};
}
// Generated HTML/API/schema inventories exceed the store listing; keep the existing projection-state formula.
const MAX_SITE_FILES=3*STORE_LIMITS.maxFiles+2*1001+16;
const MAX_CAPSULE_BYTES=64*1024*1024,MAX_OUTPUT_BYTES=1024*1024,MAX_DIRECTORIES=8*STORE_LIMITS.maxFiles+256;
interface IssuedOutput {readonly kind:"upload_root"|"capsule";readonly staged:StagedSite;readonly runnerTemp:string}
const encoder=new TextEncoder(),issuedOutputs=new Map<string,IssuedOutput>();
function controls(value:string):boolean {for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<32||code===127)return true;}return false;}
const nativeArray=Array.isArray;
function array(value:unknown):boolean{return nativeArray(value);}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function fail(code:string):never {throw new Error(`pixelwatch-action: ${code}`);}
function safe<T>(operation:()=>T):T {try{return operation();}catch{return fail("filesystem-refused");}}
function identity(path:string,stat:BigIntStats):FileIdentity {return Object.freeze({path,dev:String(stat.dev),ino:String(stat.ino)});}
function same(actual:BigIntStats,expected:FileIdentity):boolean {return String(actual.dev)===expected.dev&&String(actual.ino)===expected.ino;}
function absolute(path:string):string {
  if(typeof path!=="string"||path.length===0||path.length>4096||!path.isWellFormed()||controls(path)||!isAbsolute(path)||resolve(path)!==path)fail("path-refused");return path;
}
function ancestors(path:string):string[] {
  const result:string[]=[];let next=dirname(path);
  for(let depth=0;depth<256;depth++){result.push(next);const parent=dirname(next);if(parent===next)return result.reverse();next=parent;}
  return fail("path-refused");
}
function directory(path:string):BigIntStats {
  absolute(path);const stat=lstatSync(path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)fail("path-refused");return stat;
}
function chain(path:string):FileIdentity[] {
  absolute(path);return ancestors(path).map(parent=>identity(parent,directory(parent)));
}
function checkDirectories(expected:readonly FileIdentity[]):void {
  for(const item of expected)if(!same(directory(item.path),item))fail("directory-changed");
}
function regular(path:string):BigIntStats {
  absolute(path);const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||realpathSync(path)!==path)fail("file-refused");return stat;
}
function opened(path:string,flags:number,parents:readonly FileIdentity[]):{fd:number;stat:BigIntStats} {
  checkDirectories(parents);const before=regular(path),fd=openSync(path,flags|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||!same(stat,identity(path,before)))fail("file-changed");checkDirectories(parents);if(!same(regular(path),identity(path,stat)))fail("file-changed");return {fd,stat};}
  catch(error){closeSync(fd);throw error;}
}
/** Stat and inode bounds are checked before allocating the destination. */
export function readBoundedFile(path:string,maximum:number):Uint8Array {
  return safe(()=>{
    if(!Number.isSafeInteger(maximum)||maximum<0||maximum>STORE_LIMITS.maxTreeBytes)fail("file-limit");
    const parents=chain(path),handle=opened(path,constants.O_RDONLY,parents);
    try {
      if(handle.stat.size<0n||handle.stat.size>BigInt(maximum))fail("file-limit");const size=Number(handle.stat.size),bytes=new Uint8Array(size);
      for(let offset=0;offset<size;){const count=readSync(handle.fd,bytes,offset,size-offset,offset);if(count===0)fail("file-changed");offset+=count;}
      if(readSync(handle.fd,new Uint8Array(1),0,1,size)!==0)fail("file-changed");
      const after=fstatSync(handle.fd,{bigint:true});checkDirectories(parents);const current=regular(path);
      if(after.size!==handle.stat.size||current.size!==after.size||!same(after,identity(path,handle.stat))||!same(current,identity(path,after)))fail("file-changed");return bytes;
    }finally{closeSync(handle.fd);}
  });
}
function allowed(path:string):boolean {
  if(typeof path!=="string"||path.length===0||path.length>1024||!path.isWellFormed())return false;
  if(path==="index.html"||path==="site.json"||path==="llms.txt"||path==="api/v1/index.json")return true;
  const stored=classifyStorePath(path);if(stored?.kind==="run"||stored?.kind==="blob"||stored?.kind==="derived")return true;
  if(/^app\/0\.1\.0(?:-rc\.[1-9][0-9]{0,18})?\/app\.js$/.test(path))return true;
  if(/^api\/v1\/schemas\/(?:api-index|changes|pr-pointer|stream)-1\.json$/.test(path))return true;
  const stream=/^data\/v1\/streams\/(main|pr-([1-9][0-9]{0,18}))\.json$/.exec(path);if(stream!==null)return stream[1]==="main"||isGitHubId(stream[2]??"");
  const pointer=/^api\/v1\/pr\/([1-9][0-9]{0,18})\/latest\.json$/.exec(path);if(pointer!==null)return isGitHubId(pointer[1]??"");
  const run=/^(?:runs\/([^/]+)\/index\.html|api\/v1\/runs\/([^/]+)\/changes\.json)$/.exec(path);return run!==null&&parseRunKey(run[1]??run[2]??"")!==undefined;
}
function maximum(path:string):number {return path.endsWith(".json")?STORE_LIMITS.maxJsonBytes:path.endsWith(".png")?STORE_LIMITS.maxPngBytes:STORE_LIMITS.maxTreeBytes;}
/** Count captured plain metadata exactly before allocating its complete canonical string. */
function canonicalSize(value:unknown):number {
  let total=0;
  const add=(bytes:number)=>{total+=bytes;if(total>MAX_CAPSULE_BYTES)fail("inventory-refused");};
  const string=(value:string)=>{if(value.length>4096||!value.isWellFormed())fail("inventory-refused");add(encoder.encode(JSON.stringify(value)).byteLength);};
  const visit=(value:unknown,depth:number):void=>{
    if(depth>8)fail("inventory-refused");
    if(typeof value==="string"){string(value);return;}
    if(typeof value==="number"){if(!Number.isSafeInteger(value)||Object.is(value,-0))fail("inventory-refused");add(String(value).length);return;}
    if(typeof value!=="object"||value===null)fail("inventory-refused");
    if(array(value)){
      const items=value as readonly unknown[];if(items.length>MAX_DIRECTORIES)fail("inventory-refused");add(2);
      for(let index=0;index<items.length;index++){if(index>0)add(1);visit(items[index],depth+1);}return;
    }
    if(Object.getPrototypeOf(value)!==Object.prototype)fail("inventory-refused");
    const record=value as Record<string,unknown>,keys=Object.keys(record);if(keys.length>16)fail("inventory-refused");add(2);
    for(let index=0;index<keys.length;index++){const key=keys[index];if(key===undefined)fail("inventory-refused");if(index>0)add(1);string(key);add(1);visit(record[key],depth+1);}
  };
  visit(value,0);return total;
}
function captureFiles(source:readonly SiteFile[]):SiteFile[] {
  const count=source.length;if(!array(source)||!Number.isSafeInteger(count)||count<2||count>MAX_SITE_FILES)fail("inventory-refused");
  const files:SiteFile[]=[],seen=new Set<string>();let total=0,inventoryBound=2;
  for(let index=0;index<count;index++) {
    const item=source[index];if(item===undefined)fail("inventory-refused");const path=item.path,sha256=item.sha256;
    if(!allowed(path)||seen.has(path)||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256))fail("inventory-refused");seen.add(path);
    const bytes=copyBytes(item.bytes,Math.min(maximum(path),STORE_LIMITS.maxTreeBytes-total));if(hash(bytes)!==sha256)fail("inventory-refused");
    total+=bytes.byteLength;inventoryBound+=canonicalSize({path,bytes:bytes.byteLength,sha256})+(index===0?0:1);if(inventoryBound>MAX_CAPSULE_BYTES)fail("inventory-refused");files.push(Object.freeze({path,bytes,sha256}));
  }
  if(!seen.has("index.html")||!seen.has("site.json"))fail("inventory-refused");return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function captureIdentity(source:FileIdentity):FileIdentity {
  const path=absolute(source.path),dev=source.dev,ino=source.ino;if(typeof dev!=="string"||typeof ino!=="string"||!/^\d{1,32}$/.test(dev)||!/^\d{1,32}$/.test(ino))fail("inventory-refused");return Object.freeze({path,dev,ino});
}
function captureIdentities(source:readonly FileIdentity[],bound:number):FileIdentity[] {
  const count=source.length;if(!array(source)||!Number.isSafeInteger(count)||count<1||count>bound)fail("inventory-refused");const result:FileIdentity[]=[],seen=new Set<string>();
  for(let index=0;index<count;index++){const item=source[index];if(item===undefined)fail("inventory-refused");const copied=captureIdentity(item);if(seen.has(copied.path))fail("inventory-refused");seen.add(copied.path);result.push(copied);}return result;
}
function inside(root:string,path:string):boolean {const rel=relative(root,path);return rel!==""&&!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(`..${sep}`);}
function prefix(value:string):string {if(typeof value!=="string"||!/^[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63}){0,3}$/.test(value))fail("prefix-refused");return value;}
function payloadDescriptor(value:unknown):StagedSite["preparedPayload"] {
  if(value===undefined)return undefined;if(typeof value!=="object"||value===null)fail("inventory-refused");
  const source=value as {bytes:unknown;sha256:unknown},bytes=source.bytes,sha256=source.sha256;
  if(typeof bytes!=="number"||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_CAPSULE_BYTES||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256))fail("inventory-refused");return Object.freeze({bytes,sha256});
}
function location(anchor:string,taskRoot:string,uploadRoot:string,capsulePath:string):void {
  if(dirname(taskRoot)!==anchor||!/^pixelwatch-stage-[A-Za-z0-9_-]{6,64}$/.test(basename(taskRoot))||uploadRoot!==join(taskRoot,"upload")||capsulePath!==join(taskRoot,"state.json"))fail("path-refused");
}
/** Serialized paths are checked against fixed names and fresh runner authority before reads. */
function layout(anchor:string,taskRoot:string,uploadRoot:string,capsulePath:string,sitePrefix:string,directories:readonly FileIdentity[],identities:readonly FileIdentity[],filePaths:readonly string[],prepared:StagedSite["preparedPayload"]):void {
  location(anchor,taskRoot,uploadRoot,capsulePath);
  const expectedAncestors=chain(anchor);directory(anchor);
  const directoryMap=new Map(directories.map(item=>[item.path,item]));
  for(const item of [...expectedAncestors,identity(anchor,directory(anchor))]){const prior=directoryMap.get(item.path);if(prior===undefined||prior.dev!==item.dev||prior.ino!==item.ino)fail("directory-changed");}
  for(const item of directories)if(!expectedAncestors.some(parent=>parent.path===item.path)&&item.path!==anchor&&!inside(taskRoot,item.path)&&item.path!==taskRoot)fail("path-refused");
  if(!directoryMap.has(taskRoot)||!directoryMap.has(uploadRoot))fail("inventory-refused");checkDirectories(directories);
  const expectedFiles=new Set([capsulePath,...filePaths.map(path=>join(uploadRoot,...sitePrefix.split("/"),...path.split("/"))),...(prepared===undefined?[]:[join(taskRoot,"prepared.json")])]);
  if(identities.length!==expectedFiles.size||identities.some(item=>!expectedFiles.has(item.path)))fail("inventory-refused");
  for(const item of identities){const stat=regular(item.path);if(!same(stat,item))fail("file-changed");const cap=item.path===capsulePath||item.path===join(taskRoot,"prepared.json")?MAX_CAPSULE_BYTES:maximum(relative(join(uploadRoot,...sitePrefix.split("/")),item.path).split(sep).join("/"));if(stat.size>BigInt(cap))fail("file-limit");}
}
function task(value:StagedSite,runnerTemp:string):StagedSite {
  const anchor=absolute(runnerTemp),taskRoot=absolute(value.taskRoot),uploadRoot=absolute(value.uploadRoot),capsulePath=absolute(value.capsulePath),capsuleSha256=value.capsuleSha256,sitePrefix=prefix(value.prefix),preparedPayload=payloadDescriptor(value.preparedPayload);
  if(typeof capsuleSha256!=="string"||!/^[0-9a-f]{64}$/.test(capsuleSha256))fail("inventory-refused");
  const directories=captureIdentities(value.directories,MAX_DIRECTORIES),identities=captureIdentities(value.identities,MAX_SITE_FILES+2),files=captureFiles(value.files);
  layout(anchor,taskRoot,uploadRoot,capsulePath,sitePrefix,directories,identities,files.map(file=>file.path),preparedPayload);
  return Object.freeze({taskRoot,uploadRoot,capsulePath,capsuleSha256,prefix:sitePrefix,directories,identities,files,...(preparedPayload===undefined?{}:{preparedPayload})});
}
function inventory(value:Omit<StagedSite,"capsuleSha256">):Uint8Array {
  const identities=value.identities.filter(item=>item.path!==value.capsulePath),files=value.files.map(file=>({path:file.path,bytes:file.bytes.byteLength,sha256:file.sha256}));
  const preparedPayload=payloadDescriptor(value.preparedPayload),document={schemaVersion:1,taskRoot:value.taskRoot,uploadRoot:value.uploadRoot,capsulePath:value.capsulePath,prefix:value.prefix,directories:value.directories,identities,files,...(preparedPayload===undefined?{}:{preparedPayload})};
  const expected=canonicalSize(document);if(expected+(preparedPayload?.bytes??0)>MAX_CAPSULE_BYTES)fail("inventory-refused");const body=canonicalBytes(document);
  if(body.byteLength!==expected)fail("inventory-refused");return body;
}
function writeNew(path:string,bytes:Uint8Array):FileIdentity {
  const parents=chain(path),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {const start=fstatSync(fd,{bigint:true});checkDirectories(parents);if(!start.isFile()||start.nlink!==1n||!same(regular(path),identity(path,start)))fail("file-changed");
    for(let offset=0;offset<bytes.byteLength;){const count=writeSync(fd,bytes,offset,bytes.byteLength-offset);if(count===0)fail("file-changed");offset+=count;}
    const after=fstatSync(fd,{bigint:true});checkDirectories(parents);if(after.size!==BigInt(bytes.byteLength)||!same(regular(path),identity(path,after)))fail("file-changed");return identity(path,after);
  }finally{closeSync(fd);}
}
function collect(root:string,known:readonly FileIdentity[]):{files:FileIdentity[];directories:FileIdentity[]} {
  checkDirectories(known);const files:FileIdentity[]=[],directories:FileIdentity[]=[],queue=[root];let total=0;
  for(let index=0;index<queue.length;index++) {
    const path=queue[index];if(path===undefined)fail("inventory-refused");checkDirectories(known);directories.push(identity(path,directory(path)));
    for(const name of readdirSync(path)){if(name==="."||name===".."||name.includes(sep))fail("path-refused");const child=join(path,name),stat=lstatSync(child,{bigint:true});
      if(stat.isDirectory()&&!stat.isSymbolicLink()){directory(child);queue.push(child);if(queue.length>MAX_DIRECTORIES)fail("inventory-refused");}
      else {const own=regular(child);files.push(identity(child,own));total+=Number(own.size);if(files.length>MAX_SITE_FILES+2||total>STORE_LIMITS.maxTreeBytes+MAX_CAPSULE_BYTES)fail("file-limit");}
    }
  }return {files,directories};
}
/** Delete only individually checked inodes under the retained full ancestor chain. */
function removeOwned(root:string,known:readonly FileIdentity[]):void {
  const entries=collect(root,known);
  for(const item of entries.files){checkDirectories(known);checkDirectories(chain(item.path));if(!same(regular(item.path),item))fail("file-changed");unlinkSync(item.path);}
  for(const item of entries.directories.reverse()){checkDirectories(known.filter(parent=>parent.path!==item.path&&!inside(item.path,parent.path)));if(!same(directory(item.path),item))fail("directory-changed");rmdirSync(item.path);}
}
/** Only trusted generated relative paths become files below a new private runner directory. */
export function stageSite(runnerTemp:string,sitePrefix:string,source:readonly SiteFile[],preparedPayload?:Uint8Array):StagedSite {
  return safe(()=>{
    const payload=preparedPayload===undefined?undefined:copyBytes(preparedPayload,MAX_CAPSULE_BYTES),descriptor=payload===undefined?undefined:Object.freeze({bytes:payload.byteLength,sha256:hash(payload)});
    const anchor=absolute(runnerTemp),parents=[...chain(anchor),identity(anchor,directory(anchor))],selectedPrefix=prefix(sitePrefix),files=captureFiles(source);
    let taskRoot:string|undefined;const directories=new Map(parents.map(item=>[item.path,item]));
    try {
      checkDirectories(parents);taskRoot=mkdtempSync(join(anchor,"pixelwatch-stage-"));directories.set(taskRoot,identity(taskRoot,directory(taskRoot)));
      const ownedRoot=taskRoot,uploadRoot=join(ownedRoot,"upload"),capsulePath=join(ownedRoot,"state.json"),identities:FileIdentity[]=[];
      const makeDirectory=(path:string)=>{for(const item of [...ancestors(path),path]){if(directories.has(item))continue;if(!inside(ownedRoot,item))fail("path-refused");checkDirectories([...directories.values()]);mkdirSync(item,{mode:0o700});directories.set(item,identity(item,directory(item)));}};
      makeDirectory(uploadRoot);
      for(const file of files){const target=join(uploadRoot,...selectedPrefix.split("/"),...file.path.split("/"));makeDirectory(dirname(target));identities.push(writeNew(target,file.bytes));}
      if(payload!==undefined)identities.push(writeNew(join(taskRoot,"prepared.json"),payload));
      const body=inventory({taskRoot,uploadRoot,capsulePath,prefix:selectedPrefix,directories:[...directories.values()],identities,files,...(descriptor===undefined?{}:{preparedPayload:descriptor})});identities.push(writeNew(capsulePath,body));
      const staged=Object.freeze({taskRoot,uploadRoot,capsulePath,capsuleSha256:hash(body),prefix:selectedPrefix,directories:Object.freeze([...directories.values()]),identities:Object.freeze(identities),files:Object.freeze(files),...(descriptor===undefined?{}:{preparedPayload:descriptor})});
      verifyStagedSite(staged,anchor);issuedOutputs.set(uploadRoot,{kind:"upload_root",staged,runnerTemp:anchor});issuedOutputs.set(capsulePath,{kind:"capsule",staged,runnerTemp:anchor});return staged;
    }catch(error){if(taskRoot!==undefined){try {removeOwned(taskRoot,[...directories.values()]);}catch{/* Changed ownership refuses deletion; retain the fixed original failure. */}}throw error;}
  });
}
function record(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown> {
  if(typeof value!=="object"||value===null||array(value)||Object.getPrototypeOf(value)!==Object.prototype)fail("inventory-refused");
  const source=value as Record<string,unknown>,keys=Object.keys(source),allowed=new Set([...required,...optional]);if(required.some(key=>!Object.hasOwn(source,key))||keys.some(key=>!allowed.has(key)))fail("inventory-refused");return source;
}
function persistedIdentities(value:unknown,bound:number):FileIdentity[] {
  if(!array(value))fail("inventory-refused");const source=value as readonly unknown[];
  if(source.length<1||source.length>bound)fail("inventory-refused");const result:FileIdentity[]=[];
  for(const item of source){const captured=record(item,["path","dev","ino"]);result.push(captureIdentity(captured as unknown as FileIdentity));}return captureIdentities(result,bound);
}
interface ManifestFile {readonly path:string;readonly bytes:number;readonly sha256:string}
function persistedFiles(value:unknown):ManifestFile[] {
  if(!array(value))fail("inventory-refused");const source=value as readonly unknown[];
  if(source.length<2||source.length>MAX_SITE_FILES)fail("inventory-refused");const result:ManifestFile[]=[],seen=new Set<string>();let total=0;
  for(const item of source){const source=record(item,["path","bytes","sha256"]),path=source["path"],bytes=source["bytes"],sha256=source["sha256"];
    if(typeof path!=="string"||!allowed(path)||seen.has(path)||typeof bytes!=="number"||!Number.isSafeInteger(bytes)||bytes<0||bytes>maximum(path)||typeof sha256!=="string"||!/^[0-9a-f]{64}$/.test(sha256))fail("inventory-refused");seen.add(path);total+=bytes;if(total>STORE_LIMITS.maxTreeBytes)fail("inventory-refused");result.push({path,bytes,sha256});}
  if(!seen.has("index.html")||!seen.has("site.json"))fail("inventory-refused");return result;
}
function preparedBytes(captured:StagedSite):Uint8Array|undefined {
  const descriptor=captured.preparedPayload;if(descriptor===undefined)return undefined;
  const capsuleBytes=inventory(captured).byteLength;if(capsuleBytes+descriptor.bytes>MAX_CAPSULE_BYTES)fail("inventory-refused");
  const path=join(captured.taskRoot,"prepared.json"),expected=captured.identities.find(item=>item.path===path);if(expected===undefined)fail("inventory-refused");
  const bytes=readBoundedFile(path,descriptor.bytes);if(bytes.byteLength!==descriptor.bytes||hash(bytes)!==descriptor.sha256)fail("payload-changed");
  checkDirectories(captured.directories);if(!same(regular(path),expected))fail("file-changed");return bytes;
}
/** A bounded reader's close is an acquisition boundary; retain the original file authority. */
function checkRetainedFiles(captured:StagedSite):void {
  checkDirectories(captured.directories);for(const expected of captured.identities)if(!same(regular(expected.path),expected))fail("file-changed");
}
/** The trusted step digest pins content; a replaced byte-identical state inode is equivalent.
 * Its fresh inode is retained during this read. Header identities still pin every directory,
 * upload file and payload. An in-process stage proof continues to pin its original state inode.
 */
export function readStagedSite(capsulePath:string,capsuleSha256:string,expectedRunnerTemp:string):StagedSite {
  return safe(()=>{
    const anchor=absolute(expectedRunnerTemp),capsule=absolute(capsulePath),taskRoot=dirname(capsule),uploadRoot=join(taskRoot,"upload");location(anchor,taskRoot,uploadRoot,capsule);
    if(typeof capsuleSha256!=="string"||!/^[0-9a-f]{64}$/.test(capsuleSha256))fail("inventory-refused");
    const parents=chain(capsule),before=identity(capsule,regular(capsule)),bytes=readBoundedFile(capsule,MAX_CAPSULE_BYTES);
    checkDirectories(parents);if(!same(regular(capsule),before)||hash(bytes)!==capsuleSha256)fail("capsule-changed");
    const document=record(parseJson(bytes,{maxBytes:MAX_CAPSULE_BYTES,maxDepth:8}),["schemaVersion","taskRoot","uploadRoot","capsulePath","prefix","directories","identities","files"],["preparedPayload"]);
    if(document["schemaVersion"]!==1||document["taskRoot"]!==taskRoot||document["uploadRoot"]!==uploadRoot||document["capsulePath"]!==capsule||typeof document["prefix"]!=="string")fail("inventory-refused");
    const sitePrefix=prefix(document["prefix"]),metadata=Object.hasOwn(document,"preparedPayload")?record(document["preparedPayload"],["bytes","sha256"]):undefined,preparedPayload=payloadDescriptor(metadata);
    if(bytes.byteLength+(preparedPayload?.bytes??0)>MAX_CAPSULE_BYTES)fail("inventory-refused");
    const directories=persistedIdentities(document["directories"],MAX_DIRECTORIES),manifest=persistedFiles(document["files"]),persisted=persistedIdentities(document["identities"],MAX_SITE_FILES+1);
    if(persisted.some(item=>item.path===capsule))fail("inventory-refused");const identities=[...persisted,before];
    layout(anchor,taskRoot,uploadRoot,capsule,sitePrefix,directories,identities,manifest.map(file=>file.path),preparedPayload);
    const files:SiteFile[]=manifest.map(file=>{const bytes=readBoundedFile(join(uploadRoot,...sitePrefix.split("/"),...file.path.split("/")),file.bytes);if(bytes.byteLength!==file.bytes||hash(bytes)!==file.sha256)fail("file-changed");return Object.freeze({path:file.path,bytes,sha256:file.sha256});});
    const staged=Object.freeze({taskRoot,uploadRoot,capsulePath:capsule,capsuleSha256,prefix:sitePrefix,directories:Object.freeze(directories),identities:Object.freeze(identities),files:Object.freeze(files),...(preparedPayload===undefined?{}:{preparedPayload})});
    verifyStagedSite(staged,anchor);checkRetainedFiles(staged);checkDirectories(parents);if(!same(regular(capsule),before))fail("file-changed");return staged;
  });
}
export function readPreparedPayload(staged:StagedSite,anchor:string):Uint8Array|undefined {
  return safe(()=>{const captured=task(staged,anchor);verifyStagedSite(captured,anchor);const result=preparedBytes(captured);checkRetainedFiles(captured);return result;});
}
export function verifyStagedSite(value:StagedSite,expectedRunnerTemp:string):void {
  safe(()=>{const captured=task(value,expectedRunnerTemp),entries=collect(captured.taskRoot,captured.directories),expected=new Set(captured.identities.map(item=>item.path));
    if(entries.files.length!==expected.size||entries.files.some(item=>!expected.has(item.path)))fail("inventory-refused");
    const expectedDirectories=new Set(captured.directories.filter(item=>item.path===captured.taskRoot||inside(captured.taskRoot,item.path)).map(item=>item.path));
    if(entries.directories.length!==expectedDirectories.size||entries.directories.some(item=>!expectedDirectories.has(item.path)))fail("inventory-refused");
    const expectedCapsule=inventory(captured),actualCapsule=readBoundedFile(captured.capsulePath,expectedCapsule.byteLength);
    if(actualCapsule.byteLength!==expectedCapsule.byteLength||hash(expectedCapsule)!==captured.capsuleSha256||hash(actualCapsule)!==captured.capsuleSha256)fail("capsule-changed");
    preparedBytes(captured);
    for(const file of captured.files){const bytes=readBoundedFile(join(captured.uploadRoot,...captured.prefix.split("/"),...file.path.split("/")),Math.min(maximum(file.path),file.bytes.byteLength));if(bytes.byteLength!==file.bytes.byteLength||hash(bytes)!==file.sha256)fail("file-changed");}
    checkRetainedFiles(captured);
  });
}
export function cleanupStagedSite(value:StagedSite,expectedRunnerTemp:string):void {
  safe(()=>{const captured=task(value,expectedRunnerTemp);verifyStagedSite(captured,expectedRunnerTemp);removeOwned(captured.taskRoot,captured.directories);issuedOutputs.delete(captured.uploadRoot);issuedOutputs.delete(captured.capsulePath);});
}
/** A complete bounded key/value block is captured before opening the runner output file. */
export function appendOutputs(path:string,values:Readonly<Record<string,string>>):void {
  safe(()=>{
    const keys=Object.keys(values),allowedKeys=new Set(["project","stored","projection","prepared","upload_root","capsule","capsule_sha256"]);if(keys.length===0||keys.length>7||keys.some(key=>!allowedKeys.has(key)))fail("output-refused");
    const parents=chain(path),originalOutput=identity(path,regular(path)),lines:string[]=[],proofs:IssuedOutput[]=[],capturedValues=new Map<string,string>();
    for(const key of keys){const value=values[key];if(typeof value!=="string"||value.length>4096||!value.isWellFormed()||encoder.encode(value).byteLength>4096||controls(value))fail("output-refused");
      if((key==="project"||key==="stored"||key==="prepared")&&value!=="true"&&value!=="false")fail("output-refused");if(key==="projection"&&!["pending","not-retained","not-attempted"].includes(value))fail("output-refused");
      if(key==="upload_root"||key==="capsule"){const issued=issuedOutputs.get(value);if(issued===undefined||issued.kind!==key)fail("output-refused");proofs.push(issued);}capturedValues.set(key,value);lines.push(`${key}=${value}\n`);}
    const digest=capturedValues.get("capsule_sha256");if(digest!==undefined){const capsule=capturedValues.get("capsule"),issued=capsule===undefined?undefined:issuedOutputs.get(capsule);if(!/^[0-9a-f]{64}$/.test(digest)||issued?.kind!=="capsule"||issued.staged.capsuleSha256!==digest||proofs.some(proof=>proof.staged!==issued.staged))fail("output-refused");}
    // Recognized value getters may replace an earlier path. Nothing foreign is reread after this proof.
    const verified=new Set<StagedSite>();for(const issued of proofs){if(!verified.has(issued.staged)){verifyStagedSite(issued.staged,issued.runnerTemp);verified.add(issued.staged);}}
    checkDirectories(parents);if(!same(regular(path),originalOutput))fail("file-changed");
    const body=encoder.encode(lines.join("")),handle=opened(path,constants.O_WRONLY|constants.O_APPEND,parents);
    try {if(!same(handle.stat,originalOutput)||handle.stat.size+BigInt(body.byteLength)>BigInt(MAX_OUTPUT_BYTES))fail("output-refused");for(let offset=0;offset<body.byteLength;){const count=writeSync(handle.fd,body,offset,body.byteLength-offset);if(count===0)fail("output-refused");offset+=count;}checkDirectories(parents);if(!same(regular(path),identity(path,handle.stat)))fail("file-changed");}
    finally{closeSync(handle.fd);}
    checkDirectories(parents);if(!same(regular(path),originalOutput))fail("file-changed");for(const staged of verified)checkRetainedFiles(staged);
  });
}

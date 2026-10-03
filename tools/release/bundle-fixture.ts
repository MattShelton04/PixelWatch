/** Compiler acceptance input only. This is never a publisher or a product simulation. */
export const COMPILER_HOST_FIXTURE = `
import { PngWorker, COMPARATOR_V1, pixelHash, pngErrorCode } from "../../../packages/core/src/index.ts";
declare const __PIXELWATCH_VERSION__: string;
declare const __PIXELWATCH_SOURCE_COMMIT__: string;
export const version = __PIXELWATCH_VERSION__;
export const sourceCommit = __PIXELWATCH_SOURCE_COMMIT__;
export async function codecProbe() {
  const worker = new PngWorker({workerUrl: new URL('./png-worker.js', import.meta.url)});
  const image = {width:2,height:2,channels:3 as const,data:Uint8Array.of(1,2,3,4,5,6,7,8,9,10,11,12)};
  try {
    const png = await worker.encode(image); const decoded = await worker.decode(png);
    const same = await worker.compare(image, decoded, COMPARATOR_V1);
    const other = {...image,data:Uint8Array.from(image.data)}; other.data[0] = 255;
    const changed = await worker.compare(image, other, COMPARATOR_V1);
    let refused = ''; try {await worker.decode(Uint8Array.of(1,2,3));} catch (error) {refused=pngErrorCode(error) ?? 'unknown';}
    const controller = new AbortController(); controller.abort();
    let cancelled = ''; try {await worker.encode(image,{signal:controller.signal});} catch(error) {cancelled=pngErrorCode(error) ?? 'unknown';}
    return {version,sourceCommit,hash:pixelHash(decoded),originalHash:pixelHash(image),pixels:Array.from(decoded.data),same:same.status,changed:changed.status,refused,cancelled};
  } finally {await worker.close();}
}
if(process.argv[2] === '--codec-probe') process.stdout.write(JSON.stringify(await codecProbe()));
`;

/** Native-free compiler response, solely to exercise the actual CLI's directory ownership. */
export const CLI_PATH_PROBE_FIXTURE = String.raw`
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute,sep} from 'node:path';
const taskRoot=fs.mkdtempSync(join(tmpdir(),'pixelwatch-release-build-'));
const sourceRoot=join(taskRoot,'source');const externalRoot=join(taskRoot,'external');
fs.mkdirSync(join(sourceRoot,'actions/publish/src'),{recursive:true});fs.mkdirSync(externalRoot);
fs.writeFileSync(join(sourceRoot,'actions/publish/src/main.ts'),'export {};\n');
fs.writeFileSync(join(sourceRoot,'actions/publish/package.json'),'{"type":"module"}\n');
const compiler=JSON.stringify({artifacts:['app.js','index.js','png-worker.js'].map(path=>({path,base64:Buffer.from('export {};\n').toString('base64')})),dependencies:[]});
const originalExec=childProcess.execFile;const originalWrite=fs.writeFileSync;
childProcess.execFile=function(...args){queueMicrotask(()=>args.at(-1)(null,compiler,''));return {stdin:{on(){},end(){}}};};
const version='0.1.0-rc.1';const sourceCommit='a'.repeat(40);
const output=join(sourceRoot,'.tools/release-build',version+'-'+sourceCommit);
const movedTools=join(externalRoot,'moved-tools');let mutated=false;
fs.writeFileSync=function(path,...args){if(String(path)===join(output,'app.js')){
 mutated=true;fs.renameSync(join(sourceRoot,'.tools'),movedTools);fs.symlinkSync(movedTools,join(sourceRoot,'.tools'),'junction');throw new Error('private fixture write refusal');
}return Reflect.apply(originalWrite,fs,[path,...args]);};
syncBuiltinESMExports();
let failure;
try {
 const {writePublisherArtifacts}=await import(process.argv[1]);
 try{await writePublisherArtifacts({sourceRoot,version,sourceCommit});}catch(error){failure=error;}
 const preserved=fs.existsSync(join(movedTools,'release-build',version+'-'+sourceCommit));
 const result={mutated,createdOutputPreserved:preserved,cleanupRefused:failure instanceof Error&&failure.message==='PixelWatch release: output-cleanup-failed',nativeProcesses:0};
 process.stdout.write(JSON.stringify(result));
 assert.deepEqual(result,{mutated:true,createdOutputPreserved:true,cleanupRefused:true,nativeProcesses:0});
} finally {
 childProcess.execFile=originalExec;fs.writeFileSync=originalWrite;syncBuiltinESMExports();
 const junction=join(sourceRoot,'.tools');if(fs.existsSync(junction)&&fs.lstatSync(junction).isSymbolicLink())fs.unlinkSync(junction);
 const rel=relative(resolve(tmpdir()),resolve(taskRoot));
 assert.equal(isAbsolute(rel)||rel.startsWith('..'+sep)||rel==='..'||!/^pixelwatch-release-build-[A-Za-z0-9_-]+$/.test(rel),false);
 assert.equal(fs.realpathSync(taskRoot),resolve(taskRoot));fs.rmSync(taskRoot,{recursive:true,force:false});
}
`;

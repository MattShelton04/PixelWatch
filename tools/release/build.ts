import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalBytes } from "../../packages/schemas/src/canonical.ts";

export type ArtifactPath = "index.js" | "png-worker.js" | "app.js" | "release.json";
export interface ReleaseArtifact { readonly path: ArtifactPath; readonly bytes: Uint8Array; readonly sha256: string }
export interface BuildInput { readonly sourceRoot: string; readonly version: string; readonly sourceCommit: string }
interface Dependency { readonly name: string; readonly version: string; readonly license: string }
interface CompilerOutput { readonly artifacts: readonly {readonly path: string; readonly base64: string}[]; readonly dependencies: readonly Dependency[] }
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMPILER_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);

function fail(code: string): never { throw new Error(`PixelWatch release: ${code}`); }

/** Capture only the three trusted inputs. Invalid values never enter child arguments or logs. */
export function releaseBuildInput(input: BuildInput): Readonly<BuildInput> {
  try {
    const { sourceRoot, version, sourceCommit } = input;
    if (typeof version !== "string" || version.length > 40 || !/^0\.1\.0(?:-rc\.[1-9][0-9]{0,18})?$/.test(version)) fail("version-invalid");
    if (typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit)) fail("source-commit-invalid");
    if (typeof sourceRoot !== "string" || sourceRoot.length > 4096 || !isAbsolute(sourceRoot) || sourceRoot.includes("\0")) fail("source-root-invalid");
    const root = lstatSync(sourceRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) fail("source-root-invalid");
    return Object.freeze({sourceRoot:realpathSync(sourceRoot), version, sourceCommit});
  } catch { return fail("input-invalid"); }
}

// The guard is awaited BEFORE importing esbuild. Its service subprocess inherits only this
// compiler process's allowlisted environment, never the credential-bearing parent environment.
// Build code is supplied by this trusted tool; sourceRoot contains compilation inputs only.
const COMPILER = String.raw`
await import(process.argv[1]);
const esbuild = await import(process.argv[2]);
const {readFileSync,existsSync,lstatSync} = await import('node:fs');
const {dirname,join,resolve,relative,sep} = await import('node:path');
const {isBuiltin,createRequire} = await import('node:module');
let request=''; for await (const part of process.stdin) {request+=part; if(request.length>16384) throw new Error('request-bound');}
const input=JSON.parse(request); const root=input.sourceRoot;
if(esbuild.version!=='0.28.2') throw new Error('compiler-version');
const dependencies=new Map(); const notices=new Map();
function includeDependency(manifest){
 const info=JSON.parse(readFileSync(manifest,'utf8'));
 if(typeof info.name!=='string'||typeof info.version!=='string'||typeof info.license!=='string'||info.license.length===0) throw new Error('dependency-license');
 const key=info.name+'@'+info.version; const prior=dependencies.get(info.name);
 if(prior&&prior.version!==info.version) throw new Error('dependency-ambiguous');
 dependencies.set(info.name,{name:info.name,version:info.version,license:info.license});
 for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license','LICENSE-MIT']) {
  const path=join(dirname(manifest),name); if(!existsSync(path)) continue;
  const stat=lstatSync(path); if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024) throw new Error('license-bound');
  const text=readFileSync(path,'utf8').replaceAll('\r\n','\n');
  if(text.includes('*/')) throw new Error('license-comment');
  notices.set(key,'/*! PixelWatch bundled dependency: '+key+'\n'+text+'\n*/\n'); return;
 }
 throw new Error('dependency-license-missing');
}
function inventory(meta){
 for(const output of Object.values(meta.outputs)) {
  for(const dependency of output.imports) if(dependency.external&&!isBuiltin(dependency.path)) throw new Error('runtime-external');
  for(const [path,contribution] of Object.entries(output.inputs)) {
   if(contribution.bytesInOutput===0||!path.replaceAll('\\','/').includes('node_modules/')) continue;
   let directory=dirname(resolve(root,path));
   for(let depth=0;depth<32;depth++) {
    const manifest=join(directory,'package.json');
    if(existsSync(manifest)){includeDependency(manifest);break;}
    const parent=dirname(directory);if(parent===directory) throw new Error('dependency-manifest');directory=parent;
    if(depth===31) throw new Error('dependency-depth');
   }
  }
 }
}
const workspace={name:'pixelwatch-workspace',setup(build){build.onResolve({filter:/^@pixelwatch\//},({path})=>{
 const entries={core:'packages/core/src/index.ts',schemas:'packages/schemas/src/index.ts','schemas/browser':'packages/schemas/src/browser.ts',viewer:'packages/viewer/src/index.ts',publisher:'packages/publisher/src/index.ts',store:'packages/store/src/index.ts','forge-github':'packages/forge-github/src/index.ts'};
 const selected=entries[path.slice('@pixelwatch/'.length)]; if(!selected) throw new Error('workspace-export'); return {path:join(root,selected)};
});}};
const definitions={__PIXELWATCH_VERSION__:JSON.stringify(input.version),__PIXELWATCH_SOURCE_COMMIT__:JSON.stringify(input.sourceCommit),__PIXELWATCH_RELEASE__:JSON.stringify(input.version)};
const outputs=[];
try {
 for(const [path,entry,platform,format,target,minify] of [
  ['index.js','actions/publish/src/main.ts','node','esm','node24',false],
  ['png-worker.js','packages/core/src/png/worker.ts','node','esm','node24',false],
  ['app.js','packages/viewer/src/client.ts','browser','iife','es2022',true]]) {
  const result=await esbuild.build({absWorkingDir:root,entryPoints:[entry],outfile:path,bundle:true,write:false,platform,format,target,minify,
   define:definitions,plugins:[workspace],metafile:true,legalComments:'inline',charset:'utf8',logLevel:'silent',sourcemap:false});
  if(result.outputFiles.length!==1) throw new Error('output-count'); inventory(result.metafile);
  outputs.push({path,bytes:result.outputFiles[0].contents});
 }
 // The generated static viewer validators contain the pinned Ajv and deep-equality helpers
 // already bundled by the schema generator; their provenance is not a new runtime import.
 const schemasRequire=createRequire(join(root,'packages/schemas/package.json'));
 const ajvManifest=schemasRequire.resolve('ajv/package.json'); includeDependency(ajvManifest);
 includeDependency(createRequire(ajvManifest).resolve('fast-deep-equal/package.json'));
 const licence=readFileSync(join(root,'LICENSE'),'utf8').replaceAll('\r\n','\n'); if(licence.includes('*/')||licence.length>1024*1024) throw new Error('product-license');
 const footer='\n/*! PixelWatch product licence\n'+licence+'\n*/\n'+[...notices.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,text])=>text).join('');
 const artifacts=outputs.map(({path,bytes})=>({path,base64:Buffer.concat([bytes,Buffer.from(footer)]).toString('base64')})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const result=JSON.stringify({artifacts,dependencies:[...dependencies.values()].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)});
 if(Buffer.byteLength(result)>16*1024*1024) throw new Error('output-bound'); process.stdout.write(result);
} catch {process.stderr.write('PixelWatch release: compiler-refused\n');process.exitCode=1;}
finally {esbuild.stop();}
`;

function compile(input: Readonly<BuildInput>): Promise<CompilerOutput> {
  const guard = new URL("../lib/no-network.ts", import.meta.url).href;
  const compiler = pathToFileURL(require.resolve("esbuild")).href;
  // No spread/enumeration of process.env, NODE_OPTIONS, compiler override or token lookup.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--input-type=module", "-e", COMPILER, guard, compiler],
      {cwd:input.sourceRoot, env, windowsHide:true, timeout:COMPILER_TIMEOUT_MS, maxBuffer:16*1024*1024, encoding:"utf8"},
      (error, stdout, stderr) => {
        if (error !== null || stderr.length !== 0) { reject(new Error("PixelWatch release: compiler-refused")); return; }
        try { resolve(JSON.parse(stdout) as CompilerOutput); }
        catch { reject(new Error("PixelWatch release: compiler-output-invalid")); }
      });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(input));
  });
}

function artifact(path: ArtifactPath, bytes: Uint8Array): ReleaseArtifact {
  const owned = Buffer.from(bytes);
  return Object.freeze({path, sha256:createHash("sha256").update(owned).digest("hex"), get bytes() { return Buffer.from(owned); }});
}

/** Offline compilation only: no artifact is written, no release or Git operation occurs. */
export async function buildPublisherArtifacts(input: BuildInput): Promise<readonly ReleaseArtifact[]> {
  const captured = releaseBuildInput(input);
  try {
    const host = lstatSync(join(captured.sourceRoot,"actions/publish/src/main.ts"));
    if (!host.isFile() || host.isSymbolicLink()) fail("action-source-missing");
  } catch { return fail("action-source-missing"); }
  try {
    const module = JSON.parse(readFileSync(join(captured.sourceRoot,"actions/publish/package.json"),"utf8")) as {type?:unknown};
    if (module.type !== "module") fail("action-module-invalid");
  } catch { return fail("action-module-invalid"); }
  const result = await compile(captured);
  try {
    if (!Array.isArray(result.artifacts) || result.artifacts.length !== 3 || !Array.isArray(result.dependencies)) fail("compiler-output-invalid");
    const expected = ["app.js", "index.js", "png-worker.js"] as const;
    let bytes = 0;
    const files = result.artifacts.map((entry: CompilerOutput["artifacts"][number], index: number) => {
      if (entry.path !== expected[index] || typeof entry.base64 !== "string" || entry.base64.length > 12*1024*1024) fail("compiler-output-invalid");
      const decoded = Buffer.from(entry.base64,"base64"); bytes += decoded.byteLength;
      if (decoded.length === 0 || bytes > MAX_OUTPUT_BYTES || decoded.toString("base64") !== entry.base64) fail("compiler-output-invalid");
      return artifact(expected[index], decoded);
    });
    const dependencies = result.dependencies.map(({name,version,license}) => {
      if (typeof name !== "string" || name.length > 214 || typeof version !== "string" || version.length > 100 || typeof license !== "string" || license.length > 1024 || license.length === 0) fail("compiler-output-invalid");
      return {name,version,license};
    });
    const metadata = canonicalBytes({schemaVersion:1, version:captured.version, sourceCommit:captured.sourceCommit, target:"node24",
      artifacts:files.map(({path,bytes,sha256})=>({path,bytes:bytes.byteLength,sha256})),dependencies});
    return Object.freeze([...files,artifact("release.json",metadata)]);
  } catch { return fail("compiler-output-invalid"); }
}

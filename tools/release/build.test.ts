import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { canonicalBytes } from "../../packages/schemas/src/index.ts";
import { siteUrls } from "../../packages/core/src/index.ts";
import { renderEntry } from "../../packages/viewer/src/entry.ts";
import { assertNoSecrets, CANARY_TOKEN, SIGNED_URL } from "../simulation/capture.ts";
import { buildPublisherArtifacts, type ReleaseArtifact } from "./build.ts";
import { writePublisherArtifacts } from "./build-cli.ts";
import { CLI_PATH_PROBE_FIXTURE, COMPILER_HOST_FIXTURE } from "./bundle-fixture.ts";

const source = fileURLToPath(new URL("../..", import.meta.url));
const commit = "b382cb098dd5c1f6b6881d35de87b80107f6185f";
const version = "0.1.0-rc.1";
const roots: string[] = []; const raw: (string | Uint8Array)[] = [];
const inventories: {root:string;version:string;artifacts:{path:string;bytes:number;sha256:string}[]}[]=[];
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function record(value: string | Uint8Array): void { assertNoSecrets([value]); raw.push(value); }
function runtimeDependencies(target: string): void {
  const copied = new Set<string>();
  const copy = (name: string, from: string): void => {
    if (copied.has(name)) return;
    const manifest = realpathSync(createRequire(from).resolve(`${name}/package.json`));
    const metadata = JSON.parse(readFileSync(manifest, "utf8")) as {dependencies?: Record<string, string>};
    copied.add(name);
    const destination = join(target, "node_modules", name);
    mkdirSync(dirname(destination), {recursive:true});
    // Copy the pinned runtime package once, without pnpm links or any dev dependency graph.
    cpSync(dirname(manifest), destination, {recursive:true, filter: (path) => basename(path) !== "node_modules"});
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copy(dependency, manifest);
  };
  copy("ajv", join(source, "packages/schemas/package.json"));
}
function root(host = true): string {
  const target = mkdtempSync(join(tmpdir(), "pixelwatch-release-build-")); roots.push(target);
  for (const pkg of ["core", "schemas", "viewer"]) {
    const directory = join(target, "packages", pkg); mkdirSync(directory, {recursive:true});
    cpSync(join(source,"packages",pkg,"src"),join(directory,"src"),{recursive:true,filter:(path)=>!path.endsWith(".test.ts")});
    cpSync(join(source,"packages",pkg,"package.json"),join(directory,"package.json"));
  }
  cpSync(join(source,"packages/schemas/schemas"),join(target,"packages/schemas/schemas"),{recursive:true});
  runtimeDependencies(target);
  cpSync(join(source,"package.json"),join(target,"package.json")); cpSync(join(source,"LICENSE"),join(target,"LICENSE"));
  const action = join(target,"actions","publish"); mkdirSync(join(action,"src"),{recursive:true});
  writeFileSync(join(action,"package.json"),'{"type":"module"}\n');
  if (host) writeFileSync(join(action,"src","main.ts"),COMPILER_HOST_FIXTURE);
  return target;
}
function file(files: readonly ReleaseArtifact[], path: string): ReleaseArtifact {
  const found=files.find((entry)=>entry.path===path); if(found===undefined) throw new Error("missing test artifact"); return found;
}
async function build(rootPath: string, release=version): Promise<readonly ReleaseArtifact[]> {
  const result=await buildPublisherArtifacts({sourceRoot:rootPath,version:release,sourceCommit:commit});
  for(const entry of result) record(entry.bytes);
  inventories.push({root:rootPath===firstRoot?"first":rootPath===secondRoot?"second":"other",version:release,artifacts:result.map(({path,bytes,sha256})=>({path,bytes:bytes.byteLength,sha256}))});
  return result;
}
async function refusal(operation: ()=>Promise<unknown>): Promise<Error> {
  try {await operation();} catch(error) {
    if(!(error instanceof Error)) throw new Error("test expected fixed Error", {cause:error}); record(error.stack ?? error.message);
    expect(error.message).toMatch(/^PixelWatch release: [a-z-]+$/); return error;
  }
  throw new Error("test expected refusal");
}
let firstRoot: string; let secondRoot: string;
beforeAll(()=>{firstRoot=root();secondRoot=root();});
afterAll(()=>{
  const logDir=join(source,".tools","logs");mkdirSync(logDir,{recursive:true});
  const inventoryBytes=JSON.stringify({productionHost:false,sourceCommit:commit,builds:inventories});record(inventoryBytes);
  writeFileSync(join(logDir,"release-build-inventories.json"),inventoryBytes);
  assertNoSecrets(raw);writeFileSync(join(logDir,"release-build-raw-scan.json"),JSON.stringify({values:raw.length,bytes:raw.reduce((n,v)=>n+(typeof v==="string"?Buffer.byteLength(v):v.byteLength),0),failures:0}));
  for(const directory of roots) {
    const absolute=resolve(directory); if(!absolute.startsWith(resolve(tmpdir())+sep)||!absolute.split(sep).at(-1)?.startsWith("pixelwatch-release-build-")||lstatSync(absolute).isSymbolicLink()) throw new Error("test cleanup path refused");
    rmSync(absolute,{recursive:true,force:false});
  }
});

describe("trusted release build tooling (compiler fixture, production host pending)",()=>{
  it("missing production action source refuses before creating release artifacts",async()=>{
    const directory=root(false); const error=await refusal(()=>build(directory));
    expect(error.message).toBe("PixelWatch release: action-source-missing");expect(existsSync(join(directory,".tools"))).toBe(false);
  });
  it("two isolated builds have identical complete artifact hashes",async()=>{
    const one=await build(firstRoot);const two=await build(secondRoot);
    expect(one.map(({path,sha256})=>({path,sha256}))).toEqual(two.map(({path,sha256})=>({path,sha256})));
    expect(one.map(({path})=>path)).toEqual(["app.js","index.js","png-worker.js","release.json"]);
    for(const artifact of one) expect(artifact.sha256).toBe(hash(artifact.bytes));
    const owned=file(one,"index.js").bytes;owned.fill(0);expect(file(one,"index.js").sha256).toBe(hash(file(one,"index.js").bytes));
    expect(Object.isFrozen(one)).toBe(true);expect(one.every(Object.isFrozen)).toBe(true);
  });
  it("release metadata records the exact RC or final version and approved source SHA",async()=>{
    for(const release of [version,"0.1.0"]){
      const files=await build(firstRoot,release);const bytes=file(files,"release.json").bytes;
      const metadata=JSON.parse(Buffer.from(bytes).toString("utf8")) as {schemaVersion:number;version:string;sourceCommit:string;target:string;artifacts:{path:string;bytes:number;sha256:string}[];dependencies:{name:string;version:string;license:string}[]};
      expect(metadata).toMatchObject({schemaVersion:1,version:release,sourceCommit:commit,target:"node24"});expect(bytes).toEqual(canonicalBytes(metadata));
      expect(metadata.artifacts.map((a)=>a.path)).toEqual(["app.js","index.js","png-worker.js"]);
      for(const entry of metadata.artifacts){const actual=file(files,entry.path);expect(entry.bytes).toBe(actual.bytes.byteLength);expect(entry.sha256).toBe(actual.sha256);}
      expect(metadata.dependencies.length).toBeGreaterThan(0);for(const dep of metadata.dependencies){expect(dep.name).toMatch(/^[@a-z]/);expect(dep.version).toMatch(/^\d+\./);expect(dep.license.length).toBeGreaterThan(0);}
      expect(Buffer.from(file(files,"index.js").bytes).toString("utf8")).toContain(release);
    }
  });
  it("bundled production PNG worker decodes encodes and compares without source TypeScript",async()=>{
    const files=await build(firstRoot);const standalone=mkdtempSync(join(tmpdir(),"pixelwatch-release-build-"));roots.push(standalone);
    writeFileSync(join(standalone,"package.json"),'{"type":"module"}\n');for(const entry of files) writeFileSync(join(standalone,entry.path),entry.bytes);
    // The existing no-network guard is compiled separately as test setup, never a release artifact.
    const guard=join(standalone,"guard.mjs");
    const guardUrl=pathToFileURL(join(source,"tools/lib/no-network.ts")).href;
    const compiler=spawnSync(process.execPath,["--input-type=module","-e",`await import(${JSON.stringify(guardUrl)});const {buildSync}=await import('esbuild');const r=buildSync({entryPoints:[${JSON.stringify(join(source,"tools/lib/no-network.ts"))}],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});process.stdout.write(r.outputFiles[0].contents);`],{cwd:source,env:{},timeout:60000,maxBuffer:1024*1024,windowsHide:true});
    record(compiler.stdout);record(compiler.stderr);expect(compiler.status).toBe(0);writeFileSync(guard,compiler.stdout);
    const result=spawnSync(process.execPath,["--import",pathToFileURL(guard).href,join(standalone,"index.js"),"--codec-probe"],{cwd:standalone,env:{},timeout:60000,maxBuffer:1024*1024,windowsHide:true});
    record(result.stdout);record(result.stderr);
    writeFileSync(join(source,".tools/logs/release-build-standalone-runtime.json"),JSON.stringify({status:result.status,stdout:result.stdout.toString("utf8"),stderr:result.stderr.toString("utf8")}));
    expect(result.status).toBe(0);
    const probe=JSON.parse(result.stdout.toString("utf8")) as {hash:string;originalHash:string};
    expect(probe).toMatchObject({version,sourceCommit:commit,pixels:[1,2,3,4,5,6,7,8,9,10,11,12],same:"unchanged",changed:"changed",cancelled:"aborted"});expect(probe.hash).toBe(probe.originalHash);
    expect(readdirSync(standalone).some((name)=>name.endsWith(".ts")||name==="node_modules")).toBe(false);
  });
  it("bundled final viewer declares the exact release and uses generated entry CSP SRI",async()=>{
    const files=await build(firstRoot);const script=file(files,"app.js").bytes;
    const html=renderEntry({urls:siteUrls({pagesUrl:"https://fixture.github.io/review/",expectedHost:"fixture.github.io",prefix:"pixelwatch"}),repository:{repositoryId:"101",owner:"fixture",name:"review"},assets:{release:version,script}});
    record(html);const text=Buffer.from(html).toString("utf8");const digest=createHash("sha256").update(script).digest("base64");
    expect(text).toContain(`script-src 'sha256-${digest}'`);expect(text).toContain(`integrity="sha256-${digest}"`);expect(text).toContain(`app/${version}/app.js`);
    expect(Buffer.from(script).toString("utf8")).toContain(version);runInNewContext(Buffer.from(script).toString("utf8"),{URL,TextEncoder,TextDecoder,Uint8Array});
  });
  it("release outputs contain no absolute source paths dynamic TS loader or unbundled dependency",async()=>{
    const files=await build(firstRoot);
    for(const entry of files){const text=Buffer.from(entry.bytes).toString("utf8");expect(text).not.toContain(firstRoot);expect(text).not.toContain(source);expect(text).not.toMatch(/(?:from|import\(|require\()\s*["'][^"']+\.ts["']/);expect(text).not.toMatch(/sourceMappingURL|ts-node|tsx\/|__require\(["'][^"']+(?<!node:)["']\)/);}
    expect(existsSync(join(firstRoot,"actions/publish/dist"))).toBe(false);
  });
  it("invalid versions short SHAs and unsafe output paths refuse without replacing files",async()=>{
    const output=join(firstRoot,".tools/release-build",`${version}-${commit}`);mkdirSync(output,{recursive:true});writeFileSync(join(output,"keep.txt"),"preserve");
    for(const release of ["0.2.0","0.1.0-rc.0","../escape","C:\\escape",`${CANARY_TOKEN}${SIGNED_URL}`]) await refusal(()=>writePublisherArtifacts({sourceRoot:firstRoot,version:release,sourceCommit:commit}));
    for(const sha of ["abc",commit.toUpperCase(),"../"+commit]) await refusal(()=>writePublisherArtifacts({sourceRoot:firstRoot,version,sourceCommit:sha}));
    await refusal(()=>writePublisherArtifacts({sourceRoot:firstRoot,version,sourceCommit:commit}));expect(readFileSync(join(output,"keep.txt"),"utf8")).toBe("preserve");expect(readdirSync(output)).toEqual(["keep.txt"]);
    const outside=join(firstRoot,"outside");mkdirSync(outside);const cli=spawnSync(process.execPath,[join(source,"tools/release/build-cli.ts"),"--source-root",firstRoot,"--version",version,"--source-commit",commit,"--output",outside],{env:{},timeout:60000,maxBuffer:1024*1024,windowsHide:true});
    record(cli.stdout);record(cli.stderr);expect(cli.status).toBe(1);expect(readdirSync(outside)).toEqual([]);
  });
  it("compiler subprocesses never inspect or inherit ambient credential keys",async()=>{
    const original=process.env;let touched=0;
    const trapped=new Proxy(original,{get(target,key){if(key==="GH_TOKEN"||key==="GITHUB_TOKEN"){touched++;throw new Error(CANARY_TOKEN+SIGNED_URL);}return typeof key==="string"?target[key]:undefined;},ownKeys(){touched++;throw new Error(CANARY_TOKEN+SIGNED_URL);}});
    let files:readonly ReleaseArtifact[]|undefined;try{process.env=trapped;files=await build(firstRoot);}finally{process.env=original;}
    expect(touched).toBe(0);expect(files.length).toBe(4);
  });
  it("replaced output ancestors refuse recursive cleanup without removing external directories",()=>{
    const guard=pathToFileURL(join(source,"tools/lib/no-network.ts")).href;
    const cli=pathToFileURL(join(source,"tools/release/build-cli.ts")).href;
    const result=spawnSync(process.execPath,["--import",guard,"--input-type=module","-e",CLI_PATH_PROBE_FIXTURE,cli],{cwd:source,env:{},timeout:60000,maxBuffer:1024*1024,windowsHide:true});
    record(result.stdout);record(result.stderr);expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({mutated:true,createdOutputPreserved:true,cleanupRefused:true,nativeProcesses:0});
  });
});

import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublisherArtifacts, releaseBuildInput, type BuildInput } from "./build.ts";

function fail(): never { throw new Error("PixelWatch release: output-refused"); }
interface DirectoryIdentity {readonly path:string;readonly stat:Stats}
function identity(path:string):DirectoryIdentity {
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)fail();
  return {path,stat};
}
function verifyChain(chain:readonly DirectoryIdentity[]):void {
  for(const owned of chain){const current=identity(owned.path);if(current.stat.dev!==owned.stat.dev||current.stat.ino!==owned.stat.ino)fail();}
}
function directory(path: string, chain:DirectoryIdentity[]): void {
  verifyChain(chain);
  try { mkdirSync(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") fail();
  }
  const captured=identity(path);const prior=chain.find(item=>item.path===path);
  if(prior!==undefined){if(captured.stat.dev!==prior.stat.dev||captured.stat.ino!==prior.stat.ino)fail();}
  else chain.push(captured);
}

/** The destination is internal and fresh; callers cannot select an output path or overwrite. */
export async function writePublisherArtifacts(input: BuildInput): Promise<string> {
  const captured = releaseBuildInput(input);
  const parent = join(captured.sourceRoot,".tools","release-build");
  const output = join(parent,`${captured.version}-${captured.sourceCommit}`);
  const chain:DirectoryIdentity[]=[];
  try {
    chain.push(identity(captured.sourceRoot));
    for(const path of [dirname(parent),parent]){
      try {chain.push(identity(path));}
      catch(error){if(!(error instanceof Error)||!("code" in error)||error.code!=="ENOENT")fail();}
    }
  } catch {return fail();}
  try { lstatSync(output); return fail(); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") fail();
  }
  const files = await buildPublisherArtifacts(captured);
  let owned: Stats | undefined;
  try {
    directory(dirname(parent),chain); directory(parent,chain);verifyChain(chain);
    // mkdir is exclusive even when another caller races the prior check.
    mkdirSync(output);const created=identity(output);owned=created.stat;chain.push(created);
    for (const file of files){verifyChain(chain);writeFileSync(join(output,file.path),file.bytes,{flag:"wx"});}
    verifyChain(chain);
    return output;
  } catch {
    if (owned !== undefined) {
      // This exact bounded path was exclusively created above. Never clean a caller directory.
      try {
        // Inode equality alone is insufficient: an ancestor can be replaced with a junction
        // reaching the SAME moved inode outside sourceRoot. Validate every captured parent
        // and the final resolved absolute target before any recursive filesystem operation.
        verifyChain(chain);
        const resolved=realpathSync(output);const rel=relative(captured.sourceRoot,resolved);const current=lstatSync(resolved);
        if(dirname(output)!==parent||resolve(output)!==output||resolved!==output||isAbsolute(rel)||rel===".."||rel.startsWith(`..${sep}`)||current.dev!==owned.dev||current.ino!==owned.ino)fail();
        rmSync(output,{recursive:true,force:false});
      }
      catch { throw new Error("PixelWatch release: output-cleanup-failed"); }
    }
    return fail();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const values = new Map<string,string>();
    if (args.length !== 6) fail();
    for (let index=0;index<args.length;index+=2) {
      const name = args[index]; const value = args[index+1];
      if (name === undefined || value === undefined || !["--source-root","--version","--source-commit"].includes(name) || values.has(name)) fail();
      values.set(name,value);
    }
    await writePublisherArtifacts({sourceRoot:values.get("--source-root") ?? "",version:values.get("--version") ?? "",sourceCommit:values.get("--source-commit") ?? ""});
    process.stdout.write("PixelWatch release: artifacts-prepared\n");
  } catch { process.stderr.write("PixelWatch release: refused\n"); process.exitCode=1; }
}

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe,it} from "vitest";
function action():string{return readFileSync(new URL("../../actions/publish/action.yml",import.meta.url),"utf8");}
function section(name:"inputs"|"outputs"):string {const match=new RegExp(`^${name}:\\n([\\s\\S]*?)(?=^[a-z]|$(?![\\s\\S]))`,"m").exec(action());assert.ok(match?.[1]);return match[1];}
function names(text:string):string[]{return [...text.matchAll(/^ {2}([a-z_][a-z_0-9]*):$/gm)].map(match=>String(match[1])).sort();}
function input(name:string):string {const match=new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_][a-z_0-9]*:|$(?![\\s\\S]))`,"m").exec(section("inputs"));assert.ok(match?.[1]);return match[1];}
describe("published action metadata (real bundle acceptance remains separate)",()=>{
  it("runs the packaged ESM host using Node24 without source fallback or a package installation",()=>{
    const value=action();assert.match(value,/^runs:\n {2}using: node24\n {2}main: dist\/index\.js\n?$/m);assert.equal((value.match(/^runs:/gm)??[]).length,1);
    assert.deepEqual(JSON.parse(readFileSync(new URL("../../actions/publish/package.json",import.meta.url),"utf8")),{private:true,type:"module"});
    assert.match(value,/^name: .+$/m);assert.match(value,/^description: .+$/m);
  });
  it("requires an explicit stage and token without ambient credentials or a caller script input",()=>{
    assert.deepEqual(names(section("inputs")),["capsule","capsule_sha256","deployment_outcome","stage","token"]);
    for(const key of ["stage","token"]){assert.match(input(key),/^ {4}required: true$/m);assert.doesNotMatch(input(key),/^ {4}default:/m);}
    assert.match(input("stage"),/ingest, maintenance, prepare, finish/);
    const text=readFileSync(new URL("../../actions/publish/action.yml",import.meta.url),"utf8");assert.doesNotMatch(text,/GH_TOKEN|GITHUB_TOKEN|secrets:|script:|command:|repository:|ref:/);
  });
  it("finish-only private handoff inputs have no usable default and name the official step observation",()=>{
    for(const key of ["capsule","capsule_sha256","deployment_outcome"]){assert.match(input(key),/^ {4}required: false$/m);assert.doesNotMatch(input(key),/^ {4}default:/m);assert.match(input(key),/finish/);}
    assert.match(input("deployment_outcome"),/success, failure, cancelled, unknown, not-attempted/);
  });
  it("exposes only bounded stage decisions and owned private preparation outputs",()=>{
    const outputs=section("outputs");assert.deepEqual(names(outputs),["capsule","capsule_sha256","prepared","project","projection","stored","upload_root"]);
    assert.equal((outputs.match(/^ {4}description: .+$/gm)??[]).length,7);assert.doesNotMatch(outputs,/^ {4}value:/m);
  });
});

import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";
import {afterAll,describe,it} from "vitest";
import type {DefaultConfig,GitHubClient,PagesMetadata,PullRequestMetadata} from "../../../packages/forge-github/src/client.ts";
import {newStore} from "../../../packages/core/src/index.ts";
import type {Config,Store} from "../../../packages/schemas/src/index.ts";
import type {PublisherContext} from "../../../packages/publisher/src/types.ts";
import {assertNoSecrets,CANARY_TOKEN,SIGNED_URL} from "../../../tools/simulation/capture.ts";
import {collectHostPrStates,loadHostPolicy} from "../src/host-policy.ts";

const repository={owner:"adopter",name:"visual-app",repositoryId:"42"},oid=(character:string)=>character.repeat(40);
const raw:(string|Uint8Array)[]=[];
interface PolicyFixture {repository:{owner:string;name:string;repositoryId:string;defaultBranch:string};config:Config;configSha:string}
function record(value:string|Uint8Array):void {assertNoSecrets([value]);raw.push(value);}
function assets():PublisherContext["assets"] {return {release:"0.1.0-rc.1",releaseCommit:oid("a"),script:Buffer.from("/* host policy unit composition fixture; not a production release */")};}
function config():Config {return {schemaVersion:1,source:{workflowIds:["30"],events:["pull_request","push"]},providers:[{id:"fixture",shards:1}],store:{branch:"visual-data",prefix:"visual-review"}};}
function policy():PolicyFixture {return {repository:{...repository,defaultBranch:"main"},config:config(),configSha:oid("b")};}
const pages=():PagesMetadata=>({url:"https://adopter.github.io/visual-app/",customDomain:null});
function ports(read:()=>Promise<DefaultConfig>=()=>Promise.resolve(policy()),get:()=>Promise<PagesMetadata|null>=()=>Promise.resolve(pages())):{forge:Pick<GitHubClient,"readDefaultConfig"|"getPages">;calls:string[]} {
  const calls:string[]=[];const forge={readDefaultConfig(signal?:AbortSignal){assert.ok(signal instanceof AbortSignal);calls.push("config");return read();},getPages(signal?:AbortSignal){assert.ok(signal instanceof AbortSignal);calls.push("pages");return get();}};return {forge,calls};
}
async function refused(operation:()=>Promise<unknown>):Promise<void> {
  await assert.rejects(operation,error=>{assert.ok(error instanceof Error);record(error.stack??error.message);return /^pixelwatch-action: (policy-invalid|pr-state-invalid|cancelled)$/.test(error.message);});
}
function snapshot(streams:readonly (string|undefined)[]=["main","pr-7","pr-9","pr-7"]):{store:Store} {
  return {store:{...newStore(repository.repositoryId),runs:streams.map((stream,index)=>({runKey:`${String(index+1)}-a1`,sourceCreatedAt:"2026-10-03T00:00:00Z",...(stream===undefined?{}:{stream})}))}};
}
function pr(number:string,state:"open"|"closed"="open"):PullRequestMetadata {return {prNumber:number,state,headSha:oid("f"),headRepositoryId:"42"};}
afterAll(()=>{
  assertNoSecrets(raw);const directory=new URL("../../../.tools/logs/",import.meta.url);mkdirSync(directory,{recursive:true});
  writeFileSync(new URL("host-policy-raw.json",directory),JSON.stringify({productionHost:false,outputs:raw.map(value=>typeof value==="string"?value:Buffer.from(value).toString("base64"))}));
  writeFileSync(new URL("host-policy-raw-scan.json",directory),JSON.stringify({values:raw.length,bytes:raw.reduce((total,value)=>total+(typeof value==="string"?Buffer.byteLength(value):value.byteLength),0),failures:0}));
});

describe("ingest and maintenance host policy (unit ports, production composition pending)",()=>{
  it("fresh immutable default policy and Pages metadata produce the actual publisher context",async()=>{
    const source=policy(),supplied=assets(),{forge,calls}=ports(()=>Promise.resolve(source));const loaded=await loadHostPolicy(repository,supplied,forge,new AbortController().signal);
    assert.deepEqual(calls,["config","pages"]);assert.equal(loaded.defaultBranch,"main");assert.equal(loaded.context.configCommit,oid("b"));assert.deepEqual(loaded.context.repository,repository);
    assert.deepEqual(loaded.context.config,source.config);assert.deepEqual(loaded.context.pages,{url:pages().url,host:"adopter.github.io"});assert.deepEqual(loaded.context.assets.script,Uint8Array.from(supplied.script));record(loaded.context.assets.script);
    const provider=source.config.providers[0];assert.ok(provider);provider.id="changed";assert.equal(loaded.context.config.providers[0]?.id,"fixture");
  });
  it("each invocation rereads the current default branch and retains its resolved immutable config commit",async()=>{
    const first=policy(),second={...policy(),configSha:oid("c"),repository:{...repository,defaultBranch:"stable"},config:{...config(),store:{branch:"different-data",prefix:"later-review"}}};let reads=0;
    const {forge,calls}=ports(()=>Promise.resolve(reads++===0?first:second));const one=await loadHostPolicy(repository,assets(),forge,new AbortController().signal),two=await loadHostPolicy(repository,assets(),forge,new AbortController().signal);
    assert.deepEqual(calls,["config","pages","config","pages"]);assert.equal(one.context.configCommit,oid("b"));assert.equal(two.context.configCommit,oid("c"));assert.equal(two.defaultBranch,"stable");assert.equal(two.context.config.store?.branch,"different-data");
  });
  it("native release bytes and trusted target identity are captured before the first await",async()=>{
    const target={...repository},supplied=assets(),expected=Uint8Array.from(supplied.script),source=policy();let shadowReads=0;
    Object.defineProperty(supplied.script,"byteLength",{get(){shadowReads++;throw new Error(CANARY_TOKEN+SIGNED_URL);}});
    const {forge}=ports(()=>{supplied.script.fill(0);target.owner="foreign";target.name="impostor";return Promise.resolve(source);},()=>{const provider=source.config.providers[0];assert.ok(provider);provider.id="mutated";source.repository.defaultBranch="foreign";source.configSha=oid("d");return Promise.resolve(pages());});
    const result=await loadHostPolicy(target,supplied,forge,new AbortController().signal);assert.deepEqual(result.context.repository,repository);assert.deepEqual(result.context.assets.script,expected);assert.equal(shadowReads,0);assert.equal(result.context.config.providers[0]?.id,"fixture");assert.equal(result.context.configCommit,oid("b"));assert.equal(result.defaultBranch,"main");record(result.context.assets.script);
  });
  it("repository ID owner and name impostors refuse before Pages reads",async()=>{
    for(const identity of [{repositoryId:"43"},{owner:"foreign"},{name:"impostor"}]){const source=policy();Object.assign(source.repository,identity);const {forge,calls}=ports(()=>Promise.resolve(source));await refused(()=>loadHostPolicy(repository,assets(),forge,new AbortController().signal));assert.deepEqual(calls,["config"]);}
  });
  it("unknown config versions invalid config commits and unsafe default branches refuse before Pages reads",async()=>{
    for(const mutate of [(source:PolicyFixture)=>{source.config.schemaVersion=2 as 1;},(source:PolicyFixture)=>{source.configSha="main";},(source:PolicyFixture)=>{source.repository.defaultBranch="refs/heads/main";},(source:PolicyFixture)=>{source.repository.defaultBranch="../escape";},(source:PolicyFixture)=>{source.config.providers=[];}]){const source=policy();mutate(source);const {forge,calls}=ports(()=>Promise.resolve(source));await refused(()=>loadHostPolicy(repository,assets(),forge,new AbortController().signal));assert.deepEqual(calls,["config"]);}
  });
  it("absent invalid or foreign Pages metadata and unavailable reads return only fixed errors",async()=>{
    for(const value of [null,{url:"http://adopter.github.io/visual-app/",customDomain:null},{url:SIGNED_URL,customDomain:null},{url:"https://foreign.github.io/visual-app/",customDomain:null},{url:"https://adopter.github.io/other/",customDomain:null}]){const {forge,calls}=ports(()=>Promise.resolve(policy()),()=>Promise.resolve(value));await refused(()=>loadHostPolicy(repository,assets(),forge,new AbortController().signal));assert.deepEqual(calls,["config","pages"]);}
    for(const stage of ["config","pages"]){const failure=()=>Promise.reject(new Error(CANARY_TOKEN+SIGNED_URL)),{forge}=ports(stage==="config"?failure:()=>Promise.resolve(policy()),stage==="pages"?failure:()=>Promise.resolve(pages()));await refused(()=>loadHostPolicy(repository,assets(),forge,new AbortController().signal));}
    const custom={url:"https://review.example.org/",customDomain:"review.example.org"},{forge}=ports(()=>Promise.resolve(policy()),()=>Promise.resolve(custom));const result=await loadHostPolicy(repository,assets(),forge,new AbortController().signal);assert.equal(result.context.pages.host,"review.example.org");
  });
  it("invalid or oversized assets refuse before policy reads and final config budgets remain authoritative",async()=>{
    for(const supplied of [{...assets(),release:"../escape"},{...assets(),releaseCommit:"main"},{...assets(),script:new Uint8Array()},{...assets(),script:new Uint8Array(8*1024*1024+1)}]){const {forge,calls}=ports();await refused(()=>loadHostPolicy(repository,supplied,forge,new AbortController().signal));assert.deepEqual(calls,[]);}
    const source={...policy(),config:{...config(),limits:{softBytes:1024*1024,hardBytes:1024*1024}}},{forge}=ports(()=>Promise.resolve(source));await refused(()=>loadHostPolicy(repository,{...assets(),script:new Uint8Array(1024*1024+1)},forge,new AbortController().signal));
  });
  it("cancelled policy calls reject before new reads and do not await an uncooperative port",async()=>{
    const controller=new AbortController();controller.abort(CANARY_TOKEN+SIGNED_URL);const idle=ports();await refused(()=>loadHostPolicy(repository,assets(),idle.forge,controller.signal));assert.deepEqual(idle.calls,[]);
    for(const stage of ["config","pages"]){const active=new AbortController(),pending=new Promise<never>(()=>{});let entered:()=>void=()=>{};const started=new Promise<true>(resolve=>{entered=()=>{resolve(true);};}),blocked=()=>{entered();return pending;},{forge,calls}=ports(stage==="config"?blocked:()=>Promise.resolve(policy()),stage==="pages"?blocked:()=>Promise.resolve(pages()));const result=loadHostPolicy(repository,assets(),forge,active.signal);assert.equal(await Promise.race([started,result.then(()=>false,()=>false)]),true);active.abort(CANARY_TOKEN+SIGNED_URL);await refused(()=>result);assert.deepEqual(calls,stage==="config"?["config"]:["config","pages"]);}
  });
  it("schema validated retained PR streams select each exact PR once with fresh open or closed state",async()=>{
    const calls:string[]=[],states=await collectHostPrStates(snapshot(),"42",{getPullRequest(number,signal){assert.ok(signal instanceof AbortSignal);calls.push(number);return Promise.resolve(pr(number,number==="7"?"open":"closed"));}},new AbortController().signal);
    assert.deepEqual(calls,["7","9"]);assert.deepEqual([...states],[["7","open"],["9","closed"]]);record(JSON.stringify([...states]));
  });
  it("unavailable and mismatched PR observations retain a fixed unknown state without leaking raw failures",async()=>{
    const states=await collectHostPrStates(snapshot(),"42",{getPullRequest(number){return number==="7"?Promise.reject(new Error(CANARY_TOKEN+SIGNED_URL)):Promise.resolve(pr("88"));}},new AbortController().signal);assert.deepEqual([...states],[["7","unknown"],["9","unknown"]]);record(JSON.stringify([...states]));
  });
  it("unknown store versions foreign ownership and more than 1000 PR streams refuse before any GET",async()=>{
    for(const supplied of [{store:{...snapshot().store,schemaVersion:2 as 1}},{store:{...snapshot().store,dataVersion:2 as 1}},{store:{...snapshot().store,repositoryId:"43"}},snapshot(Array.from({length:1001},(_,index)=>`pr-${String(index+1)}`))]){let calls=0;await refused(()=>collectHostPrStates(supplied,"42",{getPullRequest(number){calls++;return Promise.resolve(pr(number));}},new AbortController().signal));assert.equal(calls,0);}
  });
  it("retained streams are copied before asynchronous reads and empty stores invent no PR",async()=>{
    const source=snapshot(),calls:string[]=[];const states=await collectHostPrStates(source,"42",{getPullRequest(number){calls.push(number);source.store.runs.splice(0,source.store.runs.length);return Promise.resolve(pr(number));}},new AbortController().signal);assert.deepEqual(calls,["7","9"]);assert.deepEqual([...states],[["7","open"],["9","open"]]);
    const empty=await collectHostPrStates({store:newStore("42")},"42",{getPullRequest(){throw new Error("empty store must not read a PR");}},new AbortController().signal);assert.equal(empty.size,0);
  });
  it("PR cancellation rejects instead of converting abort to unknown or starting another GET",async()=>{
    const idle=new AbortController();idle.abort(CANARY_TOKEN);let calls=0;const forge={getPullRequest(number:string){calls++;return Promise.resolve(pr(number));}};await refused(()=>collectHostPrStates(snapshot(),"42",forge,idle.signal));assert.equal(calls,0);
    const active=new AbortController(),pending=new Promise<PullRequestMetadata>(()=>{}),result=collectHostPrStates(snapshot(),"42",{getPullRequest(){calls++;return pending;}},active.signal);await Promise.resolve();active.abort(CANARY_TOKEN+SIGNED_URL);await refused(()=>result);assert.equal(calls,1);
    const completed=new AbortController();await refused(()=>collectHostPrStates(snapshot(),"42",{getPullRequest(number){completed.abort(CANARY_TOKEN);return Promise.resolve(pr(number));}},completed.signal));
  });
  it("policy and PR reads never inspect or enumerate ambient credentials",async()=>{
    const original=process.env;let credentials=0;process.env=new Proxy(original,{get(target,key){if(key==="GH_TOKEN"||key==="GITHUB_TOKEN"){credentials++;throw new Error(CANARY_TOKEN+SIGNED_URL);}return typeof key==="string"?target[key]:undefined;},ownKeys(){credentials++;throw new Error(CANARY_TOKEN+SIGNED_URL);}});
    try {const {forge}=ports(),loaded=await loadHostPolicy(repository,assets(),forge,new AbortController().signal),states=await collectHostPrStates(snapshot(),"42",{getPullRequest:number=>Promise.resolve(pr(number))},new AbortController().signal);record(loaded.context.assets.script);record(JSON.stringify([...states]));}finally {process.env=original;}assert.equal(credentials,0);
  });
});

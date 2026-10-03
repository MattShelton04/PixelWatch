import assert from "node:assert/strict";
import {inspect} from "node:util";
import {describe,it} from "vitest";
import {GitHubClient,ForgeError,isOwnedCommentOperation,type CommentInput,type HttpResponse} from "../src/index.ts";
import {assertNoSecrets,CANARY_TOKEN} from "../../../tools/simulation/capture.ts";

const body="<!-- pixelwatch:repo:42 -->\ncurrent generation",json=(value:unknown,status=200):HttpResponse=>({status,headers:{},body:new TextEncoder().encode(JSON.stringify(value))});
function setup(mode:"created"|"rejected"|"ignored-delay"|"ignored-get"|"accepted-abort"="created"){
  const controller=new AbortController();let requests=0,mutations=0,delays=0,disposed=0;
  const client=new GitHubClient({owner:"owner",repo:"project",repositoryId:"42",token:CANARY_TOKEN,
    transport:{request(request){requests++;if(request.method==="POST"){mutations++;return Promise.resolve(mode==="rejected"?json({message:CANARY_TOKEN},422):mode==="ignored-delay"?json({},503):json({id:9,body,user:{id:7}},201));}
      if(mode==="ignored-get")return new Promise(()=>{});return Promise.resolve(json([]));}},
    timing:{deadline:()=>({signal:new AbortController().signal,dispose(){disposed++;if(mode==="accepted-abort"&&mutations===1)controller.abort();}}),delay(){delays++;return mode==="ignored-delay"?new Promise(()=>{}):Promise.resolve();}}});
  const input:CommentInput=Object.freeze({prNumber:"8",botId:"7",body,beforeMutation:()=>Promise.resolve(true),signal:controller.signal});
  return {client,input,controller,counts:()=>({requests,mutations,delays,disposed})};
}
async function turns(count=100):Promise<void>{for(let index=0;index<count;index++)await Promise.resolve();}
function scan(error:unknown):void {assertNoSecrets([inspect(error,{showHidden:true,depth:8})]);}

describe("genuine current comment operation provenance and bounded cancellation",()=>{
  it("only the same current genuine adapter promise and captured invocation receive completion authority",async()=>{
    const world=setup(),operation=world.client.reconcileComment(world.input);
    assert.equal(isOwnedCommentOperation(operation,"42",world.input),true);
    assert.equal(isOwnedCommentOperation(operation,"43",world.input),false);
    assert.equal(isOwnedCommentOperation(operation,"42",Object.freeze({...world.input})),false);
    assert.equal(isOwnedCommentOperation(Promise.resolve({status:"created",commentId:"9"}),"42",world.input),false);
    assert.deepEqual(await operation,{status:"created",commentId:"9"});assert.equal(world.counts().mutations,1);
  });
  it("fabricated replayed and foreign operations cannot borrow a genuine refusal or touch promise accessors",async()=>{
    const world=setup("rejected"),old=world.client.reconcileComment(world.input);let refusal:unknown;
    try{await old;}catch(error){refusal=error;scan(error);}assert.ok(refusal instanceof ForgeError);assert.equal(refusal.code,"comment-body-rejected");
    const current=Object.freeze({...world.input});assert.equal(isOwnedCommentOperation(old,"42",current),false);
    let reads=0;const fake=Promise.resolve(undefined);for(const key of ["then","constructor"])void Object.defineProperty(fake,key,{get(){reads++;throw new Error(CANARY_TOKEN);}});
    assert.equal(isOwnedCommentOperation(fake,"42",current),false);assert.equal(reads,0);
    const forged=Promise.reject(new ForgeError("comment-body-rejected"));void forged.catch(()=>undefined);
    assert.equal(isOwnedCommentOperation(forged,"42",current),false);assert.equal(world.counts().mutations,1);
  });
  it("provenance never rereads input accessors or trusts changed mutable invocation fields",async()=>{
    const world=setup();let reads=0;const accessor={...world.input};Object.defineProperty(accessor,"body",{get(){reads++;return body;}});
    const first=world.client.reconcileComment(accessor);assert.equal(isOwnedCommentOperation(first,"42",accessor),false);assert.deepEqual(await first,{status:"created",commentId:"9"});assert.equal(reads,1);
    const mutable={...world.input};const second=world.client.reconcileComment(mutable);mutable.prNumber="99";
    assert.equal(isOwnedCommentOperation(second,"42",mutable),false);await second;
  });
  it("overridden public discovery cannot strand a genuine comment operation after cancellation",async()=>{
    const world=setup("ignored-get");let overridden=0,settled=false;
    world.client.discoverComment=()=>{overridden++;return new Promise(()=>{});};
    const operation=world.client.reconcileComment(world.input);void operation.then(()=>{settled=true;},(error: unknown)=>{scan(error);settled=true;});
    await turns(60);world.controller.abort();await turns(80);
    assert.equal(overridden,0);assert.equal(settled,true);assert.equal(world.counts().mutations,0);assert.equal(world.counts().disposed,1);
  });
  it("ignored retry delay settles through the existing caller abort without a later mutation",async()=>{
    const world=setup("ignored-delay");let settled=false,code="none";
    const operation=world.client.reconcileComment(world.input);void operation.then(()=>{settled=true;},(error: unknown)=>{scan(error);settled=true;assert.ok(error instanceof ForgeError);code=error.code;});
    await turns();assert.equal(world.counts().delays,1);world.controller.abort();await turns(80);
    assert.equal(settled,true);assert.equal(code,"request-cancelled");assert.equal(world.counts().mutations,1);assert.equal(world.counts().requests,2);
  });
  it("cancellation before the scheduled dispatch reaction starts no new transport request",async()=>{
    const world=setup();const operation=world.client.getRepository(world.controller.signal);void operation.catch(scan);world.controller.abort();await turns(80);
    assert.equal(world.counts().requests,0);assert.equal(world.counts().disposed,1);
  });
  it("an actual validated HTTP201 survives cancellation during request teardown without another mutation",async()=>{
    const world=setup("accepted-abort"),operation=world.client.reconcileComment(world.input);
    assert.equal(isOwnedCommentOperation(operation,"42",world.input),true);
    assert.deepEqual(await operation,{status:"created",commentId:"9"});assert.equal(world.controller.signal.aborted,true);
    assert.deepEqual(world.counts(),{requests:2,mutations:1,delays:0,disposed:2});
  });
});

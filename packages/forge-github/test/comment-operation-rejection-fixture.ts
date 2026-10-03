import "../../../tools/lib/no-network.ts";
import {inspect} from "node:util";
import {GitHubClient} from "../src/client.ts";
import type {HttpResponse} from "../src/transport.ts";
import {CANARY_TOKEN,assertNoSecrets} from "../../../tools/simulation/capture.ts";

const json=(value:unknown,status=200):HttpResponse=>({status,headers:{},body:new TextEncoder().encode(JSON.stringify(value))});
async function turns():Promise<void>{for(let index=0;index<100;index++)await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));}
const results=[];
for(const kind of ["guard","transport"] as const){
  let reads=0,unhandled=0,rawCanary=false,settled=false,publicSafe=true,disposed=0;
  const listener=(error:unknown)=>{unhandled++;try{assertNoSecrets([inspect(error,{showHidden:true,depth:8})]);}catch{rawCanary=true;}};
  process.on("unhandledRejection",listener);
  function hostile<T>():Promise<T>{const pending=Promise.reject<T>(new Error(CANARY_TOKEN));void Object.defineProperty(pending,"then",{get(){reads++;throw new Error(CANARY_TOKEN);}});return pending;}
  const client=new GitHubClient({owner:"owner",repo:"project",repositoryId:"42",token:CANARY_TOKEN,
    transport:{request(){return kind==="transport"?hostile<HttpResponse>():Promise.resolve(json([]));}},
    timing:{deadline:()=>({signal:new AbortController().signal,dispose(){disposed++;}}),delay:()=>Promise.resolve()}});
  const input=Object.freeze({prNumber:"8",botId:"7",body:"<!-- pixelwatch:repo:42 -->\ncurrent",signal:new AbortController().signal,
    beforeMutation:()=>kind==="guard"?hostile<boolean>():Promise.resolve(true)});
  void client.reconcileComment(input).then(()=>{settled=true;},(error:unknown)=>{settled=true;try{assertNoSecrets([inspect(error,{showHidden:true,depth:8})]);}catch{publicSafe=false;}});
  await turns();process.removeListener("unhandledRejection",listener);results.push({kind,reads,unhandled,rawCanary,settled,publicSafe,disposed});
}
const output=JSON.stringify({noNetworkGuard:true,results});assertNoSecrets([output]);process.stdout.write(output+"\n");
process.exitCode=results.every(value=>value.reads===0&&value.unhandled===0&&!value.rawCanary&&value.settled&&value.publicSafe)?0:1;

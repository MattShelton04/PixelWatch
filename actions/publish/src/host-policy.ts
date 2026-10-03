import type {GitHubClient,PagesMetadata} from "../../../packages/forge-github/src/client.ts";
import {appScriptPath,deriveStreams,type PrState} from "../../../packages/core/src/index.ts";
import {isGitHubId} from "../../../packages/schemas/src/ids.ts";
import {captureContext,checkedDocument,checkedOid,copyBytes} from "../../../packages/publisher/src/assembly-input.ts";
import {isSignalAborted,onSignalAbort} from "../../../packages/publisher/src/signal-input.ts";
import type {PublisherContext} from "../../../packages/publisher/src/types.ts";
import type {StoreSnapshot} from "../../../packages/store/src/types.ts";

// The release compiler already bounds its complete three-bundle output at 8 MiB.
const MAX_ASSET_BYTES=8*1024*1024,MAX_PR_STREAMS=1000;
type Refusal="policy-invalid"|"pr-state-invalid"|"cancelled";
function fail(code:Refusal):never {throw new Error(`pixelwatch-action: ${code}`);}
function preflight(signal:AbortSignal):void {if(isSignalAborted(signal))fail("cancelled");}
function refused(signal:AbortSignal,code:Refusal):never {
  let cancelled=false;try {cancelled=isSignalAborted(signal);}catch { /* Invalid signal has no cancellation authority. */ }
  return fail(cancelled?"cancelled":code);
}
/** Caller cancellation bounds trusted ports even when an injected unit port remains pending. */
async function readPort<T>(operation:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  preflight(signal);let cancel:()=>void=()=>{};
  const cancellation=new Promise<never>((_resolve,reject)=>{cancel=()=>{reject(new Error("pixelwatch-action: cancelled"));};});void cancellation.catch(()=>undefined);
  const unlink=onSignalAbort(signal,cancel);
  try {preflight(signal);const result=await Promise.race([operation(),cancellation]);preflight(signal);return result;}finally {unlink();}
}
function captureRepository(source:PublisherContext["repository"]):PublisherContext["repository"] {
  const repository={owner:source.owner,name:source.name,repositoryId:source.repositoryId};
  if(!isGitHubId(repository.repositoryId)||typeof repository.owner!=="string"||typeof repository.name!=="string"
    ||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner)||!/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)||repository.name==="."||repository.name==="..")fail("policy-invalid");
  return repository;
}
function branch(value:string):string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,127}$/.test(value)||value.startsWith("refs/")||value.includes("..")
    ||value.split("/").some(part=>part===""||part.startsWith(".")||part.endsWith(".")||part.endsWith(".lock")))fail("policy-invalid");return value;
}
function capturePages(source:PagesMetadata|null,repository:PublisherContext["repository"]):PublisherContext["pages"] {
  if(source===null)fail("policy-invalid");const url=source.url,customDomain=source.customDomain;
  if(typeof url!=="string"||url.length>2048||/[^\x21-\x7e]|[\\%]/.test(url)||(customDomain!==null&&typeof customDomain!=="string"))fail("policy-invalid");
  const parsed=new URL(url),host=customDomain??`${repository.owner.toLowerCase()}.github.io`;
  const expectedPath=customDomain!==null||repository.name.toLowerCase()===`${repository.owner.toLowerCase()}.github.io`?"/":`/${repository.name}/`;
  if(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)||host.includes("..")||!host.includes(".")||parsed.protocol!=="https:"||parsed.hostname!==host
    ||parsed.port!==""||parsed.username!==""||parsed.password!==""||parsed.search!==""||parsed.hash!==""||parsed.href!==url||parsed.pathname!==expectedPath)fail("policy-invalid");
  return {url,host};
}

/** Fresh immutable default-branch policy for ingest/maintenance; project owns separate locked reads. */
export async function loadHostPolicy(repository:PublisherContext["repository"],assets:PublisherContext["assets"],forge:Pick<GitHubClient,"readDefaultConfig"|"getPages">,signal:AbortSignal):Promise<{context:PublisherContext;defaultBranch:string}> {
  try {
    preflight(signal);const target=captureRepository(repository),release=assets.release,releaseCommit=checkedOid(assets.releaseCommit);
    if(typeof release!=="string")fail("policy-invalid");appScriptPath(release);const script=copyBytes(assets.script,MAX_ASSET_BYTES);if(script.byteLength===0)fail("policy-invalid");
    // Native bytes and runner-owned identity above are captured before the first port/await.
    const source=await readPort(()=>forge.readDefaultConfig(signal),signal),actual=source.repository;
    if(actual.repositoryId!==target.repositoryId||actual.owner!==target.owner||actual.name!==target.name)fail("policy-invalid");
    const defaultBranch=branch(actual.defaultBranch),configCommit=checkedOid(source.configSha),config=checkedDocument("config",source.config);
    const pages=capturePages(await readPort(()=>forge.getPages(signal),signal),target);
    const context=captureContext({repository:target,config,configCommit,pages,assets:{release,releaseCommit,script}});preflight(signal);return {context,defaultBranch};
  }catch {return refused(signal,"policy-invalid");}
}

/** Read each retained PR once; an unavailable observation remains unknown for conservative retention. */
export async function collectHostPrStates(snapshot:Pick<StoreSnapshot,"store">,repositoryId:string,forge:Pick<GitHubClient,"getPullRequest">,signal:AbortSignal):Promise<ReadonlyMap<string,PrState>> {
  try {
    preflight(signal);if(!isGitHubId(repositoryId))fail("pr-state-invalid");const store=checkedDocument("store",snapshot.store);
    if(store.repositoryId!==repositoryId)fail("pr-state-invalid");const numbers=deriveStreams(store).filter(stream=>stream.streamId.startsWith("pr-")).map(stream=>stream.streamId.slice(3));
    if(numbers.length>MAX_PR_STREAMS)fail("pr-state-invalid");const states=new Map<string,PrState>();
    for(const number of numbers){
      preflight(signal);let state:PrState="unknown";
      try {const result=await readPort(()=>forge.getPullRequest(number,signal),signal),observed:unknown=result.state;if(result.prNumber===number&&(observed==="open"||observed==="closed"))state=observed;}
      catch {preflight(signal);}
      preflight(signal);states.set(number,state);
    }
    preflight(signal);return states;
  }catch {return refused(signal,"pr-state-invalid");}
}

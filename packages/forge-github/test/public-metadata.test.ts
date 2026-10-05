import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderReportCaller } from "../../../tools/release/workflow-policy.ts";
import { getEventListeners } from "node:events";
import { PublicGitHubPagesMetadata } from "../src/public-metadata.ts";
import { ForgeError, LIMITS, type ForgeErrorCode } from "../src/errors.ts";
import type { HttpRequest, HttpResponse, HttpTransport, Timing } from "../src/transport.ts";
import type { ReportJobIdentity } from "../src/public-metadata-types.ts";

const API = "https://api.github.com/repos/owner/site";
const SHA = "a".repeat(40);
const CANARY = "FAKE_PUBLIC_METADATA_CANARY";
const EVIL = `https://evil.invalid/?token=${CANARY}`;
const REPORT: ReportJobIdentity = {runId: "100", attempt: 2, workflowPath: ".github/workflows/report.yml", workflowId: "7", headSha: SHA, ref: "refs/heads/main", runnerName: "trusted runner"};
const JOB_URL = "https://github.com/owner/site/actions/runs/100/job/900";
const encoder = new TextEncoder();
const response = (value: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({status, headers, body: encoder.encode(JSON.stringify(value))});
const repository = () => ({id: 11, full_name: "owner/site", private: false, default_branch: "main", url: EVIL});
const environment = () => ({id: 22, name: "github-pages", deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}, url: EVIL});
const policy = () => ({total_count: 1, branch_policies: [{id: 33, name: "main", type: "branch"}]});
const run = (attempt = 2) => ({id: 100, run_attempt: attempt, workflow_id: 7, path: REPORT.workflowPath, event: "workflow_run", status: "in_progress", head_sha: SHA, head_branch: "main", head_commit: {id: SHA}, repository: {id: 11, full_name: "owner/site"}, head_repository: {id: 11, full_name: "owner/site"}, url: EVIL});
const job = (id = 900, extra: Record<string, unknown> = {}) => ({id, run_id: 100, run_attempt: 2, name: "report / project", runner_name: REPORT.runnerName, head_sha: SHA, status: "in_progress", html_url: EVIL, ...extra});
const deployment = (id = 44, extra: Record<string, unknown> = {}) => ({id, environment: "github-pages", original_environment: "github-pages", ref: "main", sha: SHA, statuses_url: EVIL, created_at: "2000-01-01T00:00:00Z", payload: {}, ...extra});
const status = (id = 55, url = JOB_URL, extra: Record<string, unknown> = {}) => ({id, environment: "github-pages", state: "waiting", log_url: url, target_url: url, ...extra});

type Step = HttpResponse | ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>);
class Script implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  readonly routes = new Map<string, Step[]>();
  set(path: string, ...steps: Step[]): this {this.routes.set(`${API}${path}`, steps); return this;}
  request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    const steps = this.routes.get(request.url);
    if (steps === undefined || steps.length === 0) return Promise.reject(new Error(CANARY));
    const step = steps.length === 1 ? steps[0] : steps.shift();
    if (step === undefined) return Promise.reject(new Error(CANARY));
    return Promise.resolve(typeof step === "function" ? step(request) : step);
  }
}
class Clock implements Timing {
  readonly controllers: AbortController[] = [];
  readonly delays: number[] = [];
  created = 0; disposed = 0;
  deadline(ms: number): {signal: AbortSignal; dispose(): void} {
    expect(ms).toBe(LIMITS.requestMs); this.created++;
    const controller = new AbortController(); this.controllers.push(controller);
    return {signal: controller.signal, dispose: () => {this.disposed++;}};
  }
  delay(ms: number, signal?: AbortSignal): Promise<void> {expect(signal?.aborted).not.toBe(true); this.delays.push(ms); return Promise.resolve();}
}
function setup(): {adapter: PublicGitHubPagesMetadata; script: Script; clock: Clock} {
  const script = new Script().set("", response(repository())).set("/environments/github-pages", response(environment()))
    .set("/environments/github-pages/deployment-branch-policies?per_page=100&page=1", response(policy()))
    .set("/actions/runs/100", response(run())).set("/actions/runs/100/attempts/2", response(run()))
    .set("/actions/workflows/7", response({id: 7, path: REPORT.workflowPath}))
    .set("/actions/runs/100/attempts/2/jobs?per_page=100&page=1", response({total_count: 1, jobs: [job()]}))
    .set("/deployments?environment=github-pages&per_page=100&page=1", response([deployment()]))
    .set("/deployments/44/statuses?per_page=100&page=1", response([status()]));
  const clock = new Clock();
  return {adapter: new PublicGitHubPagesMetadata({owner: "owner", repo: "site", repositoryId: "11", transport: script, timing: clock}), script, clock};
}
async function refuses(operation: Promise<unknown>, code?: ForgeErrorCode): Promise<void> {
  let failure: unknown;
  try {await operation;} catch (error) {failure = error;}
  expect(failure).toBeInstanceOf(ForgeError);
  if (code !== undefined) expect((failure as ForgeError).code).toBe(code);
  const raw = `${String(failure)}${JSON.stringify(failure)}${failure instanceof Error ? failure.stack ?? "" : ""}`;
  expect(raw).not.toContain(CANARY); expect(raw).not.toContain("evil.invalid");
}
function safeCalls(script: Script, clock: Clock): void {
  for (const request of script.calls) {
    expect(request.method).toBe("GET"); expect(request.url.startsWith(API)).toBe(true);
    expect(request.maxBytes).toBe(LIMITS.maxJsonBytes); expect(request.body).toBeUndefined();
    expect(Object.keys(request.headers).map(key => key.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(request.headers).map(key => key.toLowerCase())).not.toContain("cookie");
    expect(JSON.stringify(request)).not.toContain(CANARY); expect(request.signal).toBeInstanceOf(AbortSignal);
  }
  expect(script.calls.length).toBeLessThanOrEqual(60); expect(clock.disposed).toBe(clock.created);
}

it("public metadata constructs fixed unauthenticated routes without following response URLs", async () => {
  const {adapter, script, clock} = setup();
  expect(await adapter.readEnvironment("main")).toEqual({environmentId: "22", defaultBranch: "main"});
  expect(await adapter.readDeploymentHistory("main", REPORT)).toEqual({current: {deploymentId: "44", jobId: "900", states: ["waiting"]}, priorDeploymentIds: [], complete: true});
  expect(script.calls.map(call => call.url)).toEqual([API, `${API}/environments/github-pages`, `${API}/environments/github-pages/deployment-branch-policies?per_page=100&page=1`, API, `${API}/actions/runs/100`, `${API}/actions/runs/100/attempts/2`, `${API}/actions/workflows/7`, `${API}/actions/runs/100/attempts/2/jobs?per_page=100&page=1`, `${API}/deployments?environment=github-pages&per_page=100&page=1`, `${API}/deployments/44/statuses?per_page=100&page=1`]);
  safeCalls(script, clock);
});

it("Pages environment requires exactly one literal default-branch-only policy", async () => {
  expect(await setup().adapter.readEnvironment("main")).toEqual({environmentId: "22", defaultBranch: "main"});
  for (const branchPolicies of [[], [{id: 33, name: "main*", type: "branch"}], [{id: 33, name: "main", type: "tag"}], [{id: 33, name: "main", type: "branch"}, {id: 34, name: "other", type: "branch"}]]) {
    const {adapter, script, clock} = setup(); script.set("/environments/github-pages/deployment-branch-policies?per_page=100&page=1", response({total_count: branchPolicies.length, branch_policies: branchPolicies}));
    await refuses(adapter.readEnvironment("main"), "pages-metadata"); safeCalls(script, clock);
  }
  for (const value of [{...environment(), deployment_branch_policy: {protected_branches: true, custom_branch_policies: false}}, {...environment(), name: "foreign"}, {...repository(), id: 12}, {...repository(), private: true}, {...repository(), default_branch: "other"}]) {
    const {adapter, script, clock} = setup(); script.set("name" in value ? "/environments/github-pages" : "", response(value));
    await refuses(adapter.readEnvironment("main")); safeCalls(script, clock);
  }
});

it("report run attempt workflow and repository identities are corroborated before deployment correlation", async () => {
  expect((await setup().adapter.readDeploymentHistory("main", REPORT)).current.jobId).toBe("900");
  for (const [path, value] of [["/actions/runs/100", {...run(), id: 101}], ["/actions/runs/100", run(1)], ["/actions/runs/100/attempts/2", run(3)], ["/actions/runs/100/attempts/2", {...run(), head_sha: "b".repeat(40)}], ["/actions/runs/100/attempts/2", {...run(), head_branch: "other"}], ["/actions/runs/100/attempts/2", {...run(), repository: {id: 12, full_name: "owner/site"}}], ["/actions/runs/100/attempts/2", {...run(), head_repository: {id: 12}}], ["/actions/workflows/7", {id: 7, path: ".github/workflows/evil.yml"}]] as const) {
    const {adapter, script, clock} = setup(); script.set(path, response(value)); await refuses(adapter.readDeploymentHistory("main", REPORT));
    expect(script.calls.some(call => call.url.includes("/deployments?"))).toBe(false); safeCalls(script, clock);
  }
  for (const report of [{...REPORT, ref: "refs/heads/other"}, {...REPORT, attempt: 0}, {...REPORT, workflowPath: "../report.yml"}, {...REPORT, runnerName: ""}]) {
    const {adapter, script} = setup(); await refuses(adapter.readDeploymentHistory("main", report), "invalid-identity"); expect(script.calls).toHaveLength(0);
  }
});

it("deployment matches require the unique exact authenticated report job", async () => {
  expect((await setup().adapter.readDeploymentHistory("main", REPORT)).current.deploymentId).toBe("44");
  for (const jobs of [[], [job(900, {runner_name: "other"})], [job(900, {name: "project"})], [job(), job(901)], [job(900, {run_attempt: 1})]]) {
    const {adapter, script, clock} = setup(); script.set("/actions/runs/100/attempts/2/jobs?per_page=100&page=1", response({total_count: jobs.length, jobs}));
    await refuses(adapter.readDeploymentHistory("main", REPORT)); safeCalls(script, clock);
  }
  for (const url of ["https://github.com/owner/site/actions/runs/100/job/901", `${JOB_URL}?token=${CANARY}`, `${JOB_URL}/`, JOB_URL.replace("github.com", "evil.invalid")]) {
    const {adapter, script, clock} = setup(); script.set("/deployments/44/statuses?per_page=100&page=1", response([status(55, url)]));
    await refuses(adapter.readDeploymentHistory("main", REPORT), "pages-metadata"); safeCalls(script, clock);
  }
});

it("same SHA and timestamps cannot hide a prior deployment", async () => {
  const {adapter, script, clock} = setup(); script.set("/deployments?environment=github-pages&per_page=100&page=1", response([deployment(45), deployment()]));
  script.set("/deployments/45/statuses?per_page=100&page=1", response([status(56, "https://github.com/owner/site/actions/runs/99/job/899", {state: "failure"})]));
  expect(await adapter.readDeploymentHistory("main", REPORT)).toEqual({current: {deploymentId: "44", jobId: "900", states: ["waiting"]}, priorDeploymentIds: ["45"], complete: true}); safeCalls(script, clock);
  const ambiguous = setup(); ambiguous.script.set("/deployments?environment=github-pages&per_page=100&page=1", response([deployment(45), deployment()]));
  ambiguous.script.set("/deployments/45/statuses?per_page=100&page=1", response([status(56)])); await refuses(ambiguous.adapter.readDeploymentHistory("main", REPORT), "pages-metadata");
});

it("complete deployment and status pagination refuses ambiguity duplicates and exhausted bounds", async () => {
  const {adapter, script, clock} = setup();
  const statuses = Array.from({length: 100}, (_, index) => status(1000 + index));
  script.set("/deployments/44/statuses?per_page=100&page=1", response(statuses)); script.set("/deployments/44/statuses?per_page=100&page=2", response([status(1100, JOB_URL, {state: "success"})]));
  expect((await adapter.readDeploymentHistory("main", REPORT)).current.states).toEqual([...statuses.map(() => "waiting"), "success"]); safeCalls(script, clock);
  for (const values of [[deployment(), deployment()], [deployment(44, {environment: "other"})]]) {
    const current = setup(); current.script.set("/deployments?environment=github-pages&per_page=100&page=1", response(values)); await refuses(current.adapter.readDeploymentHistory("main", REPORT));
  }
  const duplicate = setup(); duplicate.script.set("/deployments/44/statuses?per_page=100&page=1", response([status(), status()])); await refuses(duplicate.adapter.readDeploymentHistory("main", REPORT));
  const bounded = setup(); for (let page = 1; page <= 11; page++) bounded.script.set(`/deployments/44/statuses?per_page=100&page=${String(page)}`, response(Array.from({length: 100}, (_, index) => status(page * 1000 + index))));
  await refuses(bounded.adapter.readDeploymentHistory("main", REPORT), "pagination-limit"); safeCalls(bounded.script, bounded.clock);
  // A shared adapter instance counts real attempts across methods, including concurrent calls.
  const cap = setup(); for (let index = 0; index < 20; index++) await cap.adapter.readEnvironment("main");
  expect(cap.script.calls).toHaveLength(60); await refuses(cap.adapter.readEnvironment("main"), "pagination-limit"); expect(cap.script.calls).toHaveLength(60);
});

it("missing expired redirected or malformed public metadata cannot prove an unused site", async () => {
  expect((await setup().adapter.readDeploymentHistory("main", REPORT)).complete).toBe(true);
  for (const result of [response([], 404), response([], 410), response([], 302, {location: EVIL}), response([], 403), response({bad: CANARY}), {status: 200, headers: {}, body: encoder.encode(`{invalid${CANARY}`)}]) {
    const {adapter, script, clock} = setup(); script.set("/deployments?environment=github-pages&per_page=100&page=1", result);
    await refuses(adapter.readDeploymentHistory("main", REPORT)); safeCalls(script, clock);
  }
  for (const values of [[], [status(55, JOB_URL, {state: "cancelled"})]]) {
    const {adapter, script} = setup(); script.set("/deployments/44/statuses?per_page=100&page=1", response(values)); await refuses(adapter.readDeploymentHistory("main", REPORT), "pages-metadata");
  }
});

it("public metadata retries only bounded temporary failures with injected time", async () => {
  const {adapter, script, clock} = setup(); script.set("", response({}, 503), response({}, 429, {"retry-after": "2"}), response(repository()));
  expect((await adapter.readEnvironment("main")).environmentId).toBe("22"); expect(clock.delays).toEqual([1000, 2000]); expect(script.calls).toHaveLength(5); safeCalls(script, clock);
  const exhausted = setup(); exhausted.script.set("", response({raw: CANARY}, 500)); await refuses(exhausted.adapter.readEnvironment("main"), "retry-exhausted");
  expect(exhausted.script.calls).toHaveLength(3); expect(exhausted.clock.delays).toEqual([1000, 2000]); safeCalls(exhausted.script, exhausted.clock);
  const ordinary403 = setup(); ordinary403.script.set("", response({raw: CANARY}, 403)); await refuses(ordinary403.adapter.readEnvironment("main"), "api-refused"); expect(ordinary403.script.calls).toHaveLength(1);
  const secondary = setup(); secondary.script.set("", response({}, 403, {"retry-after": "1"}), response(repository())); expect((await secondary.adapter.readEnvironment("main")).environmentId).toBe("22"); expect(secondary.clock.delays).toEqual([1000]);
});

it("ignored transports cancellation and partial cleanup settle with fixed secret-free diagnostics", async () => {
  const {adapter, script, clock} = setup(); script.set("", () => new Promise<HttpResponse>(() => {}));
  const operation = adapter.readEnvironment("main"); void operation.catch(() => undefined);
  for (let index = 0; index < 8 && script.calls.length === 0; index++) await Promise.resolve();
  expect(script.calls).toHaveLength(1); clock.controllers[0]?.abort(); await refuses(operation, "request-cancelled"); safeCalls(script, clock);
  const controller = new AbortController(); controller.abort(); const pre = setup(); await refuses(pre.adapter.readEnvironment("main", controller.signal), "request-cancelled"); expect(pre.script.calls).toHaveLength(0);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Fixture method is called with its clock receiver.
  const partial = setup(); const originalDeadline = partial.clock.deadline; let disposals = 0;
  partial.clock.deadline = function(ms) {const acquired = originalDeadline.call(this, ms); return {get signal(): AbortSignal {throw new Error(CANARY);}, dispose() {disposals++; acquired.dispose(); throw new Error(CANARY);}};};
  const partialAdapter = new PublicGitHubPagesMetadata({owner: "owner", repo: "site", repositoryId: "11", transport: partial.script, timing: partial.clock});
  await refuses(partialAdapter.readEnvironment("main"), "request-failed"); expect(disposals).toBe(1); expect(partial.script.calls).toHaveLength(0);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Fixture method is called with its script receiver.
  const owned = setup(); const previousRequest = owned.script.request; let rebound = 0;
  owned.script.request = function(request) {owned.script.request = () => {rebound++; return Promise.reject(new Error(CANARY));}; return previousRequest.call(this, request);};
  const captured = new PublicGitHubPagesMetadata({owner: "owner", repo: "site", repositoryId: "11", transport: owned.script, timing: owned.clock});
  expect((await captured.readEnvironment("main")).environmentId).toBe("22"); expect(rebound).toBe(0);
});

it("captures one response tuple and native bytes before foreign fulfillment can mutate them", async () => {
  const {adapter, script, clock} = setup();
  const bytes = encoder.encode(JSON.stringify(repository()));
  let statusReads=0;let headerReads=0;let bodyReads=0;let traps=0;
  Object.defineProperties(bytes,{byteLength:{get(){traps++;throw new Error(CANARY);}},constructor:{get(){traps++;throw new Error(CANARY);}},
    [Symbol.iterator]:{value(){traps++;throw new Error(CANARY);}},[Symbol.toStringTag]:{get(){traps++;throw new Error(CANARY);}}});
  const foreign:HttpResponse={get status(){statusReads++;return statusReads===1?200:503;},get headers(){headerReads++;if(headerReads!==1)throw new Error(CANARY);return {};},
    get body(){bodyReads++;if(bodyReads!==1)throw new Error(CANARY);queueMicrotask(()=>{bytes.fill(0);});return bytes;}};
  script.set("",foreign);
  expect(await adapter.readEnvironment("main")).toEqual({environmentId:"22",defaultBranch:"main"});
  expect([statusReads,headerReads,bodyReads,traps]).toEqual([1,1,1,0]);safeCalls(script,clock);
  script.set("",response(repository()));
  let rebound=0;
  script.request=()=>{rebound++;throw new Error(CANARY);};
  clock.deadline=()=>{rebound++;throw new Error(CANARY);};
  clock.delay=()=>{rebound++;throw new Error(CANARY);};
  expect((await adapter.readDeploymentHistory("main",REPORT)).current.jobId).toBe("900");
  expect(rebound).toBe(0);safeCalls(script,clock);
});

it("shares the 60 actual GET attempt cap across concurrent operations and retries", async () => {
  const {adapter,script,clock}=setup();let failures=0;
  script.set("",()=>failures++<2?response({},503):response(repository()));
  const results=await Promise.allSettled(Array.from({length:20},()=>adapter.readEnvironment("main")));
  expect(script.calls).toHaveLength(60);expect(clock.delays).toHaveLength(2);
  expect(results.some(result=>result.status==="fulfilled")).toBe(true);
  expect(results.some(result=>result.status==="rejected")).toBe(true);
  for(const result of results)if(result.status==="rejected")expect(result.reason).toMatchObject({code:"pagination-limit"});
  await refuses(adapter.readEnvironment("main"),"pagination-limit");expect(script.calls).toHaveLength(60);safeCalls(script,clock);
});

it("native cancellation bypasses overridden signal methods and cleans inserted listener hooks", async () => {
  const {adapter,script,clock}=setup();const controller=new AbortController();let touched=0;
  Object.defineProperties(controller.signal,{aborted:{get(){touched++;throw new Error(CANARY);}},
    addEventListener:{value(){touched++;throw new Error(CANARY);}},removeEventListener:{value(){touched++;throw new Error(CANARY);}}});
  script.set("",()=>new Promise<HttpResponse>(()=>{}));
  const pending=adapter.readEnvironment("main",controller.signal);void pending.catch(()=>undefined);
  for(let index=0;index<8&&script.calls.length===0;index++)await Promise.resolve();
  expect(script.calls).toHaveLength(1);controller.abort();await refuses(pending,"request-cancelled");
  expect(touched).toBe(0);expect(getEventListeners(controller.signal,"abort")).toHaveLength(0);safeCalls(script,clock);
  const broken=setup();const source=new AbortController();
  const key=Object.getOwnPropertySymbols(EventTarget.prototype).find(symbol=>symbol.description==="kNewListener");
  expect(key).toBeDefined();if(key===undefined)throw new Error("native listener hook absent");
  Object.defineProperty(source.signal,key,{value(){throw new Error(CANARY);}});
  await refuses(broken.adapter.readEnvironment("main",source.signal),"request-failed");
  expect(getEventListeners(source.signal,"abort")).toHaveLength(0);expect(broken.script.calls).toHaveLength(0);safeCalls(broken.script,broken.clock);
});

it("throwing deadline disposal and ignored retry delays settle with fixed diagnostics", async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Fixture method is called with its clock receiver.
  const broken=setup();const prior=broken.clock.deadline;
  broken.clock.deadline=function(ms){const handle=prior.call(this,ms);return {signal:handle.signal,dispose(){handle.dispose();throw new Error(CANARY);}};};
  const adapter=new PublicGitHubPagesMetadata({owner:"owner",repo:"site",repositoryId:"11",transport:broken.script,timing:broken.clock});
  await refuses(adapter.readEnvironment("main"),"request-failed");expect(broken.script.calls).toHaveLength(1);safeCalls(broken.script,broken.clock);
  const delayed=setup();const controller=new AbortController();
  delayed.script.set("",response({},503));delayed.clock.delay=()=>new Promise<void>(()=>{});
  const captured=new PublicGitHubPagesMetadata({owner:"owner",repo:"site",repositoryId:"11",transport:delayed.script,timing:delayed.clock});
  const pending=captured.readEnvironment("main",controller.signal);void pending.catch(()=>undefined);
  for(let index=0;index<30&&delayed.clock.created<2;index++)await Promise.resolve();
  expect(delayed.script.calls).toHaveLength(1);expect(delayed.clock.created).toBe(2);controller.abort();
  await refuses(pending,"request-cancelled");expect(getEventListeners(controller.signal,"abort")).toHaveLength(0);safeCalls(delayed.script,delayed.clock);
});

it("native removal hooks on caller and deadline cannot prevent cancellation settlement", async () => {
  const key=Object.getOwnPropertySymbols(EventTarget.prototype).find(symbol=>symbol.description==="kRemoveListener");
  expect(key).toBeDefined();if(key===undefined)throw new Error("native removal hook absent");
  for(const kind of ["caller","deadline"]){
    const {adapter,script,clock}=setup();const caller=new AbortController();let settled=false;let failure:unknown;let removals=0;
    script.set("",()=>new Promise<HttpResponse>(()=>{}));
    const pending=adapter.readEnvironment("main",caller.signal);
    const observed=pending.then(()=>{settled=true;},(error:unknown)=>{settled=true;failure=error;});
    for(let index=0;index<80&&script.calls.length===0;index++)await Promise.resolve();
    expect(script.calls).toHaveLength(1);const deadline=clock.controllers[0];expect(deadline).toBeDefined();
    if(deadline===undefined)throw new Error("deadline not acquired");
    const controller=kind==="caller"?caller:deadline;
    Object.defineProperty(controller.signal,key,{configurable:true,value(){removals++;throw new Error(CANARY);}});
    try{
      try{controller.abort();}catch{/* Observe settlement even if the native caller throws. */}
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Settlement callbacks run during the awaited microtasks.
      for(let index=0;index<80&&!settled;index++)await Promise.resolve();
      expect(settled).toBe(true);expect(removals).toBe(1);expect(clock.disposed).toBe(1);
      expect(failure).toBeInstanceOf(ForgeError);expect(failure).toMatchObject({code:"request-failed"});
      expect(String(failure)).not.toContain(CANARY);expect(JSON.stringify(failure)).not.toContain(CANARY);
      expect(getEventListeners(caller.signal,"abort")).toHaveLength(0);expect(getEventListeners(deadline.signal,"abort")).toHaveLength(0);
      safeCalls(script,clock);
    }finally{Reflect.deleteProperty(controller.signal,key);caller.abort();deadline.abort();await observed;}
  }
});

it("declared pagination cannot contradict a short or counted terminal page", async () => {
  const cases:[string,unknown,boolean][]=[
    ["/deployments?environment=github-pages&per_page=100&page=1",[deployment()],false],
    ["/deployments/44/statuses?per_page=100&page=1",[status()],false],
    ["/actions/runs/100/attempts/2/jobs?per_page=100&page=1",{total_count:1,jobs:[job()]},false],
    ["/environments/github-pages/deployment-branch-policies?per_page=100&page=1",policy(),true],
  ];
  for(const [path,value,isEnvironment]of cases){
    const {adapter,script,clock}=setup();
    script.set(path,response(value,200,{link:`<${API}${path.replace(/page=1$/,"page=2")}>; rel="next"`}));
    await refuses(isEnvironment?adapter.readEnvironment("main"):adapter.readDeploymentHistory("main",REPORT),"pages-metadata");
    expect(script.calls.some(call=>call.url.endsWith("page=2"))).toBe(false);safeCalls(script,clock);
  }
  const full=setup();const path="/deployments/44/statuses?per_page=100&page=1";
  full.script.set(path,response(Array.from({length:100},(_,index)=>status(1000+index)),200,{link:`<${API}${path.replace(/page=1$/,"page=2")}>; rel="next"`}));
  full.script.set(path.replace(/page=1$/,"page=2"),response([status(1100,JOB_URL,{state:"success"})]));
  expect((await full.adapter.readDeploymentHistory("main",REPORT)).current.states).toHaveLength(101);safeCalls(full.script,full.clock);
  const foreign=setup();foreign.script.set(path,response(Array.from({length:100},(_,index)=>status(1000+index)),200,{link:`<${EVIL}>; rel="next"`}));
  await refuses(foreign.adapter.readDeploymentHistory("main",REPORT),"pages-metadata");safeCalls(foreign.script,foreign.clock);
});

it("native promise observation bypasses overridden then without leaking rejected diagnostics", async () => {
  let unhandled=0;const observe=():void=>{unhandled++;};process.on("unhandledRejection",observe);
  try{
    for(const outcome of ["rejected","fulfilled"]){
      const {adapter,script,clock}=setup();let reads=0;
      script.set("",()=>{
        const promise=outcome==="rejected"?Promise.reject<HttpResponse>(new Error(CANARY)):Promise.resolve(response(repository()));
        void Object.defineProperty(promise,"then",{get(){reads++;throw new Error(CANARY);}});return promise;
      });
      if(outcome==="rejected")await refuses(adapter.readEnvironment("main"),"request-failed");
      else expect((await adapter.readEnvironment("main")).environmentId).toBe("22");
      for(let index=0;index<80;index++)await Promise.resolve();await new Promise<void>(resolve=>{setImmediate(resolve);});
      expect(unhandled).toBe(0);expect(reads).toBe(0);safeCalls(script,clock);
    }
  }finally{process.removeListener("unhandledRejection",observe);}
});

it("future last-page declarations cannot certify terminal metadata", async () => {
  const cases:[string,unknown,boolean][]=[
    ["/deployments?environment=github-pages&per_page=100&page=1",[deployment()],false],
    ["/deployments/44/statuses?per_page=100&page=1",[status()],false],
    ["/actions/runs/100/attempts/2/jobs?per_page=100&page=1",{total_count:1,jobs:[job()]},false],
    ["/environments/github-pages/deployment-branch-policies?per_page=100&page=1",policy(),true],
  ];
  for(const [path,value,isEnvironment]of cases){
    const {adapter,script,clock}=setup();
    script.set(path,response(value,200,{link:`<${API}${path.replace(/page=1$/,"page=2")}>; rel="last"`}));
    await refuses(isEnvironment?adapter.readEnvironment("main"):adapter.readDeploymentHistory("main",REPORT),"pages-metadata");
    safeCalls(script,clock);
  }
});

it("generated current and older report callers correlate their actual called project job label", async () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/report.yml", import.meta.url), "utf8");
  const projectId = /^ {2}(project):\r?$/m.exec(workflow)?.[1];
  expect(projectId).toBe("project");
  if (projectId === undefined) throw new Error("reviewed project job missing");
  // These are syntactically valid policy-test pins, not claims of built releases.
  for (const pin of [{older: false, version: "0.1.0-rc.2", releaseCommit: "a".repeat(40)},
    {older: true, version: "0.1.0-rc.1", releaseCommit: "b".repeat(40)}]) {
    const caller = renderReportCaller({releaseCommit: pin.releaseCommit, version: pin.version}, pin.older);
    const callerId = /^jobs:\r?\n {2}([a-z][a-z0-9_-]*):\r?$/m.exec(caller)?.[1];
    expect(callerId).toBe("report");
    if (callerId === undefined) throw new Error("reviewed report caller job missing");
    const label = `${callerId} / ${projectId}`;
    const {adapter, script, clock} = setup();
    const currentRun = {...run(), event: pin.older ? "workflow_dispatch" : "workflow_run"};
    script.set("/actions/runs/100", response(currentRun)).set("/actions/runs/100/attempts/2", response(currentRun));
    script.set("/actions/runs/100/attempts/2/jobs?per_page=100&page=1", response({total_count: 1, jobs: [job(900, {name: label})]}));
    expect(await adapter.readDeploymentHistory("main", REPORT)).toEqual({current: {deploymentId: "44", jobId: "900", states: ["waiting"]}, priorDeploymentIds: [], complete: true});
    expect(script.calls.some(call => call.url === `${API}/deployments/44/statuses?per_page=100&page=1`)).toBe(true);
    safeCalls(script, clock);
  }
});

it("current caller refuses wrong prefixes ambiguous names and mismatched job authority before deployment exclusion", async () => {
  const baseline = setup();
  expect((await baseline.adapter.readDeploymentHistory("main", REPORT)).current.jobId).toBe("900");
  safeCalls(baseline.script, baseline.clock);
  const refusedJobs = [
    [job(900, {name: "project / project"})],
    [job(900, {name: "untrusted / project"})],
    [job(900, {name: "report / project-extra"})],
    [job(), job(901, {runner_name: "other runner"})],
    [job(900, {run_id: 101})],
    [job(900, {run_attempt: 1})],
    [job(900, {head_sha: "b".repeat(40)})],
    [job(900, {runner_name: "other runner"})],
    [job(900, {status: "completed"})],
  ];
  for (const jobs of refusedJobs) {
    const {adapter, script, clock} = setup();
    script.set("/actions/runs/100/attempts/2/jobs?per_page=100&page=1", response({total_count: jobs.length, jobs}));
    await refuses(adapter.readDeploymentHistory("main", REPORT), "pages-metadata");
    expect(script.calls.some(call => call.url === `${API}/actions/runs/100/attempts/2/jobs?per_page=100&page=1`)).toBe(true);
    expect(script.calls.some(call => call.url.startsWith(`${API}/deployments?`))).toBe(false);
    safeCalls(script, clock);
  }
});

import { parseJson, type JsonObject, type JsonValue } from "@pixelwatch/schemas";
import { types } from "node:util";
import { ForgeError, LIMITS, sanitizeForgeError } from "./errors.ts";
import { ownResponse, signalAborted, watchSignal } from "./public-metadata-input.ts";
import { FetchTransport, RealTiming, type HttpResponse, type HttpTransport, type Timing } from "./transport.ts";
import type { DeploymentHistory, EnvironmentDeploymentState, EnvironmentMetadata, PublicMetadataOptions, PublicPagesMetadata, ReportJobIdentity } from "./public-metadata-types.ts";

const GET_HEADERS = Object.freeze({accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28"});
// eslint-disable-next-line @typescript-eslint/unbound-method -- Observe native port promises using a captured intrinsic receiver.
const promiseThen = Promise.prototype.then;
interface OwnedJson {readonly value: JsonValue; readonly headers: Readonly<Record<string, string>>}
const STATES = new Set<EnvironmentDeploymentState>(["waiting", "queued", "pending", "in_progress", "success", "failure", "error", "inactive"]);
function fail(): never {throw new ForgeError("pages-metadata");}
const object = (value: JsonValue | undefined): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  return value;
};
const integer = (value: JsonValue | undefined, minimum = 1): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return fail();
  return value;
};
const id = (value: JsonValue | undefined): string => String(integer(value));
const text = (value: JsonValue | undefined, maximum = 1024): string => {
  if (typeof value !== "string" || !value.isWellFormed() || new TextEncoder().encode(value).length > maximum) return fail();
  return value;
};
const trustedId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ForgeError("invalid-identity");
  return value;
};
const branch = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || !value.isWellFormed()
    || !/^[A-Za-z0-9_./-]+$/.test(value) || value.startsWith("/") || value.endsWith("/") || value.includes("//")
    || value.includes("..") || value.includes("@{") || value.split("/").some(part => part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) throw new ForgeError("invalid-identity");
  return value;
};
function ownReport(supplied: unknown, defaultBranch: string): ReportJobIdentity {
  try {
    if (typeof supplied !== "object" || supplied === null || types.isProxy(supplied)) throw new ForgeError("invalid-identity");
    const value = supplied as ReportJobIdentity;
    const runId = trustedId(value.runId); const attempt = value.attempt; const workflowPath = value.workflowPath;
    const workflowId = value.workflowId; const headSha = value.headSha; const ref = value.ref; const runnerName = value.runnerName;
    if (!Number.isSafeInteger(attempt) || attempt < 1 || typeof workflowPath !== "string"
      || !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}\.ya?ml$/.test(workflowPath) || workflowPath.includes("..")
      || typeof headSha !== "string" || !/^[a-f0-9]{40}$/.test(headSha) || ref !== `refs/heads/${defaultBranch}`
      || typeof runnerName !== "string" || runnerName.length === 0 || runnerName.length > 256 || !/^[\x20-\x7e]+$/.test(runnerName)) throw new ForgeError("invalid-identity");
    return Object.freeze({runId, attempt, workflowPath, headSha, ref, runnerName, ...(workflowId === undefined ? {} : {workflowId: trustedId(workflowId)})});
  } catch {throw new ForgeError("invalid-identity");}
}

/** Public GitHub.com metadata with fixed destinations and a shared actual-attempt budget. */
export class PublicGitHubPagesMetadata implements PublicPagesMetadata {
  readonly #prefix: string;
  readonly #namespace: string;
  readonly #repositoryId: string;
  readonly #request: HttpTransport["request"];
  readonly #transport: HttpTransport;
  readonly #deadline: Timing["deadline"];
  readonly #delay: Timing["delay"];
  readonly #timing: Timing;
  #attempts = 0;
  constructor(options: PublicMetadataOptions) {
    try {
      const supplied: unknown = options;
      if (typeof supplied !== "object" || supplied === null || types.isProxy(supplied)) throw new ForgeError("invalid-identity");
      const owner = options.owner; const repo = options.repo; const repositoryId = options.repositoryId;
      const transport = options.transport ?? new FetchTransport(); const timing = options.timing ?? new RealTiming();
      if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
        || typeof repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === ".."
        || types.isProxy(transport) || types.isProxy(timing)) throw new ForgeError("invalid-identity");
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured once; each invocation uses Reflect.apply with the original receiver.
      const request = transport.request;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured once; each invocation uses Reflect.apply with the original receiver.
      const deadline = timing.deadline;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured once; each invocation uses Reflect.apply with the original receiver.
      const delay = timing.delay;
      if (typeof request !== "function" || typeof deadline !== "function" || typeof delay !== "function") throw new ForgeError("invalid-identity");
      this.#prefix = `https://api.github.com/repos/${owner}/${repo}`; this.#namespace = `${owner}/${repo}`;
      this.#repositoryId = trustedId(repositoryId); this.#transport = transport; this.#request = request;
      this.#timing = timing; this.#deadline = deadline; this.#delay = delay;
    } catch {throw new ForgeError("invalid-identity");}
  }

  /** Deadline and caller cancellation settle even when a foreign port ignores the signal. */
  #bounded<T>(invoke: (signal: AbortSignal) => Promise<unknown>, capture: (value: unknown) => T, caller?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let dispose: (() => void) | undefined; const removers: (() => void)[] = []; let settled = false;
      const controller = new AbortController();
      const finish = (ok: boolean, value: unknown): void => {
        if (settled) return; settled = true; let cleanupFailed = false;
        for (const remove of removers) try {remove();} catch {cleanupFailed = true;}
        if (dispose !== undefined) try {dispose();} catch {cleanupFailed = true;}
        if (cleanupFailed) reject(new ForgeError("request-failed"));
        else if (ok) resolve(value as T);
        else reject(sanitizeForgeError(value, "request-failed"));
      };
      const cancelled = (): void => {
        // A transport may mutate its private request signal. It cannot disable the independent caller/deadline listeners.
        try {controller.abort();} catch { /* Settlement and owned cleanup still run. */ }
        finish(false, new ForgeError("request-cancelled"));
      };
      const subscribe = (signal: AbortSignal): void => {
        let acquired = false; let early = false;
        const remove = watchSignal(signal, () => {if (!acquired) early = true; else cancelled();});
        removers.push(remove); acquired = true;
        // A native registration hook can dispatch abort synchronously. Account for the
        // acquired listener before allowing settlement to perform its manual unlink.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Foreign native hooks can invoke the callback during registration.
        if (early) cancelled();
      };
      try {
        if (caller !== undefined && signalAborted(caller)) {finish(false, new ForgeError("request-cancelled")); return;}
        const suppliedHandle: unknown = Reflect.apply(this.#deadline, this.#timing, [LIMITS.requestMs]);
        if (typeof suppliedHandle !== "object" || suppliedHandle === null || types.isProxy(suppliedHandle)) throw new ForgeError("request-failed");
        const handle = suppliedHandle as ReturnType<Timing["deadline"]>;
        // Acquire disposal before the signal getter: partial acquisition must dispose exactly once.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured handle method has a stable receiver.
        const cleanup = handle.dispose;
        if (typeof cleanup !== "function") throw new ForgeError("request-failed");
        dispose = () => {Reflect.apply(cleanup, handle, []);};
        const deadlineSignal = handle.signal;
        if (signalAborted(deadlineSignal)) {cancelled(); return;}
        subscribe(deadlineSignal);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Native registration hooks can settle synchronously.
        if (!settled && caller !== undefined) subscribe(caller);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Foreign listener hooks can settle the operation synchronously.
        if (settled) return;
        if (signalAborted(deadlineSignal) || (caller !== undefined && signalAborted(caller))) {cancelled(); return;}
        const pending = invoke(controller.signal);
        if (!types.isPromise(pending) || types.isProxy(pending)) throw new ForgeError("request-failed");
        void Reflect.apply(promiseThen, pending, [(value: unknown) => {
          if (settled) return;
          try {const owned = capture(value); finish(true, owned);} catch (error) {finish(false, sanitizeForgeError(error, "request-failed"));}
        }, (error: unknown) => {finish(false, sanitizeForgeError(error, "request-failed"));}]);
      } catch (error) {finish(false, sanitizeForgeError(error, "request-failed"));}
    });
  }
  async #get(path: string, signal?: AbortSignal): Promise<OwnedJson> {
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) {
      const result = await this.#bounded(requestSignal => {
        if (this.#attempts >= 60) throw new ForgeError("pagination-limit");
        this.#attempts++;
        return Reflect.apply<HttpTransport, Parameters<HttpTransport["request"]>, Promise<HttpResponse>>(this.#request, this.#transport, [Object.freeze({method: "GET", url: `${this.#prefix}${path}`, headers: GET_HEADERS, maxBytes: LIMITS.maxJsonBytes, signal: requestSignal})]);
      }, value => ownResponse(value), signal);
      if (result.status === 200) {
        try {return {value: parseJson(result.body, {maxBytes: LIMITS.maxJsonBytes, maxDepth: 32}), headers: result.headers};}
        catch {throw new ForgeError("invalid-response");}
      }
      const after = result.headers["retry-after"];
      const retry = result.status === 429 || result.status >= 500 || (result.status === 403 && (after !== undefined || result.headers["x-ratelimit-remaining"] === "0"));
      if (!retry) throw new ForgeError("api-refused");
      if (attempt === LIMITS.maxAttempts - 1) throw new ForgeError("retry-exhausted");
      let delay = 1000 * (attempt + 1);
      if (after !== undefined) {
        if (!/^(0|[1-9][0-9]{0,4})$/.test(after) || Number(after) * 1000 > LIMITS.maxRetryDelayMs) throw new ForgeError("api-refused");
        delay = Number(after) * 1000;
      }
      await this.#bounded(requestSignal => Reflect.apply<Timing, Parameters<Timing["delay"]>, Promise<void>>(this.#delay, this.#timing, [delay, requestSignal]), () => undefined, signal);
    }
    throw new ForgeError("retry-exhausted");
  }
  #repositoryIdentity(value: JsonValue | undefined): void {
    const record = object(value);
    if (id(record["id"]) !== this.#repositoryId || text(record["full_name"]).toLowerCase() !== this.#namespace.toLowerCase()) fail();
  }
  async #repository(defaultBranch: string, signal?: AbortSignal): Promise<void> {
    const record = object((await this.#get("", signal)).value); this.#repositoryIdentity(record);
    if (record["private"] !== false || text(record["default_branch"]) !== defaultBranch) fail();
  }
  async #collection(path: string, signal?: AbortSignal, property?: string): Promise<JsonObject[]> {
    const records: JsonObject[] = []; const ids = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 11; page++) {
      const response = await this.#get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${String(page)}`, signal);
      const value = response.value;
      const hasNext = this.#nextPage(response.headers["link"], path, page);
      let items: JsonValue;
      if (property === undefined) items = value;
      else {
        const record = object(value); const count = integer(record["total_count"], 0);
        if (count > LIMITS.maxComments) throw new ForgeError("pagination-limit");
        if (total !== undefined && total !== count) fail(); total = count;
        items = record[property] ?? null;
      }
      if (!Array.isArray(items) || items.length > 100) fail();
      if (items.length > LIMITS.maxComments - records.length) throw new ForgeError("pagination-limit");
      for (const item of items) {
        const record = object(item); const itemId = id(record["id"]);
        if (ids.has(itemId)) fail(); ids.add(itemId); records.push(record);
      }
      // A positive next link cannot prove this short/count-complete page terminal. Refuse
      // contradictory metadata instead of certifying complete history or following its URL.
      if (hasNext && (items.length < 100 || (total !== undefined && records.length >= total))) fail();
      if (items.length < 100) {
        if (total !== undefined && records.length !== total) fail();
        return records;
      }
      if (total !== undefined && records.length === total) return records;
    }
    throw new ForgeError("pagination-limit");
  }
  #nextPage(link: string | undefined, path: string, page: number): boolean {
    if (link === undefined) return false;
    const expected = new URL(`${this.#prefix}${path}`); const relations = new Set<string>(); let hasNext = false; let futureLast = false;
    const parts = link.split(","); if (parts.length > 32) fail();
    for (const part of parts) {
      const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
      if (match === null || match[1] === undefined || match[2] === undefined || relations.has(match[2])) fail();
      const relation = match[2]; relations.add(relation); let url: URL;
      try {url = new URL(match[1]);} catch {return fail();}
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username !== "" || url.password !== "" || url.hash !== "") fail();
      const keys = [...url.searchParams.keys()];
      if (new Set(keys).size !== keys.length || keys.length !== [...expected.searchParams.keys()].length + 2
        || url.searchParams.get("per_page") !== "100") fail();
      for (const [key, value] of expected.searchParams) if (url.searchParams.get(key) !== value) fail();
      if (keys.some(key => key !== "per_page" && key !== "page" && !expected.searchParams.has(key))) fail();
      const suppliedPage = url.searchParams.get("page");
      if (suppliedPage === null || !/^[1-9][0-9]*$/.test(suppliedPage)) fail();
      const number = Number(suppliedPage); if (!Number.isSafeInteger(number) || number > 11) throw new ForgeError("pagination-limit");
      if ((relation === "next" && number !== page + 1) || (relation === "prev" && number !== page - 1)
        || (relation === "first" && number !== 1) || (relation === "last" && number < page)) fail();
      hasNext ||= relation === "next";
      futureLast ||= relation === "last" && number > page;
    }
    if (futureLast && !hasNext) fail();
    return hasNext;
  }
  async readEnvironment(defaultBranch: string, signal?: AbortSignal): Promise<EnvironmentMetadata> {
    try {
      const expectedBranch = branch(defaultBranch); await this.#repository(expectedBranch, signal);
      const environment = object((await this.#get("/environments/github-pages", signal)).value);
      const environmentId = id(environment["id"]); const policy = object(environment["deployment_branch_policy"]);
      if (environment["name"] !== "github-pages" || policy["protected_branches"] !== false || policy["custom_branch_policies"] !== true) fail();
      const policies = await this.#collection("/environments/github-pages/deployment-branch-policies", signal, "branch_policies");
      // Missing policy type is ambiguous; it cannot prove a literal branch-only policy.
      if (policies.length !== 1 || policies[0]?.["name"] !== expectedBranch || policies[0]["type"] !== "branch") fail();
      return Object.freeze({environmentId, defaultBranch: expectedBranch});
    } catch (error) {throw sanitizeForgeError(error, "pages-metadata");}
  }
  #run(value: JsonValue, report: ReportJobIdentity, defaultBranch: string, workflowId?: string): string {
    const record = object(value); this.#repositoryIdentity(record["repository"]); this.#repositoryIdentity(record["head_repository"]);
    const actualWorkflow = id(record["workflow_id"]);
    if (id(record["id"]) !== report.runId || integer(record["run_attempt"]) !== report.attempt
      || text(record["path"]) !== report.workflowPath || text(record["head_sha"]) !== report.headSha
      || text(record["head_branch"]) !== defaultBranch || text(object(record["head_commit"])["id"]) !== report.headSha
      || record["status"] !== "in_progress" || (record["event"] !== "workflow_run" && record["event"] !== "workflow_dispatch")
      || (workflowId !== undefined && actualWorkflow !== workflowId) || (report.workflowId !== undefined && actualWorkflow !== report.workflowId)) fail();
    return actualWorkflow;
  }
  #jobUrl(value: JsonValue | undefined): string {
    const url = text(value);
    const expectedPrefix = `https://github.com/${this.#namespace}/actions/runs/`;
    if (!url.startsWith(expectedPrefix)) fail();
    const suffix = url.slice(expectedPrefix.length);
    if (!/^[1-9][0-9]{0,15}\/job\/[1-9][0-9]{0,15}$/.test(suffix)) fail();
    const [run, job] = suffix.split("/job/"); trustedId(run); trustedId(job);
    return url;
  }
  async readDeploymentHistory(defaultBranch: string, report: ReportJobIdentity, signal?: AbortSignal): Promise<DeploymentHistory> {
    try {
      const expectedBranch = branch(defaultBranch); const ownedReport = ownReport(report, expectedBranch);
      await this.#repository(expectedBranch, signal);
      const runPath = `/actions/runs/${ownedReport.runId}`;
      const workflowId = this.#run((await this.#get(runPath, signal)).value, ownedReport, expectedBranch);
      this.#run((await this.#get(`${runPath}/attempts/${String(ownedReport.attempt)}`, signal)).value, ownedReport, expectedBranch, workflowId);
      const workflow = object((await this.#get(`/actions/workflows/${workflowId}`, signal)).value);
      if (id(workflow["id"]) !== workflowId || text(workflow["path"]) !== ownedReport.workflowPath) fail();
      const jobs = await this.#collection(`${runPath}/attempts/${String(ownedReport.attempt)}/jobs`, signal, "jobs");
      const matching = jobs.filter(job => job["name"] === "report / project");
      if (matching.length !== 1) fail();
      const job = matching[0]; if (job === undefined) fail();
      const jobId = id(job["id"]);
      if (id(job["run_id"]) !== ownedReport.runId || integer(job["run_attempt"]) !== ownedReport.attempt
        || job["runner_name"] !== ownedReport.runnerName || job["head_sha"] !== ownedReport.headSha || job["status"] !== "in_progress") fail();
      const expectedUrl = `https://github.com/${this.#namespace}/actions/runs/${ownedReport.runId}/job/${jobId}`;
      const deployments = await this.#collection("/deployments?environment=github-pages", signal);
      let current: DeploymentHistory["current"] | undefined; const priorDeploymentIds: string[] = [];
      for (const deployment of deployments) {
        const deploymentId = id(deployment["id"]);
        if (deployment["environment"] !== "github-pages" || deployment["original_environment"] !== "github-pages") fail();
        const deploymentRef = text(deployment["ref"]); const sha = text(deployment["sha"]);
        if (!/^[a-f0-9]{40}$/.test(sha)) fail();
        const statuses = await this.#collection(`/deployments/${deploymentId}/statuses`, signal);
        if (statuses.length === 0) fail();
        const states: EnvironmentDeploymentState[] = []; let claimsCurrent = false; let allCurrent = true;
        for (const status of statuses) {
          if (status["environment"] !== "github-pages" || typeof status["state"] !== "string" || !STATES.has(status["state"] as EnvironmentDeploymentState)) fail();
          const log = this.#jobUrl(status["log_url"]); const target = this.#jobUrl(status["target_url"]);
          if (log !== target) fail();
          claimsCurrent ||= log === expectedUrl; allCurrent &&= log === expectedUrl;
          states.push(status["state"] as EnvironmentDeploymentState);
        }
        if (claimsCurrent) {
          if (!allCurrent || current !== undefined || deploymentRef !== expectedBranch || sha !== ownedReport.headSha) fail();
          current = Object.freeze({deploymentId, jobId, states: Object.freeze(states)});
        } else priorDeploymentIds.push(deploymentId);
      }
      if (current === undefined) fail();
      return Object.freeze({current, priorDeploymentIds: Object.freeze(priorDeploymentIds), complete: true});
    } catch (error) {throw sanitizeForgeError(error, "pages-metadata");}
  }
}


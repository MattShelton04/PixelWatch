import { GIT_OID_PATTERN, canonicalJson, parseJson, validateDocument, type Config, type JsonObject, type JsonValue, type SourceEnvelope } from "@pixelwatch/schemas";
import { ForgeError, LIMITS } from "./errors.ts";

export interface VerifySourceInput {
  readonly event: Uint8Array;
  readonly config: Config;
  readonly configSha: string;
  readonly releaseSha: string;
  readonly signal?: AbortSignal;
}
export type SourceDiagnostic = "source-workflow-provenance-unavailable" | "pr-association-none" | "pr-association-ambiguous" | "pr-association-disagreement" | "pr-base-unavailable" | "pr-head-stale";
export interface VerifiedSource {
  readonly envelope: SourceEnvelope;
  readonly diagnostics: readonly SourceDiagnostic[];
  readonly currentHeadSha?: string;
}
interface SourceContext {
  readonly repositoryId: string;
  readonly namespace: string;
  read(path: string, signal?: AbortSignal): Promise<JsonValue>;
}
interface PullFacts {
  readonly id: string;
  readonly number: string;
  readonly head: { readonly sha: string; readonly ref: string; readonly repositoryId: string | null };
  readonly base: { readonly sha: string; readonly ref: string; readonly repositoryId: string };
}
interface RunFacts {
  readonly id: string;
  readonly workflowId: string;
  readonly attempt: string;
  readonly event: SourceEnvelope["event"];
  readonly status: string;
  readonly createdAt: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly namespace: string;
  readonly headRepositoryId: string | null;
  readonly pulls: readonly PullFacts[];
}
const object = (value: JsonValue | undefined): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ForgeError("invalid-response");
  return value;
};
const text = (value: JsonValue | undefined): string => {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value, "utf8") > 1024) throw new ForgeError("invalid-response");
  return value;
};
const id = (value: JsonValue | undefined): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ForgeError("invalid-response");
  return String(value);
};
const sha = (value: JsonValue | undefined): string => {
  const result = text(value);
  if (!GIT_OID_PATTERN.test(result)) throw new ForgeError("invalid-response");
  return result;
};
const ref = (value: JsonValue | undefined): string => {
  const result = text(value);
  if (result.length === 0 || result.length > 250 || /[\s~^:?*\\]|\p{Cc}/u.test(result) || result.includes("[") || result.includes("..") || result.includes("@{") || result.startsWith("/") || result.endsWith("/") || result.includes("//")) throw new ForgeError("invalid-response");
  return result;
};
const timestamp = (value: JsonValue | undefined): string => {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().replace(".000Z", "Z") !== result) throw new ForgeError("invalid-response");
  return result;
};
const repoId = (value: JsonValue | undefined): string | null => value === null ? null : id(object(value)["id"]);

function pullFacts(value: JsonValue): PullFacts {
  const entry = object(value);
  const head = object(entry["head"]);
  const base = object(entry["base"]);
  const baseRepository = repoId(base["repo"]);
  if (baseRepository === null) throw new ForgeError("invalid-response");
  return {
    id: id(entry["id"]), number: id(entry["number"]),
    head: { sha: sha(head["sha"]), ref: ref(head["ref"]), repositoryId: repoId(head["repo"]) },
    base: { sha: sha(base["sha"]), ref: ref(base["ref"]), repositoryId: baseRepository },
  };
}

function runFacts(value: JsonValue): RunFacts {
  const entry = object(value);
  const event = entry["event"];
  if (event !== "pull_request" && event !== "push" && event !== "workflow_dispatch") throw new ForgeError("source-policy");
  const pulls = entry["pull_requests"];
  if (!Array.isArray(pulls) || pulls.length > LIMITS.maxComments) throw new ForgeError("invalid-response");
  const headSha = sha(entry["head_sha"]);
  if (sha(object(entry["head_commit"])["id"]) !== headSha) throw new ForgeError("source-mismatch");
  const repository = object(entry["repository"]);
  return {
    id: id(entry["id"]), workflowId: id(entry["workflow_id"]), attempt: id(entry["run_attempt"]), event,
    status: text(entry["status"]), createdAt: timestamp(entry["created_at"]), headSha,
    headBranch: ref(entry["head_branch"]), path: text(entry["path"]),
    repositoryId: id(repository["id"]), namespace: text(repository["full_name"]),
    headRepositoryId: repoId(entry["head_repository"]), pulls: pulls.map(pullFacts),
  };
}

const immutable = (run: RunFacts): string => canonicalJson({
  id: run.id, workflowId: run.workflowId, event: run.event, headSha: run.headSha,
  headBranch: run.headBranch, path: run.path, repositoryId: run.repositoryId,
  namespace: run.namespace.toLowerCase(), headRepositoryId: run.headRepositoryId,
});
const associations = (run: RunFacts): string => canonicalJson([...run.pulls].sort((a, b) => Number(a.number) - Number(b.number)));
const none = (diagnostic: SourceDiagnostic, ambiguous = false): SourceEnvelope["association"] => ({ status: ambiguous ? "ambiguous" : "none", diagnostic });

async function commitPulls(context: SourceContext, head: string, signal?: AbortSignal): Promise<readonly PullFacts[]> {
  const found: PullFacts[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= Math.ceil(LIMITS.maxComments / 100); page++) {
    const value = await context.read(`/commits/${head}/pulls?per_page=100&page=${String(page)}`, signal);
    if (!Array.isArray(value) || value.length > 100 || found.length + value.length > LIMITS.maxComments) throw new ForgeError("invalid-response");
    for (const item of value) {
      const pull = pullFacts(item);
      if (seen.has(pull.id)) throw new ForgeError("invalid-response");
      seen.add(pull.id); found.push(pull);
    }
    if (value.length < 100) return found;
  }
  throw new ForgeError("pagination-limit");
}

/** Internal adapter composition; exported from this module solely for the client seam. */
export async function verifySource(context: SourceContext, input: VerifySourceInput): Promise<VerifiedSource> {
  const checked = validateDocument("config", input.config);
  if (!checked.ok) throw new ForgeError("invalid-config");
  if (typeof input.configSha !== "string" || typeof input.releaseSha !== "string" || !GIT_OID_PATTERN.test(input.configSha) || !GIT_OID_PATTERN.test(input.releaseSha)) throw new ForgeError("invalid-identity");
  let payload: JsonObject;
  try { payload = object(parseJson(input.event, { maxBytes: LIMITS.maxJsonBytes, maxDepth: 32 })); }
  catch { throw new ForgeError("source-mismatch"); }
  if (payload["action"] !== "completed") throw new ForgeError("source-mismatch");
  const requested = runFacts(payload["workflow_run"] as JsonValue);
  const eventRepository = object(payload["repository"]);
  if (requested.status !== "completed" || id(eventRepository["id"]) !== context.repositoryId || text(eventRepository["full_name"]).toLowerCase() !== context.namespace.toLowerCase() || requested.repositoryId !== context.repositoryId || requested.namespace.toLowerCase() !== context.namespace.toLowerCase()) throw new ForgeError("source-mismatch");
  if (!input.config.source.workflowIds.includes(requested.workflowId) || !input.config.source.events.includes(requested.event)) throw new ForgeError("source-policy");

  const repository = object(await context.read("", input.signal));
  if (id(repository["id"]) !== context.repositoryId || text(repository["full_name"]).toLowerCase() !== context.namespace.toLowerCase()) throw new ForgeError("source-mismatch");
  const defaultBranch = ref(repository["default_branch"]);
  const original = runFacts(await context.read(`/actions/runs/${requested.id}`, input.signal));
  const selected = runFacts(await context.read(`/actions/runs/${requested.id}/attempts/${requested.attempt}`, input.signal));
  if (immutable(original) !== immutable(requested) || immutable(selected) !== immutable(requested) || selected.attempt !== requested.attempt || Number(original.attempt) < Number(requested.attempt) || selected.status !== "completed" || associations(selected) !== associations(requested) || original.createdAt !== requested.createdAt) throw new ForgeError("source-mismatch");
  const workflow = object(await context.read(`/actions/workflows/${requested.workflowId}`, input.signal));
  if (id(workflow["id"]) !== requested.workflowId || text(workflow["path"]) !== requested.path.split("@")[0]) throw new ForgeError("source-mismatch");
  if (requested.event === "push" && requested.headBranch !== defaultBranch) throw new ForgeError("source-policy");

  const envelope: SourceEnvelope = {
    repositoryId: context.repositoryId, workflowId: requested.workflowId, runId: requested.id,
    attempt: requested.attempt, event: requested.event, createdAt: original.createdAt,
    association: { status: "none" }, commits: { head: requested.headSha },
    configSha: input.configSha, releaseSha: input.releaseSha,
  };
  const diagnostics: SourceDiagnostic[] = ["source-workflow-provenance-unavailable"];
  if (requested.event === "push") {
    const commit = object(await context.read(`/commits/${requested.headSha}`, input.signal));
    if (sha(commit["sha"]) !== requested.headSha || !Array.isArray(commit["parents"]) || commit["parents"].length > 100) throw new ForgeError("source-mismatch");
    const parents = commit["parents"].map((parent) => sha(object(parent)["sha"]));
    if (parents[0] !== undefined) envelope.commits.base = parents[0];
    return { envelope, diagnostics };
  }
  if (requested.event === "workflow_dispatch") return { envelope, diagnostics };
  const refuseAssociation = (diagnostic: SourceDiagnostic, ambiguous = false): VerifiedSource => {
    envelope.association = none(diagnostic, ambiguous); diagnostics.push(diagnostic);
    return { envelope, diagnostics };
  };
  if (selected.pulls.length === 0) return refuseAssociation("pr-association-none");
  if (selected.pulls.length !== 1) return refuseAssociation("pr-association-ambiguous", true);
  const candidate = selected.pulls[0];
  if (candidate === undefined) throw new ForgeError("invalid-response");
  if (candidate.head.sha !== requested.headSha || candidate.head.ref !== requested.headBranch || candidate.head.repositoryId === null || candidate.head.repositoryId !== selected.headRepositoryId || candidate.base.repositoryId !== context.repositoryId) return refuseAssociation("pr-association-disagreement");
  const linked = await commitPulls(context, requested.headSha, input.signal);
  if (linked.length === 0) return refuseAssociation("pr-association-none");
  if (linked.length !== 1) return refuseAssociation("pr-association-ambiguous", true);
  const corroborated = linked[0];
  if (corroborated === undefined || corroborated.id !== candidate.id || corroborated.number !== candidate.number || corroborated.head.repositoryId !== candidate.head.repositoryId || corroborated.base.repositoryId !== context.repositoryId) return refuseAssociation("pr-association-disagreement");
  const current = pullFacts(await context.read(`/pulls/${candidate.number}`, input.signal));
  if (current.id !== candidate.id || current.number !== candidate.number || current.head.repositoryId !== candidate.head.repositoryId || current.base.repositoryId !== context.repositoryId) return refuseAssociation("pr-association-disagreement");
  if (current.base.sha !== candidate.base.sha || corroborated.base.sha !== candidate.base.sha || current.base.ref !== candidate.base.ref || corroborated.base.ref !== candidate.base.ref) return refuseAssociation("pr-base-unavailable");
  const comparison = object(await context.read(`/compare/${candidate.base.sha}...${requested.headSha}`, input.signal));
  if (sha(object(comparison["base_commit"])["sha"]) !== candidate.base.sha) return refuseAssociation("pr-base-unavailable");
  envelope.commits.baseBranch = candidate.base.sha;
  envelope.commits.base = sha(object(comparison["merge_base_commit"])["sha"]);
  envelope.association = { status: "corroborated", prNumber: candidate.number };
  if (current.head.sha !== requested.headSha) diagnostics.push("pr-head-stale");
  return { envelope, diagnostics, currentHeadSha: current.head.sha };
}

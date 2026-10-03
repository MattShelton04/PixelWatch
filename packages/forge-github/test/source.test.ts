import { readFileSync } from "node:fs";
import { type Config } from "@pixelwatch/schemas";
import { describe, expect, it } from "vitest";
import { ForgeError, GitHubClient, type HttpRequest, type HttpResponse, type HttpTransport, type Timing } from "../src/index.ts";

type RecordValue = Record<string, unknown>;
const REPOSITORY = "1397668282";
const WORKFLOW = "371067781";
const API = "https://api.github.com/repos/MattShelton04/pixelwatch-spike-app";
const SHA = "a".repeat(40);
const config: Config = { schemaVersion: 1, source: { workflowIds: [WORKFLOW], events: ["pull_request", "push", "workflow_dispatch"] }, providers: [{ id: "p", shards: 1 }] };
const timing: Timing = { deadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }), delay: () => Promise.resolve() };
const json = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) });
const record = (folder: string, file: string): RecordValue => JSON.parse(readFileSync(new URL(`../../../docs/evidence/recordings/s11/${folder}/${file}.json`, import.meta.url), "utf8")) as RecordValue;
const recordedArray = (folder: string, file: string): RecordValue[] => JSON.parse(readFileSync(new URL(`../../../docs/evidence/recordings/s11/${folder}/${file}.json`, import.meta.url), "utf8")) as RecordValue[];
const obj = (value: unknown): RecordValue => value as RecordValue;

class Routes implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  readonly routes = new Map<string, HttpResponse>();
  request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    const response = this.routes.get(request.url);
    if (response === undefined) throw new Error(`unregistered test route ${request.url}`);
    return Promise.resolve(response);
  }
}

function fixture(folder = "report-36841768825-a1"): { client: GitHubClient; routes: Routes; event: RecordValue; run: RecordValue; attempt: RecordValue } {
  const routes = new Routes();
  const client = new GitHubClient({ owner: "MattShelton04", repo: "pixelwatch-spike-app", repositoryId: REPOSITORY, token: "ghs_FAKE_SOURCE_CANARY", transport: routes, timing });
  const event = record(folder, "workflow_run-event");
  const run = record(folder, "rest-run");
  const attempt = record(folder, "rest-run-attempt");
  const runId = String(run["id"]); const selectedAttempt = String(obj(event["workflow_run"])["run_attempt"]); const head = String(run["head_sha"]);
  routes.routes.set(API, json(event["repository"]));
  routes.routes.set(`${API}/actions/runs/${runId}`, json(run));
  routes.routes.set(`${API}/actions/runs/${runId}/attempts/${selectedAttempt}`, json(attempt));
  // Minimal API metadata fixtures use the independently verified workflow ID/path. The run,
  // event, association and comparison facts are the committed real S11 REST recordings.
  routes.routes.set(`${API}/actions/workflows/${WORKFLOW}`, json({ id: Number(WORKFLOW), path: ".github/workflows/s11-capture.yml", state: "active" }));
  routes.routes.set(`${API}/commits/${head}/pulls?per_page=100&page=1`, json(recordedArray(folder, "rest-commit-pulls")));
  if (run["event"] === "pull_request") {
    const pull = record(folder, "rest-pull-1");
    routes.routes.set(`${API}/pulls/1`, json(pull));
    const base = String(obj(obj((run["pull_requests"] as RecordValue[])[0])["base"])["sha"]);
    const compare = record(folder, "rest-compare-pull-1-payload-base");
    // The redacted recording stores SHA strings; production REST uses commit objects.
    routes.routes.set(`${API}/compare/${base}...${head}`, json({ ...compare, base_commit: { sha: compare["base_commit"] }, merge_base_commit: { sha: compare["merge_base_commit"] } }));
  } else {
    // Synthetic commit responses exercise first-parent semantics; no real capture output is
    // claimed for these supplemental API test fixtures.
    routes.routes.set(`${API}/commits/${head}`, json({ sha: head, parents: [{ sha: "b".repeat(40) }, { sha: "c".repeat(40) }] }));
  }
  return { client, routes, event, run, attempt };
}

const input = (event: RecordValue) => ({ event: new TextEncoder().encode(JSON.stringify(event)), config, configSha: SHA, releaseSha: "f".repeat(40) });
async function refuses(operation: Promise<unknown>, code: string): Promise<void> {
  try { await operation; throw new Error("expected refusal"); } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe(code);
    expect(String(error) + JSON.stringify(error)).not.toContain("CANARY");
  }
}

describe("authenticated source envelope", () => {
  it("replays all eight real S11 identities while preserving head, event base, merge base and original created time", async () => {
    const folders = ["report-36710676244-a1", "report-36710869758-a1", "report-36841378060-a1", "report-36841518484-a1", "report-36841619821-a1", "report-36841620239-a1", "report-36841768825-a1", "report-36842172831-a1"];
    for (const folder of folders) {
      const { client, event, run } = fixture(folder);
      const verified = await client.verifySource(input(event));
      expect(verified.envelope.runId).toBe(String(run["id"]));
      expect(verified.envelope.attempt).toBe(String(obj(event["workflow_run"])["run_attempt"]));
      expect(verified.envelope.commits.head).toBe(run["head_sha"]);
      expect(verified.envelope.createdAt).toBe(run["created_at"]);
      expect(verified.envelope.workflowSha).toBeUndefined();
      expect(verified.envelope.workflowRef).toBeUndefined();
      expect(verified.diagnostics).toContain("source-workflow-provenance-unavailable");
      if (run["event"] === "pull_request") {
        const comparison = record(folder, "rest-compare-pull-1-payload-base");
        expect(verified.envelope.association).toEqual({ status: "corroborated", prNumber: "1" });
        expect(verified.envelope.commits.base).toBe(comparison["merge_base_commit"]);
        expect(verified.envelope.commits.baseBranch).toBe(comparison["base_commit"]);
      } else {
        expect(verified.envelope.association.status).toBe("none");
        expect(verified.envelope.commits.base).toBe("b".repeat(40));
      }
    }
  });

  it("refuses unknown config versions and invalid trusted SHAs before any transport request", async () => {
    const { client, routes, event } = fixture();
    await refuses(client.verifySource({ ...input(event), config: { ...config, schemaVersion: 2 } as unknown as Config }), "invalid-config");
    await refuses(client.verifySource({ ...input(event), releaseSha: "ghs_FAKE_SOURCE_CANARY" }), "invalid-identity");
    expect(routes.calls).toHaveLength(0);
  });

  it("payload and selected attempt must match repository, workflow, run, attempt, event, ref and completed status", async () => {
    for (const [field, value] of [["id", 1], ["workflow_id", 2], ["run_attempt", 3], ["event", "push"], ["head_branch", "other"], ["head_sha", "d".repeat(40)], ["status", "in_progress"]] as const) {
      const { client, routes, event, run, attempt } = fixture();
      routes.routes.set(`${API}/actions/runs/${String(run["id"])}/attempts/2`, json({ ...attempt, [field]: value }));
      await refuses(client.verifySource(input(event)), "source-mismatch");
    }
    for (const mutate of [
      (event: RecordValue) => { obj(event["repository"])["id"] = 1; },
      (event: RecordValue) => { obj(event["workflow_run"])["repository"] = { id: 1, full_name: "attacker/target" }; },
      (event: RecordValue) => { event["action"] = "requested"; },
    ]) { const { client, event } = fixture(); mutate(event); await refuses(client.verifySource(input(event)), "source-mismatch"); }
  });

  it("disallowed workflow IDs, events and non-default push refs fail without artifacts or writes", async () => {
    const { client, event } = fixture();
    await refuses(client.verifySource({ ...input(event), config: { ...config, source: { workflowIds: ["123"], events: ["pull_request"] } } }), "source-policy");
    await refuses(client.verifySource({ ...input(event), config: { ...config, source: { workflowIds: [WORKFLOW], events: ["push"] } } }), "source-policy");
    const pushed = fixture("report-36841378060-a1");
    obj(pushed.event["workflow_run"])["head_branch"] = "feature";
    pushed.run["head_branch"] = "feature"; pushed.attempt["head_branch"] = "feature";
    pushed.routes.routes.set(`${API}/actions/runs/${String(pushed.run["id"])}`, json(pushed.run));
    pushed.routes.routes.set(`${API}/actions/runs/${String(pushed.run["id"])}/attempts/1`, json(pushed.attempt));
    await refuses(pushed.client.verifySource(input(pushed.event)), "source-policy");
    expect(pushed.routes.calls.every((call) => call.method === "GET" && !call.url.includes("artifacts"))).toBe(true);
  });

  it("an honest earlier selected attempt remains valid after the original run advances", async () => {
    const { client, routes, event, run } = fixture();
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}`, json({ ...run, run_attempt: 3, status: "in_progress" }));
    const result = await client.verifySource(input(event));
    expect(result.envelope.attempt).toBe("2");
    expect(result.envelope.createdAt).toBe("2026-10-01T09:14:57Z");
  });

  it("empty, multiple and disagreeing PR associations stay unassociated with no guessed baseline", async () => {
    for (const mode of ["none", "multiple", "disagree"]) {
      const { client, routes, event, run, attempt } = fixture();
      if (mode === "none") {
        obj(event["workflow_run"])["pull_requests"] = []; run["pull_requests"] = []; attempt["pull_requests"] = [];
      } else if (mode === "multiple") {
        const original = (run["pull_requests"] as RecordValue[])[0];
        const list = [original, { ...original, id: 123, number: 2 }];
        obj(event["workflow_run"])["pull_requests"] = list; run["pull_requests"] = list; attempt["pull_requests"] = list;
      } else { routes.routes.set(`${API}/commits/${String(run["head_sha"])}/pulls?per_page=100&page=1`, json([])); }
      routes.routes.set(`${API}/actions/runs/${String(run["id"])}`, json(run));
      routes.routes.set(`${API}/actions/runs/${String(run["id"])}/attempts/2`, json(attempt));
      const result = await client.verifySource(input(event));
      expect(result.envelope.association.status).toBe(mode === "multiple" ? "ambiguous" : "none");
      expect(result.envelope.association.prNumber).toBeUndefined();
      expect(result.envelope.commits.base).toBeUndefined();
      expect(result.envelope.commits.baseBranch).toBeUndefined();
      expect(routes.calls.some((call) => call.url.includes("/compare/"))).toBe(false);
    }
  });

  it("commit association pagination reads every bounded page and never chooses the first PR", async () => {
    const { client, routes, event, run } = fixture();
    const original = recordedArray("report-36841768825-a1", "rest-commit-pulls")[0];
    const page = Array.from({ length: 100 }, (_, index) => ({ ...original, id: index + 1, number: index + 1 }));
    routes.routes.set(`${API}/commits/${String(run["head_sha"])}/pulls?per_page=100&page=1`, json(page));
    routes.routes.set(`${API}/commits/${String(run["head_sha"])}/pulls?per_page=100&page=2`, json([{ ...original, id: 101, number: 101 }]));
    const result = await client.verifySource(input(event));
    expect(result.envelope.association.status).toBe("ambiguous");
    expect(result.envelope.association.prNumber).toBeUndefined();
    expect(routes.calls.some((call) => call.url.endsWith("page=2"))).toBe(true);
    expect(routes.calls.some((call) => call.url.includes("/pulls/1") || call.url.includes("/compare/"))).toBe(false);
  });

  it("corroborated PRs targeting another base branch use that event base rather than default main", async () => {
    const { client, routes, event, run, attempt } = fixture();
    const pulls = run["pull_requests"] as RecordValue[];
    obj(pulls[0]?.["base"])["ref"] = "release";
    obj(event["workflow_run"])["pull_requests"] = pulls; attempt["pull_requests"] = pulls;
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}`, json(run));
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}/attempts/2`, json(attempt));
    const linked = recordedArray("report-36841768825-a1", "rest-commit-pulls");
    obj(linked[0]?.["base"])["ref"] = "release";
    routes.routes.set(`${API}/commits/${String(run["head_sha"])}/pulls?per_page=100&page=1`, json(linked));
    const current = record("report-36841768825-a1", "rest-pull-1");
    obj(current["base"])["ref"] = "release"; routes.routes.set(`${API}/pulls/1`, json(current));
    expect((await client.verifySource(input(event))).envelope.association.status).toBe("corroborated");
  });

  it("payload claims and referenced called-workflow provenance never fill unavailable root fields", async () => {
    const { client, routes, event, run, attempt } = fixture();
    for (const record of [obj(event["workflow_run"]), run, attempt]) {
      record["referenced_workflows"] = [{ path: "attacker/target/.github/workflows/capture.yml@refs/heads/main", sha: "e".repeat(40), ref: "refs/heads/main" }];
      record["workflow_sha"] = "e".repeat(40);
      record["workflow_ref"] = "refs/heads/claim";
    }
    event["artifact_claims"] = { prNumber: 999, headSha: "d".repeat(40), baseSha: "e".repeat(40), repositoryId: 999 };
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}`, json(run));
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}/attempts/2`, json(attempt));
    const result = await client.verifySource(input(event));
    expect(result.envelope.workflowSha).toBeUndefined();
    expect(result.envelope.workflowRef).toBeUndefined();
    expect(result.envelope.repositoryId).toBe(REPOSITORY);
    expect(result.envelope.association.prNumber).toBe("1");
    expect(result.envelope.commits.head).toBe(run["head_sha"]);
  });

  it("stale identifiable head enters history with separate current head while changed historical base defers association", async () => {
    const { client, routes, event, run } = fixture();
    const pull = record("report-36841768825-a1", "rest-pull-1");
    obj(pull["head"])["sha"] = "d".repeat(40);
    routes.routes.set(`${API}/pulls/1`, json(pull));
    const result = await client.verifySource(input(event));
    expect(result.envelope.association.status).toBe("corroborated");
    expect(result.envelope.commits.head).toBe(run["head_sha"]);
    expect(result.currentHeadSha).toBe("d".repeat(40));
    expect(result.diagnostics).toContain("pr-head-stale");
    obj(pull["base"])["sha"] = "e".repeat(40); routes.routes.set(`${API}/pulls/1`, json(pull));
    const changed = await client.verifySource(input(event));
    expect(changed.envelope.association.status).toBe("none");
    expect(changed.envelope.commits.base).toBeUndefined();
    expect(changed.diagnostics).toContain("pr-base-unavailable");
  });

  it("merge refs and fork head repository mismatches cannot choose PR association or target", async () => {
    const { client, routes, event, run, attempt } = fixture();
    const associations = run["pull_requests"] as RecordValue[];
    obj(associations[0]?.["head"])["repo"] = { id: 123 };
    obj(event["workflow_run"])["pull_requests"] = associations; attempt["pull_requests"] = associations;
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}`, json(run));
    routes.routes.set(`${API}/actions/runs/${String(run["id"])}/attempts/2`, json(attempt));
    const result = await client.verifySource(input(event));
    expect(result.envelope.association.status).toBe("none");
    expect(result.envelope.commits.head).toBe(run["head_sha"]);
    expect(result.envelope.commits.head).not.toBe("72d8928321602732b46c5209ee6e071612538114");
  });

  it("push uses only first parent and an initial commit has no baseline; dispatch never joins a PR", async () => {
    const pushed = fixture("report-36841378060-a1"); const head = String(pushed.run["head_sha"]);
    pushed.routes.routes.set(`${API}/commits/${head}`, json({ sha: head, parents: [] }));
    expect((await pushed.client.verifySource(input(pushed.event))).envelope.commits.base).toBeUndefined();
    const dispatched = fixture();
    obj(dispatched.event["workflow_run"])["event"] = "workflow_dispatch"; dispatched.run["event"] = "workflow_dispatch"; dispatched.attempt["event"] = "workflow_dispatch";
    dispatched.routes.routes.set(`${API}/actions/runs/${String(dispatched.run["id"])}`, json(dispatched.run));
    dispatched.routes.routes.set(`${API}/actions/runs/${String(dispatched.run["id"])}/attempts/2`, json(dispatched.attempt));
    const result = await dispatched.client.verifySource(input(dispatched.event));
    expect(result.envelope.association.status).toBe("none");
    expect(result.envelope.commits.base).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { ForgeError, GitHubClient, LIMITS, type HttpRequest, type HttpResponse, type HttpTransport, type Timing } from "../src/index.ts";

const API = "https://api.github.com/repos/owner/project";
const TOKEN = "ghs_FAKE_CANARY_DO_NOT_LEAK_012345";
const SIGNED = "https://blob.invalid/archive?sig=FAKE_SIGNED_CANARY_67890";
const MARKER = "<!-- pixelwatch:repo:42 -->";
const allowMutation = () => Promise.resolve(true);

it("transport diagnostic aliases cannot expose callback fields or steer trusted request retries", async () => {
  for (const kind of ["fields", "accessors", "prototype", "unknown"] as const) {
    const supplied = kind === "prototype" ? Object.create(ForgeError.prototype) as ForgeError
      : new ForgeError(kind === "unknown" ? TOKEN as "api-refused" : "api-refused");
    let accesses = 0;
    if (kind === "fields") Object.assign(supplied, {message: TOKEN + SIGNED, stack: TOKEN + SIGNED, cause: TOKEN + SIGNED, code: "request-failed"});
    else if (kind !== "unknown") for (const name of ["name", "code", "message", "stack", "cause"]) {
      Object.defineProperty(supplied, name, {configurable: true, get() { accesses++; return TOKEN + SIGNED; }});
    }
    let requests = 0; let deadlines = 0; let disposed = 0; let delays = 0;
    const client = new GitHubClient({owner: "owner", repo: "project", repositoryId: "42", token: TOKEN,
      transport: {request: () => { requests++; return Promise.reject(supplied); }},
      timing: {deadline: () => {deadlines++; return {signal: new AbortController().signal, dispose: () => {disposed++;}};}, delay: () => {delays++; return Promise.resolve();}},
    });
    let error: unknown; try {await client.getRepository();} catch (value) {error = value;}
    expect(accesses).toBe(0); expect(error === supplied).toBe(false);
    const raw = inspect(error, {showHidden: true, depth: 8}); expect(raw.includes(TOKEN) || raw.includes(SIGNED)).toBe(false);
    expect(error).toBeInstanceOf(ForgeError); expect(Object.hasOwn(error as object, "cause")).toBe(false);
    if (kind === "fields" || kind === "accessors") {expect((error as ForgeError).code).toBe("api-refused"); expect(requests).toBe(1); expect(delays).toBe(0);}
    else {expect((error as ForgeError).code).toBe("retry-exhausted"); expect(requests).toBe(3); expect(delays).toBe(2);}
    expect(deadlines).toBe(requests); expect(disposed).toBe(requests);
  }
});

it("deadline setup and disposal failures cannot bypass fixed diagnostics or steer request retries", async () => {
  for (const stage of ["deadline", "dispose"]) {
    const supplied = new ForgeError("api-refused"); let accesses = 0; let requests = 0; let reached = 0; let delays = 0;
    for (const name of ["name", "code", "message", "stack", "cause"]) Object.defineProperty(supplied, name, {configurable: true, get() {accesses++; return TOKEN + SIGNED;}});
    const client = new GitHubClient({owner: "owner", repo: "project", repositoryId: "42", token: TOKEN,
      transport: {request: () => {requests++; return Promise.resolve(json({id: 42, full_name: "owner/project", default_branch: "main"}));}},
      timing: {deadline: () => {
        if (stage === "deadline") {reached++; throw supplied;}
        return {signal: new AbortController().signal, dispose: () => {reached++; throw supplied;}};
      }, delay: () => {delays++; return Promise.resolve();}},
    });
    let error: unknown; try {await client.getRepository();} catch (value) {error = value;}
    expect(reached).toBe(1); expect(accesses).toBe(0); expect(error === supplied).toBe(false); expect(requests).toBe(stage === "deadline" ? 0 : 1); expect(delays).toBe(0);
    const raw = inspect(error, {showHidden: true, depth: 8}); expect(raw.includes(TOKEN) || raw.includes(SIGNED)).toBe(false);
    expect(error).toBeInstanceOf(ForgeError); expect((error as ForgeError).code).toBe("api-refused"); expect(Object.hasOwn(error as object, "cause")).toBe(false);
  }
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: new TextEncoder().encode(JSON.stringify(value)) });
const artifact = (id = 1, extra = {}): unknown => ({ id, name: `part-${String(id)}`, size_in_bytes: 4, expired: false, ...extra });
const comment = (id = 1, body = `${MARKER}\nreport`, author = 7): unknown => ({ id, body, user: { id: author, login: "untrusted-login" } });

class Script implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  readonly responses: ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>)[] = [];
  add(response: HttpResponse | ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>)): this {
    this.responses.push(typeof response === "function" ? response : () => response);
    return this;
  }
  request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    return Promise.resolve(next(request));
  }
}

function setup(script = new Script(), timing?: Timing): { client: GitHubClient; script: Script; delays: number[]; disposed: number[] } {
  const delays: number[] = [];
  const disposed: number[] = [];
  const fakeTiming: Timing = timing ?? {
    deadline: (ms) => ({ signal: new AbortController().signal, dispose: () => { disposed.push(ms); } }),
    delay: (ms, signal) => { signal?.throwIfAborted(); delays.push(ms); return Promise.resolve(); },
  };
  return { client: new GitHubClient({ owner: "owner", repo: "project", repositoryId: "42", token: TOKEN, transport: script, timing: fakeTiming }), script, delays, disposed };
}

async function failure(operation: Promise<unknown>, code: string): Promise<string> {
  try { await operation; throw new Error("expected failure"); } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe(code);
    const raw = String(error) + JSON.stringify(error);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("FAKE_SIGNED_CANARY");
    return raw;
  }
}

describe("GitHub adapter boundaries", () => {
  it("artifact pagination uses bounded repository routes and never follows external Link destinations", async () => {
    const { client, script } = setup();
    script.add(json({ total_count: 2, artifacts: [artifact(1)] }, 200, { link: '<https://evil.invalid/?token=stolen>; rel="next"' }));
    script.add(json({ total_count: 2, artifacts: [artifact(2)] }));
    expect((await client.listArtifacts("99")).map((item) => item.artifactId)).toEqual(["1", "2"]);
    expect(script.calls.map((call) => call.url)).toEqual([`${API}/actions/runs/99/artifacts?per_page=100&page=1`, `${API}/actions/runs/99/artifacts?per_page=100&page=2`]);
  });

  it("artifact REST shapes reject unsafe IDs, duplicate keys, count drift, duplicate IDs and overflow", async () => {
    const bad = [
      json({ total_count: 1, artifacts: [artifact(Number.MAX_SAFE_INTEGER + 1)] }),
      { status: 200, headers: {}, body: new TextEncoder().encode('{"total_count":1,"total_count":1,"artifacts":[]}') },
      json({ total_count: 1025, artifacts: [] }),
      json({ total_count: 2, artifacts: [artifact(1), artifact(1)] }),
      json({ total_count: 1, artifacts: [artifact(1, { expired: "false" })] }),
    ];
    for (const response of bad) {
      const { client, script } = setup(); script.add(response);
      await failure(client.listArtifacts("99"), "invalid-response");
    }
    const { client, script } = setup();
    script.add(json({ total_count: 2, artifacts: [artifact(1)] })).add(json({ total_count: 1, artifacts: [artifact(2)] }));
    await failure(client.listArtifacts("99"), "invalid-response");
  });

  it("selection rejects fabricated descriptors and whole-attempt budgets before downloading", async () => {
    const { client, script } = setup();
    script.add(json({ total_count: 3, artifacts: [artifact(1, { size_in_bytes: LIMITS.maxArtifactBytes }), artifact(2, { size_in_bytes: LIMITS.maxArtifactBytes }), artifact(3)] }));
    const listed = await client.listArtifacts("99");
    const first = listed[0];
    if (first === undefined) throw new Error("test fixture missing");
    await failure(client.downloadArtifacts([{ ...first }]), "artifact-not-listed");
    await failure(client.downloadArtifacts(listed), "artifact-budget");
    expect(script.calls).toHaveLength(1);
  });

  it("selection cannot combine API-listed artifacts from different source runs", async () => {
    const { client, script } = setup();
    script.add(json({ total_count: 1, artifacts: [artifact(1)] })).add(json({ total_count: 1, artifacts: [artifact(2)] }));
    const selected = [...await client.listArtifacts("99"), ...await client.listArtifacts("98")];
    await failure(client.downloadArtifacts(selected), "artifact-not-listed");
    expect(script.calls).toHaveLength(2);
  });

  it("copies selected API-listed artifacts before asynchronous download callbacks can append forged IDs", async () => {
    const { client, script } = setup();
    script.add(json({ total_count: 1, artifacts: [artifact()] }));
    const selection = [...await client.listArtifacts("99")];
    script.add(() => { selection.push({ artifactId: "999", artifactName: "forged", sizeBytes: 1, expired: false }); return { status: 200, headers: {}, body: new Uint8Array([1]) }; });
    script.add({ status: 200, headers: {}, body: new Uint8Array([2]) });
    const downloaded = await client.downloadArtifacts(selection);
    expect(downloaded.artifacts.map((item) => item.artifactId)).toEqual(["1"]);
    expect(script.calls).toHaveLength(2);
  });

  it("manual artifact redirects permanently strip authorization across origin and redirect-back", async () => {
    const { client, script, disposed } = setup();
    script.add(json({ total_count: 1, artifacts: [artifact()] }));
    script.add({ status: 302, headers: { location: SIGNED }, body: new Uint8Array() });
    script.add({ status: 307, headers: { location: `${API}/actions/artifacts/1/zip` }, body: new Uint8Array() });
    script.add({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3, 4]) });
    const result = await client.downloadArtifacts(await client.listArtifacts("99"));
    expect(result.artifacts[0]?.zip).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(script.calls[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(script.calls[2]?.headers["authorization"]).toBeUndefined();
    expect(script.calls[3]?.headers["authorization"]).toBeUndefined();
    expect(disposed).toEqual([60_000, 60_000, 60_000, 60_000]);
    const same = setup();
    same.script.add(json({ total_count: 1, artifacts: [artifact()] }));
    same.script.add({ status: 302, headers: { location: `${API}/actions/artifacts/1/zip?download=1` }, body: new Uint8Array() });
    same.script.add({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3, 4]) });
    expect((await same.client.downloadArtifacts(await same.client.listArtifacts("99"))).artifacts).toHaveLength(1);
    expect(same.script.calls[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(same.script.calls[2]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("expired and gone artifacts remain explicit missing parts, and unavailable downloads retry only finitely", async () => {
    const { client, script, delays } = setup();
    script.add(json({ total_count: 3, artifacts: [artifact(1, { expired: true }), artifact(2), artifact(3)] }));
    script.add(json({}, 410));
    script.add(json({}, 503)).add(json({}, 503)).add(json({}, 503));
    const result = await client.downloadArtifacts(await client.listArtifacts("99"));
    expect(result.artifacts).toEqual([]);
    expect(result.missing.map((item) => item.reason)).toEqual(["expired", "unavailable", "retry-exhausted"]);
    expect(script.calls).toHaveLength(5);
    expect(delays).toEqual([1000, 2000]);
  });

  it("rate limit retry honors bounded numeric delay and errors never echo response, URL or token", async () => {
    const { client, script, delays } = setup();
    script.add(json({ message: `${TOKEN} ${SIGNED}` }, 429, { "retry-after": "2" }));
    script.add(json({ total_count: 0, artifacts: [] }));
    expect(await client.listArtifacts("99")).toEqual([]);
    expect(delays).toEqual([2000]);
    const second = setup(); second.script.add(() => { throw new Error(`${TOKEN} ${SIGNED}`); }).add(() => { throw new Error(`${TOKEN} ${SIGNED}`); }).add(() => { throw new Error(`${TOKEN} ${SIGNED}`); });
    await failure(second.client.listArtifacts("99"), "retry-exhausted");
    const third = setup(); third.script.add(json({}, 429, { "retry-after": "99999999" }));
    await failure(third.client.listArtifacts("99"), "invalid-response");
  });

  it("download refusal caps redirects, unsafe locations and actual response bytes", async () => {
    for (const location of ["http://blob.invalid/file", `https://user:${TOKEN}@blob.invalid/file`, "https://blob.invalid/file#fragment"]) {
      const { client, script } = setup(); script.add(json({ total_count: 1, artifacts: [artifact()] })).add({ status: 302, headers: { location }, body: new Uint8Array() });
      await failure(client.downloadArtifacts(await client.listArtifacts("99")), "invalid-redirect");
    }
    const bounded = setup(); bounded.script.add(json({ total_count: 1, artifacts: [artifact()] })).add({ status: 200, headers: {}, body: new Uint8Array(5) });
    await failure(bounded.client.downloadArtifacts(await bounded.client.listArtifacts("99")), "response-too-large");
    const loop = setup(); loop.script.add(json({ total_count: 1, artifacts: [artifact()] }));
    for (let i = 0; i < 4; i++) loop.script.add({ status: 302, headers: { location: SIGNED }, body: new Uint8Array() });
    await failure(loop.client.downloadArtifacts(await loop.client.listArtifacts("99")), "redirect-limit");
  });

  it("request deadlines cancel ignored transport signals and dispose timing handles", async () => {
    const controller = new AbortController(); let disposed = false;
    const { client, script } = setup(new Script(), { deadline: () => ({ signal: controller.signal, dispose: () => { disposed = true; } }), delay: () => Promise.resolve() });
    script.add(() => { controller.abort(); return new Promise<HttpResponse>(() => undefined); });
    await failure(client.listArtifacts("99"), "request-cancelled");
    expect(disposed).toBe(true);
    expect(script.calls).toHaveLength(1);
  });

  it("sticky discovery requires exact marker and numeric bot author and refuses ambiguity before mutation", async () => {
    const { client, script } = setup();
    script.add(json([comment(1, MARKER, 9), comment(2, "<!-- pixelwatch:repo:420 -->", 7), comment(3)]));
    expect((await client.discoverComment("8", "7"))?.commentId).toBe("3");
    script.add(json([comment(3), comment(4)]));
    await failure(client.reconcileComment({ prNumber: "8", botId: "7", body: `${MARKER}\nnew`, beforeMutation: allowMutation }), "comment-ambiguous");
    expect(script.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("sticky discovery paginates without trusting bot-looking logins", async () => {
    const { client, script } = setup();
    script.add(json(Array.from({ length: 100 }, (_, index) => comment(index + 1, MARKER, 9))));
    script.add(json([comment(101)]));
    expect((await client.discoverComment("8", "7"))?.commentId).toBe("101");
    expect(script.calls[1]?.url).toBe(`${API}/issues/8/comments?per_page=100&page=2`);
  });

  it("accepted comment create with lost reply is rediscovered without duplicate create", async () => {
    const { client, script } = setup(); const body = `${MARKER}\nnew`;
    script.add(json([])).add(() => { throw new Error(`${TOKEN} ${SIGNED}`); }).add(json([comment(3, body)]));
    expect(await client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation })).toEqual({ status: "recovered", commentId: "3" });
    expect(script.calls.map((call) => call.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("unknown create is never retried until successful rediscovery proves absence", async () => {
    const { client, script } = setup(); const body = `${MARKER}\nnew`;
    script.add(json([])).add(json({}, 503)).add(json([])).add(json(comment(3, body), 201));
    expect(await client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation })).toEqual({ status: "created", commentId: "3" });
    expect(script.calls.map((call) => call.method)).toEqual(["GET", "POST", "GET", "POST"]);
  });

  it("unknown comment outcomes refuse changed content, disappearing targets and rediscovery failure", async () => {
    const body = `${MARKER}\nintended`;
    for (const discovered of [[comment(3, `${MARKER}\nnewer`)], []]) {
      const { client, script } = setup();
      script.add(json([comment(3)])).add(json({}, 503)).add(json(discovered));
      await failure(client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation }), "comment-outcome");
      expect(script.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"]);
    }
    const { client, script } = setup();
    script.add(json([])).add(json({}, 503)).add(json({}, 503)).add(json({}, 503)).add(json({}, 503));
    await failure(client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation }), "retry-exhausted");
    expect(script.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("redirected rate-limit retries never regain authorization and never use wall-clock headers", async () => {
    const { client, script, delays } = setup();
    script.add(json({ total_count: 1, artifacts: [artifact()] })).add({ status: 302, headers: { location: SIGNED }, body: new Uint8Array() });
    script.add(json({}, 403, { "retry-after": "0", "x-ratelimit-reset": "9999999999" })).add({ status: 200, headers: {}, body: new Uint8Array([1]) });
    expect((await client.downloadArtifacts(await client.listArtifacts("99"))).artifacts).toHaveLength(1);
    expect(delays).toEqual([0]);
    expect(script.calls.slice(2).every((call) => call.headers["authorization"] === undefined)).toBe(true);
  });

  it("API response bytes, HTTP status and UTF-8 are checked independently of transport", async () => {
    for (const response of [
      { status: 200, headers: {}, body: new Uint8Array(LIMITS.maxJsonBytes + 1) },
      { status: 999, headers: {}, body: new Uint8Array() },
      { status: 200, headers: {}, body: new Uint8Array([0xff]) },
    ]) {
      const { client, script } = setup(); script.add(response);
      await failure(client.listArtifacts("99"), response.body.length > LIMITS.maxJsonBytes ? "response-too-large" : "invalid-response");
    }
  });

  it("comment patch targets only discovered bot-owned ID and bounds body bytes before any mutation", async () => {
    const { client, script } = setup(); const body = `${MARKER}\nnew`;
    script.add(json([comment(3)])).add(json(comment(3, body)));
    expect(await client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation })).toEqual({ status: "updated", commentId: "3" });
    expect(script.calls[1]?.url).toBe(`${API}/issues/comments/3`);
    const fresh = setup();
    await failure(fresh.client.reconcileComment({ prNumber: "8", botId: "7", body: `${MARKER}${"é".repeat(30_000)}`, beforeMutation: allowMutation }), "comment-body");
    expect(fresh.script.calls).toHaveLength(0);
  });

  it("Pages metadata accepts only Actions source and corroborated HTTPS host, never mutating settings", async () => {
    const good = setup(); good.script.add(json({ build_type: "workflow", html_url: "https://owner.github.io/project/", cname: null }));
    expect(await good.client.getPages()).toEqual({ url: "https://owner.github.io/project/", customDomain: null });
    for (const value of [
      { build_type: "legacy", html_url: "https://owner.github.io/project/", cname: null },
      { build_type: "workflow", html_url: "https://evil.invalid/project/", cname: null },
      { build_type: "workflow", html_url: "javascript:alert(1)", cname: null },
      { build_type: "workflow", html_url: "https://owner.github.io/project/?token=secret", cname: null },
    ]) { const bad = setup(); bad.script.add(json(value)); await failure(bad.client.getPages(), "pages-metadata"); expect(bad.script.calls.map((call) => call.method)).toEqual(["GET"]); }
    const absent = setup(); absent.script.add(json({}, 404)); expect(await absent.client.getPages()).toBeNull();
  });

  it("current PR metadata refuses wrong base repository and malformed heads", async () => {
    const good = setup(); good.script.add(json({ number: 8, state: "open", head: { sha: "a".repeat(40), repo: { id: 43 } }, base: { repo: { id: 42 } } }));
    expect(await good.client.getPullRequest("8")).toEqual({ prNumber: "8", state: "open", headSha: "a".repeat(40), headRepositoryId: "43" });
    const bad = setup(); bad.script.add(json({ number: 8, state: "open", head: { sha: TOKEN, repo: { id: 43 } }, base: { repo: { id: 99 } } }));
    await failure(bad.client.getPullRequest("8"), "invalid-response");
  });

  it("rechecks publisher eligibility and owned comment after backoff before every mutation", async () => {
    let head = "H1"; let guards = 0; const body = `${MARKER}\nH1`;
    const timing: Timing = { deadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }), delay: () => { head = "H2"; return Promise.resolve(); } };
    const create = setup(new Script(), timing);
    create.script.add(json([])).add(json({}, 503)).add(json([]));
    expect(await create.client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: () => { guards++; return Promise.resolve(head === "H1"); } })).toEqual({ status: "deferred" });
    expect(guards).toBe(2);
    expect(create.script.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    let commentBody = `${MARKER}\nold`; let reads = 0;
    const patchTiming: Timing = { deadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }), delay: () => { commentBody = `${MARKER}\nnewer`; return Promise.resolve(); } };
    const patch = setup(new Script(), patchTiming);
    patch.script.add(() => { reads++; return json([comment(3, commentBody)]); }).add(json({}, 503)).add(() => { reads++; return json([comment(3, commentBody)]); });
    await failure(patch.client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: allowMutation }), "comment-outcome");
    expect(reads).toBe(2);
    expect(patch.script.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("mandatory publisher mutation guard refuses absent, malformed or throwing guards without leaking errors", async () => {
    for (const guard of [undefined, () => Promise.resolve("yes"), () => { throw new Error(`${TOKEN} ${SIGNED}`); }]) {
      const { client, script } = setup(); script.add(json([]));
      await failure(client.reconcileComment({ prNumber: "8", botId: "7", body: MARKER, beforeMutation: guard as unknown as (() => Promise<boolean>) }), "comment-guard-failed");
      expect(script.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    }
  });

  it("copies trusted comment targets before asynchronous ownership checks and guards", async () => {
    const { client, script } = setup(); const body = `${MARKER}\noriginal`;
    const mutationInput = { prNumber: "8", botId: "7", body, beforeMutation: () => {
      mutationInput.prNumber = "999"; mutationInput.botId = "9"; mutationInput.body = `${MARKER}\nchanged`;
      return Promise.resolve(true);
    } };
    script.add(json([])).add(json(comment(3, body), 201));
    expect(await client.reconcileComment(mutationInput)).toEqual({ status: "created", commentId: "3" });
    expect(script.calls[1]?.url).toBe(`${API}/issues/8/comments`);
    expect(new TextDecoder().decode(script.calls[1]?.body)).toBe(JSON.stringify({ body }));
  });

  it("comment guard cannot redirect validated mutation targets or payloads", async () => {
    const { client, script } = setup(); const body = `${MARKER}\nintended`;
    script.add(json([comment(3)])).add(json(comment(3, body)));
    const result = await client.reconcileComment({ prNumber: "8", botId: "7", body, beforeMutation: (existing) => {
      if (existing === null) throw new Error("test fixture missing");
      try {
        const mutable = existing as { commentId: string; body: string };
        mutable.commentId = "999"; mutable.body = `${MARKER}\nforged`;
      } catch { /* The guard may handle a frozen snapshot; private targets still must stay owned. */ }
      return Promise.resolve(true);
    } });
    expect(result).toEqual({ status: "updated", commentId: "3" });
    expect(script.calls[1]?.url).toBe(`${API}/issues/comments/3`);
    expect(new TextDecoder().decode(script.calls[1]?.body)).toBe(JSON.stringify({ body }));
  });
});

import { describe, expect, it } from "vitest";
import { type Config } from "@pixelwatch/schemas";
import { ForgeError, GitHubClient, LIMITS, type HttpRequest, type HttpResponse, type HttpTransport, type Timing } from "../src/index.ts";

const API = "https://api.github.com/repos/owner/project";
const TOKEN = "ghs_FAKE_CONFIG_CANARY";
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const encoder = new TextEncoder();
const config: Config = { schemaVersion: 1, source: { workflowIds: ["7"], events: ["pull_request"] }, providers: [{ id: "p", shards: 1 }] };
const metadata = (branch = "main", extra = {}) => ({ id: 42, name: "project", full_name: "owner/project", owner: { login: "owner" }, default_branch: branch, ...extra });
const ref = (branch = "main", extra = {}) => ({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: SHA }, ...extra });
const json = (value: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: encoder.encode(JSON.stringify(value)) });
const raw = (value: string, status = 200): HttpResponse => ({ status, headers: {}, body: encoder.encode(value) });
const timing: Timing = { deadline: () => ({ signal: new AbortController().signal, dispose: () => undefined }), delay: () => Promise.resolve() };
class Script implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  readonly responses: ((request: HttpRequest) => HttpResponse)[] = [];
  add(response: HttpResponse | ((request: HttpRequest) => HttpResponse)): this { this.responses.push(typeof response === "function" ? response : () => response); return this; }
  request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request); const next = this.responses.shift();
    if (next === undefined) throw new Error("unexpected fixture request");
    return Promise.resolve(next(request));
  }
}
const setup = () => {
  const script = new Script();
  return { script, client: new GitHubClient({ owner: "owner", repo: "project", repositoryId: "42", token: TOKEN, transport: script, timing }) };
};
async function refuses(operation: Promise<unknown>, code: string): Promise<void> {
  try { await operation; throw new Error("expected refusal"); } catch (error) {
    expect(error).toBeInstanceOf(ForgeError); expect((error as ForgeError).code).toBe(code);
    expect(String(error) + JSON.stringify(error)).not.toContain("CANARY");
  }
}
const onlyReads = (script: Script) => { expect(script.calls.every((call) => call.method === "GET" && call.url.startsWith(API))).toBe(true); };

describe("trusted default-branch configuration", () => {
  it("reads fresh numeric repository identity and namespace without caching or caller write targets", async () => {
    const { client, script } = setup(); script.add(json(metadata())).add(json(metadata("release/next")));
    expect(await client.getRepository()).toEqual({ repositoryId: "42", owner: "owner", name: "project", defaultBranch: "main" });
    expect((await client.getRepository()).defaultBranch).toBe("release/next");
    expect(script.calls.map((call) => call.url)).toEqual([API, API]); onlyReads(script);
  });

  it("default ref movement after config SHA lookup still requests the immutable captured SHA", async () => {
    const { client, script } = setup(); let current = SHA;
    script.add(json(metadata())).add(() => { const response = json(ref()); current = NEXT_SHA; return response; });
    script.add((request) => {
      expect(current).toBe(NEXT_SHA);
      expect(request.url).toBe(`${API}/contents/.pixelwatch/config.json?ref=${SHA}`);
      expect(request.headers["accept"]).toBe("application/vnd.github.raw+json");
      return json(config);
    });
    const result = await client.readDefaultConfig();
    expect(result).toEqual({ repository: { repositoryId: "42", owner: "owner", name: "project", defaultBranch: "main" }, config, configSha: SHA });
    expect(script.calls.map((call) => call.url)).toEqual([API, `${API}/git/ref/heads/main`, `${API}/contents/.pixelwatch/config.json?ref=${SHA}`]); onlyReads(script);
  });

  it("encodes allowlisted nested default branches without accepting path query or fragment syntax", async () => {
    const { client, script } = setup(); script.add(json(metadata("release/next"))).add(json(ref("release/next"))).add(json(config));
    await client.readDefaultConfig(); expect(script.calls[1]?.url).toBe(`${API}/git/ref/heads/release/next`); onlyReads(script);
    for (const branch of ["", "../main", "main..x", "main?token=FAKE_CONFIG_CANARY", "main#fragment", "main%2fsecret", "main\\x", "refs/heads/main", "/main", "main/", "main//x", ".main", "main.lock", "main/.x", "main/x.lock", "main\n"]) {
      const bad = setup(); bad.script.add(json(metadata(branch))); await refuses(bad.client.readDefaultConfig(), "invalid-response"); expect(bad.script.calls).toHaveLength(1); onlyReads(bad.script);
    }
  });

  it("refuses wrong repository IDs namespaces defaults and response types before reading policy", async () => {
    for (const value of [metadata("main", { id: 43 }), metadata("main", { id: "42" }), metadata("main", { id: Number.MAX_SAFE_INTEGER + 1 }), metadata("main", { full_name: "evil/project" }), metadata("main", { name: "different" }), metadata("main", { owner: { login: "evil" } }), metadata("main", { default_branch: 7 }), null, [], { id: 42 }]) {
      const { client, script } = setup(); script.add(json(value)); await refuses(client.readDefaultConfig(), "invalid-response"); expect(script.calls).toHaveLength(1); onlyReads(script);
    }
    const missing = setup(); missing.script.add(raw(TOKEN, 404)); await refuses(missing.client.getRepository(), "api-refused"); onlyReads(missing.script);
  });

  it("refuses mismatched refs noncommit objects unsafe OIDs and missing default refs before policy read", async () => {
    for (const value of [ref("other"), ref("main", { object: { type: "tag", sha: SHA } }), ref("main", { object: { type: "blob", sha: SHA } }), ref("main", { object: { type: "commit", sha: TOKEN } }), ref("main", { object: { type: "commit", sha: SHA.toUpperCase() } }), ref("main", { object: { type: "commit", sha: 7 } }), [], null]) {
      const { client, script } = setup(); script.add(json(metadata())).add(json(value)); await refuses(client.readDefaultConfig(), "invalid-response"); expect(script.calls).toHaveLength(2); onlyReads(script);
    }
    const missing = setup(); missing.script.add(json(metadata())).add(raw(TOKEN, 404)); await refuses(missing.client.readDefaultConfig(), "api-refused"); expect(missing.script.calls).toHaveLength(2); onlyReads(missing.script);
  });

  it("repository and ref URL claims cannot replace the fixed API config route", async () => {
    const { client, script } = setup(); const hostile = `https://evil.invalid/?token=${TOKEN}`;
    script.add(json(metadata("main", { url: hostile, clone_url: hostile, contents_url: hostile })));
    script.add(json(ref("main", { url: hostile, object: { type: "commit", sha: SHA, url: hostile } }))).add(json(config));
    expect((await client.readDefaultConfig()).configSha).toBe(SHA);
    expect(script.calls[2]?.url).toBe(`${API}/contents/.pixelwatch/config.json?ref=${SHA}`);
    expect(JSON.stringify(script.calls.map((call) => call.url))).not.toContain("CANARY"); onlyReads(script);
  });

  it("refuses missing unknown and malformed config bytes without fallback or any mutation", async () => {
    const invalid = [
      raw(TOKEN, 404),
      json({ ...config, schemaVersion: 2 }),
      raw('{"schemaVersion":1,"schemaVersion":1,"source":{},"providers":[]}'),
      raw('{"schemaVersion":1,"__proto__":{"token":"FAKE_CONFIG_CANARY"},"source":{},"providers":[]}'),
      json({ ...config, providers: [{ id: "p", shards: 1, label: "bad\nlabel" }] }),
      json({ ...config, store: { branch: "../default" } }),
      json({ ...config, theme: { preset: "https://evil.invalid/?token=FAKE_CONFIG_CANARY" } }),
      json({ ...config, limits: { softBytes: 2_000_000, hardBytes: 1_000_000 } }),
      json({ ...config, source: { workflowIds: ["7"], events: ["pull_request_target"] } }),
      raw("[]"), raw("{invalid FAKE_CONFIG_CANARY}"),
    ];
    for (const [index, response] of invalid.entries()) {
      const { client, script } = setup(); script.add(json(metadata())).add(json(ref())).add(response);
      await refuses(client.readDefaultConfig(), index === 1 ? "unsupported-config-version" : "invalid-config");
      expect(script.calls).toHaveLength(3); onlyReads(script);
    }
  });

  it("bounds raw config response bytes to one MiB before strict parsing", async () => {
    const { client, script } = setup(); script.add(json(metadata())).add(json(ref())).add((request) => {
      expect(request.maxBytes).toBe(1024 * 1024);
      return { status: 200, headers: {}, body: new Uint8Array(LIMITS.maxJsonBytes + 1) };
    });
    await refuses(client.readDefaultConfig(), "response-too-large"); onlyReads(script);
    const exact = setup(); exact.script.add(json(metadata())).add(json(ref())).add(raw(JSON.stringify(config).padEnd(1024 * 1024, " ")));
    expect((await exact.client.readDefaultConfig()).config).toEqual(config); onlyReads(exact.script);
  });

  it("raw configuration errors never echo fake tokens signed URLs or rejected response bodies", async () => {
    for (const response of [raw(`${TOKEN} https://signed.invalid/?token=FAKE_CONFIG_CANARY`, 404), raw(`{"schemaVersion":2,"token":"${TOKEN}"}`), raw(TOKEN)]) {
      const { client, script } = setup(); script.add(json(metadata())).add(json(ref())).add(response);
      let failure: unknown;
      try { await client.readDefaultConfig(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ForgeError);
      const captured = String(failure) + JSON.stringify(failure); expect(captured).not.toContain("CANARY"); expect(captured).not.toContain("signed.invalid"); onlyReads(script);
    }
  });
});

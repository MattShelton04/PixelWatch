import { inspect } from "node:util";
import { expect, it } from "vitest";
import { ForgeError, GitHubClient, sanitizeForgeError, type HttpRequest, type HttpResponse } from "../src/index.ts";

const TOKEN = "ghs_FAKE_PUBLISHING_IDENTITY_CANARY";
const SIGNED = "https://blob.invalid/?sig=FAKE_IDENTITY_SIGNED_CANARY";
const MARKER = "<!-- pixelwatch:repo:42 -->";
const BOT = "https://api.github.com/users/github-actions%5Bbot%5D";
const json = (value: unknown, status = 200): HttpResponse => ({status, headers: {}, body: new TextEncoder().encode(JSON.stringify(value))});
function setup(responses: readonly HttpResponse[]) {
  const calls: HttpRequest[] = []; let disposals = 0; let delays = 0;
  const client = new GitHubClient({owner: "owner", repo: "project", repositoryId: "42", token: TOKEN,
    transport: {request: request => {calls.push(request); const response = responses[calls.length - 1]; if (response === undefined) throw new Error("fixture exhausted"); return Promise.resolve(response);}},
    timing: {deadline: () => ({signal: new AbortController().signal, dispose: () => {disposals++;}}), delay: () => {delays++; return Promise.resolve();}},
  });
  return {client, calls, counts: () => ({disposals, delays})};
}
async function refused(operation: Promise<unknown>, expected: string) {
  let error: unknown; try {await operation;} catch (value) {error = value;}
  expect(error).toBeDefined(); expect(sanitizeForgeError(error, "request-failed").code).toBe(expected);
  const raw = inspect(error, {showHidden: true, depth: 12});
  expect(raw).not.toContain(TOKEN); expect(raw).not.toContain(SIGNED);
}

it("publishing bot identity comes only from the fixed GitHub Actions Bot endpoint", async () => {
  const {client, calls, counts} = setup([json({id: 41898282, login: "github-actions[bot]", type: "Bot", url: SIGNED})]);
  expect(await client.getPublishingBot()).toEqual({botId: "41898282"});
  expect(calls.map(call => call.url)).toEqual([BOT]); expect(calls[0]?.method).toBe("GET");
  expect(counts()).toEqual({disposals: 1, delays: 0});
});

it("publishing bot identity refuses human aliases unsafe IDs duplicate keys and redirected identities", async () => {
  const bodies = [
    json({id: 7, login: "github-actions[bot]", type: "User"}),
    json({id: 7, login: "another-bot[bot]", type: "Bot"}),
    json({id: Number.MAX_SAFE_INTEGER + 1, login: "github-actions[bot]", type: "Bot"}),
    json({id: "41898282", login: "github-actions[bot]", type: "Bot"}),
    {status: 200, headers: {}, body: new TextEncoder().encode('{"id":7,"id":8,"login":"github-actions[bot]","type":"Bot"}')},
    {status: 302, headers: {location: SIGNED}, body: new Uint8Array()},
  ];
  for (const [index, response] of bodies.entries()) {
    const {client, calls, counts} = setup([response]);
    await refused(client.getPublishingBot(), index === bodies.length - 1 ? "api-refused" : "invalid-response");
    expect(calls.map(call => call.url)).toEqual([BOT]); expect(counts()).toEqual({disposals: 1, delays: 0});
  }
});

it("publishing bot lookup has the existing bounded rate-limit and server-error retry policy", async () => {
  const {client, calls, counts} = setup([json({}, 503), json({}, 429), json({id: 41898282, login: "github-actions[bot]", type: "Bot"})]);
  expect(await client.getPublishingBot()).toEqual({botId: "41898282"});
  expect(calls.map(call => call.url)).toEqual([BOT, BOT, BOT]); expect(counts()).toEqual({disposals: 3, delays: 2});
  const exhausted = setup([json({}, 503), json({}, 503), json({}, 503)]);
  await refused(exhausted.client.getPublishingBot(), "retry-exhausted");
  expect(exhausted.calls).toHaveLength(3); expect(exhausted.counts()).toEqual({disposals: 3, delays: 2});
});

it("definitive comment body rejection has a fixed category without retaining the response body", async () => {
  const {client, calls, counts} = setup([json([]), json({message: TOKEN + SIGNED, errors: [{field: "body"}]}, 422)]);
  let guards = 0;
  await refused(client.reconcileComment({prNumber: "8", botId: "7", body: MARKER + "\nnew", beforeMutation: () => {guards++; return Promise.resolve(true);}}), "comment-body-rejected");
  expect(guards).toBe(1); expect(calls.map(call => call.method)).toEqual(["GET", "POST"]);
  expect(counts()).toEqual({disposals: 2, delays: 0});
});

it("authorization refusal and unknown comment outcomes never masquerade as body rejection", async () => {
  const auth = setup([json([]), json({message: TOKEN + SIGNED}, 403)]);
  await refused(auth.client.reconcileComment({prNumber: "8", botId: "7", body: MARKER, beforeMutation: () => Promise.resolve(true)}), "api-refused");
  expect(auth.calls.map(call => call.method)).toEqual(["GET", "POST"]);
  const unknown = setup([json([]), json({}, 503), json([{id: 9, body: MARKER + "\nother", user: {id: 7}}])]);
  await refused(unknown.client.reconcileComment({prNumber: "8", botId: "7", body: MARKER, beforeMutation: () => Promise.resolve(true)}), "comment-outcome");
  expect(unknown.calls.map(call => call.method)).toEqual(["GET", "POST", "GET"]);
});

it("transport error cannot certify definitive HTTP422 rejection after an accepted comment", async () => {
  for (const kind of ["ordinary", "mutated", "accessors"]) {
    const supplied = new ForgeError("comment-body-rejected"); let accesses = 0;
    if (kind === "mutated") Object.assign(supplied, {message: TOKEN + SIGNED, cause: TOKEN + SIGNED, code: "api-refused"});
    if (kind === "accessors") for (const key of ["code", "message", "stack", "cause"]) Object.defineProperty(supplied, key, {get: () => {accesses++; return TOKEN + SIGNED;}});
    let stored: string | undefined; let calls = 0; let guards = 0; let disposals = 0; let delays = 0;
    const body = MARKER + "\nintended";
    const client = new GitHubClient({owner: "owner", repo: "project", repositoryId: "42", token: TOKEN,
      transport: {request: request => {calls++; if (request.method === "POST") {stored = body; return Promise.reject(supplied);} return Promise.resolve(json(stored === undefined ? [] : [{id: 9, body: stored, user: {id: 7}}]));}},
      timing: {deadline: () => ({signal: new AbortController().signal, dispose: () => {disposals++;}}), delay: () => {delays++; return Promise.resolve();}},
    });
    let result: unknown; let error: unknown;
    try {result = await client.reconcileComment({prNumber: "8", botId: "7", body, beforeMutation: () => {guards++; return Promise.resolve(true);}});} catch (value) {error = value;}
    const raw = inspect({result, error, stored}, {showHidden: true, depth: 12}); expect(raw).not.toContain(TOKEN); expect(raw).not.toContain(SIGNED);
    expect(error).toBeUndefined(); expect(result).toEqual({status: "recovered", commentId: "9"});
    expect({calls, guards, disposals, delays, accesses}).toEqual({calls: 3, guards: 1, disposals: 3, delays: 1, accesses: 0});
  }
});

it("unaccepted transport rejection needs rediscovery before a real HTTP422 can prove refusal", async () => {
  let calls = 0; let guards = 0; let delays = 0; let posts = 0;
  const client = new GitHubClient({owner: "owner", repo: "project", repositoryId: "42", token: TOKEN,
    transport: {request: request => {calls++; if (request.method !== "POST") return Promise.resolve(json([])); posts++; return posts === 1 ? Promise.reject(new ForgeError("comment-body-rejected")) : Promise.resolve(json({message: TOKEN + SIGNED}, 422));}},
    timing: {deadline: () => ({signal: new AbortController().signal, dispose: () => undefined}), delay: () => {delays++; return Promise.resolve();}},
  });
  await refused(client.reconcileComment({prNumber: "8", botId: "7", body: MARKER, beforeMutation: () => {guards++; return Promise.resolve(true);}}), "comment-body-rejected");
  expect({calls, guards, delays, posts}).toEqual({calls: 4, guards: 2, delays: 1, posts: 2});
});

it("caller and response getter exceptions cannot mint HTTP422 refusal proof", async () => {
  const first = setup([]);
  const input = {prNumber: "8", botId: "7", beforeMutation: () => Promise.resolve(true), get body(): string {throw new ForgeError("comment-body-rejected");}};
  await refused(first.client.reconcileComment(input), "request-failed"); expect(first.calls).toHaveLength(0);
  let headerReads = 0;
  const second = setup([{status: 403, get headers(): Record<string, string> {headerReads++; throw new ForgeError("comment-body-rejected");}, body: new Uint8Array()}]);
  await refused(second.client.reconcileComment({prNumber: "8", botId: "7", body: MARKER, beforeMutation: () => Promise.resolve(true)}), "request-failed");
  expect(second.calls.map(call => call.method)).toEqual(["GET"]);
  expect(headerReads).toBe(1);
});

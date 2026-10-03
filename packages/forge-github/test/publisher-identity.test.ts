import { inspect } from "node:util";
import { expect, it } from "vitest";
import { GitHubClient, sanitizeForgeError, type HttpRequest, type HttpResponse } from "../src/index.ts";

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

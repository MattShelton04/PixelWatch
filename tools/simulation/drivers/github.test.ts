import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalBytes, parseDocument } from "../../../packages/schemas/src/index.ts";
import { assertNoSecrets } from "../capture.ts";
import { SEEDS } from "../schedule.ts";
import scenario from "../scenarios/sim-github-faults.sim.test.ts";
import { runGitHubCase, type GitHubCaseKey } from "./github.ts";
import { trustedViewerAssets } from "./github-fixture.ts";
import { buildViewerAssets } from "../../viewer/build.ts";
import { CANARY_TOKEN } from "../capture.ts";

const CASE: GitHubCaseKey = "sim-github-faults/expiry-rate-limit-redirect-and-server-errors";
interface Trace {
  caseKey: string; seed: number; evidence: unknown; schedule: string[]; faults: string[];
  calls: {route: string; status: number; authorized: boolean}[];
  delays: {milliseconds: number; now: number}[];
  stored: {path: string; sha256: string}[];
  run: unknown; canonicalRunSha256: string;
  facts: {
    requestCounts: Record<string, number>; missing: {artifactId: string; reason: string}[];
    receivedParts: number; missingParts: number; unknownMissingCounts: boolean;
    actualPushes: number; closedBeforePush: boolean; nativeLease: boolean;
    decodes: number; encodes: number; compares: number; closes: number;
    pngUnchanged: boolean; sourceProvenance: boolean; rawScans: number;
  };
  deadlines: {created: number; disposed: number; fired: number};
  now: number;
}

describe("full production GitHub fault simulation (ADR 0015)", {timeout: 0}, () => {
  it("builds actual trusted viewer bytes without reading ambient credential keys", async () => {
    const original = process.env; const allowed: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {const value = original[key]; if (value !== undefined) allowed[key] = value;}
    Object.assign(allowed, {GH_TOKEN: CANARY_TOKEN, GITHUB_TOKEN: CANARY_TOKEN}); let reads = 0;
    const trapped = new Proxy(allowed, {get(target, key, receiver) {if (key === "GH_TOKEN" || key === "GITHUB_TOKEN") reads++; return Reflect.get(target, key, receiver) as string | undefined;}});
    let actual: Awaited<ReturnType<typeof trustedViewerAssets>>;
    try {process.env = trapped; actual = await trustedViewerAssets();} finally {process.env = original;}
    expect(reads).toBe(0); assertNoSecrets([actual.script]);
    const expectedEnvironment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {const value=allowed[key];if(value!==undefined)expectedEnvironment[key]=value;}
    let expected: Awaited<ReturnType<typeof buildViewerAssets>>;
    try {process.env=expectedEnvironment;expected=await buildViewerAssets("0.1.0-rc.1");}finally{process.env=original;}
    expect(Buffer.from(actual.script)).toEqual(Buffer.from(expected.script)); expect(actual.release).toBe(expected.release);
  });
  it.each(SEEDS)("full GitHub fault production ingestion is bounded incomplete and secret-free for seed %i", async (seed) => {
    const first = await runGitHubCase(CASE, seed);
    const second = await runGitHubCase(CASE, seed);
    expect(second.normalized).toBe(first.normalized);
    expect(second.evidence).toEqual(first.evidence);
    assertNoSecrets([first.normalized, JSON.stringify(first.evidence)]);
    scenario.cases[0]?.verify(first.evidence);
    const trace = JSON.parse(first.normalized) as Trace;
    expect(trace.caseKey).toBe(CASE); expect(trace.seed).toBe(seed);
    expect(trace.schedule.length).toBeGreaterThan(0);
    expect(trace.faults).toEqual(["a:github-redirect:1:fail-before"]);
    expect(trace.facts.requestCounts).toEqual({expired: 0, gone: 1, secondary: 3, rate: 3, server500: 3, server502: 3, server503: 3, redirect: 1, signed: 1});
    expect(trace.facts.missing).toEqual([
      {artifactId: "201", reason: "expired"}, {artifactId: "202", reason: "unavailable"},
      ...["203", "204", "205", "206", "207"].map(artifactId => ({artifactId, reason: "retry-exhausted"})),
    ]);
    expect(trace.calls.filter(call => call.route === "redirect" || call.route === "signed").map(call => call.authorized)).toEqual([true, false]);
    expect(trace.delays.map(delay => delay.milliseconds)).toEqual([2000, 2000, 2000, 2000, 1000, 2000, 1000, 2000, 1000, 2000]);
    expect(trace.now).toBe(946684817000);
    expect(trace.facts).toMatchObject({receivedParts: 1, missingParts: 7, unknownMissingCounts: true, actualPushes: 1,
      closedBeforePush: true, nativeLease: true, decodes: 1, encodes: 1, compares: 0, closes: 1, pngUnchanged: true, sourceProvenance: true});
    expect(trace.facts.rawScans).toBeGreaterThan(10);
    expect(trace.deadlines.created).toBeGreaterThan(20);
    expect(trace.deadlines.disposed).toBe(trace.deadlines.created); expect(trace.deadlines.fired).toBe(0);
    const run = parseDocument("run", canonicalBytes(trace.run)); expect(run.ok).toBe(true);
    if (!run.ok) throw new Error("github-simulation-run-invalid");
    expect(run.value.coverage.status).toBe("incomplete"); expect(run.value.coverage.missingParts).toHaveLength(7);
    expect(run.value.parts).toHaveLength(1); expect(run.value.parts[0]?.artifactId).toBe("208");
    expect(trace.canonicalRunSha256).toBe(createHash("sha256").update(canonicalBytes(run.value)).digest("hex"));
    expect(trace.stored.map(file => file.path).sort()).toEqual([
      expect.stringMatching(/^blobs\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/), "data/v1/runs/101-a1/run.json", "store.json",
    ]);
    const output = `${CASE} seed=${String(seed)} trace-sha256=${createHash("sha256").update(first.normalized).digest("hex")} facts=${JSON.stringify(trace.facts)} deadlines=${JSON.stringify(trace.deadlines)}`;
    assertNoSecrets([output]); process.stdout.write(`${output}\n`);
  });
});

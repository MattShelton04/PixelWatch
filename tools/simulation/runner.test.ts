// Runner orchestration probes, not product scenario acceptance. CLI uses the frozen real registry.
import { expect, it } from "vitest";
import { runSimulation, type ProductDriver } from "./runner.ts";
import { CANARY_TOKEN } from "./capture.ts";
import { SEEDS } from "./schedule.ts";

const checks = [{name: "runner-probe", run() {}}];
const key = "sim-push-outcome-unknown/accepted-push";
const valid: ProductDriver = (seed) => {
  const evidence = {events: [{kind: "push" as const, actor: "a"}, {kind: "fetch" as const, actor: "a"}, {kind: "fetch" as const, actor: "a"}], runs: ["101-a1"], attempts: [1], beforeTip: "tip", afterTip: "tip"};
  return Promise.resolve({evidence, normalized: JSON.stringify({caseKey: key, seed, evidence})});
};

it("runner awaits every seed twice validates registered evidence and lists all thirteen unavailable cases", async () => {
  const calls: number[] = [];
  const driver: ProductDriver = async (seed) => { calls.push(seed); return await valid(seed); };
  const result = await runSimulation(checks, new Map([[key, driver]]));
  expect(calls).toEqual(SEEDS.flatMap((seed) => [seed, seed])); expect(result.code).toBe(2);
  expect(result.output).toContain(`PRODUCT PASS ${key}`); expect(result.output).toContain("1 ran, 1 passed, 0 failed, 13 NOT RUN");
  expect(result.output.match(/^NOT RUN /gm)).toHaveLength(13); expect(result.output).not.toContain("HARNESS ONLY");
});

it("invalid product evidence cannot pass and failure takes precedence over incomplete coverage", async () => {
  const bad: ProductDriver = (seed) => Promise.resolve({evidence: {}, normalized: JSON.stringify({caseKey: key, seed, evidence: {}})});
  const result = await runSimulation(checks, new Map([[key, bad]]));
  expect(result.code).toBe(1); expect(result.output).toContain(`PRODUCT FAIL ${key} seed=1 repeat=1`); expect(result.output).not.toContain(`PRODUCT PASS ${key}`);
});

it("normalized replay disagreement refuses a product pass and prints the failing seed", async () => {
  let serial = 0;
  const bad: ProductDriver = async (seed) => { const result = await valid(seed); return {...result, normalized: JSON.stringify({...JSON.parse(result.normalized) as Record<string, unknown>, serial: serial++})}; };
  const result = await runSimulation(checks, new Map([[key, bad]]));
  expect(result.code).toBe(1); expect(result.output).toContain("seed=1 repeat=2"); expect(result.output).not.toContain(`PRODUCT PASS ${key}`);
});

it("raw product evidence is scanned before capture redaction and unsafe driver registries refuse", async () => {
  const leaking: ProductDriver = async (seed) => { const result = await valid(seed); return {...result, evidence: {...result.evidence, summary: CANARY_TOKEN}}; };
  const result = await runSimulation(checks, new Map([[key, leaking]]));
  expect(result.code).toBe(1); expect(result.output).not.toContain(CANARY_TOKEN); expect(result.output).toContain("secret-leak");
  expect((await runSimulation(checks, new Map([["fake-case", valid]]))).code).toBe(1);
  expect((await runSimulation([], new Map())).code).toBe(1);
});

// Direct Node entry point; the same no-network guard as Vitest is active before any check.
import "../lib/no-network.ts";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Capture, assertNoSecrets } from "./capture.ts";
import { harnessChecks, type HarnessCheck } from "./checks.ts";
import { SEEDS } from "./schedule.ts";
import { scenarios } from "./scenarios/index.ts";
import { runStoreCase } from "./drivers/store.ts";
import type { Evidence } from "./scenarios/spec.ts";
const EXPECTED = ["sim-ingest-cas-race", "sim-push-outcome-unknown", "sim-lease-exhausted", "sim-deploy-comment-race",
  "sim-comment-unknown-outcome", "sim-deploy-fails", "sim-cdn-stale-generation", "sim-viewer-stale-assets",
  "sim-migration-vs-writer", "sim-github-faults", "sim-unknown-version"];
export type ProductDriver = (seed: number) => Promise<{evidence: Evidence; normalized: string}>;
const productDrivers: ReadonlyMap<string, ProductDriver> = new Map([
  ["sim-ingest-cas-race/four-writers", (seed: number) => runStoreCase("sim-ingest-cas-race/four-writers", seed)],
  ["sim-push-outcome-unknown/accepted-push", (seed: number) => runStoreCase("sim-push-outcome-unknown/accepted-push", seed)],
]);
export const productCaseKeys: readonly string[] = Object.freeze([...productDrivers.keys()]);
/** Injectable runner probes are unit orchestration checks; the CLI always uses production drivers. */
export async function runSimulation(checks: readonly HarnessCheck[] = harnessChecks, callerDrivers: ReadonlyMap<string, ProductDriver> = productDrivers): Promise<{ code: number; output: string }> {
  // Private records before any injected callback or await: exported spec objects are mutable.
  const ids = scenarios.map((scenario) => scenario.id);
  const manifest = scenarios.flatMap((scenario) => scenario.cases.map((test) => ({
    id: scenario.id, name: test.name, requires: [...test.requires], verify: test.verify,
  })));
  const seeds = [...SEEDS];
  const checkRecords = checks.map((check) => ({name: check.name, run: check.run}));
  const drivers = new Map(callerDrivers);
  const capture = new Capture();
  const lines = [drivers.size === 0 ? "PixelWatch local simulation: HARNESS ONLY; product coverage reported below." : "PixelWatch local simulation: real product drivers and full coverage report.", `Seeds: ${seeds.join(", ")}; every product case repeats each seed twice.`];
  let failed = 0;
  const keys = manifest.map((test) => `${test.id}/${test.name}`);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED) || keys.length !== 14 || JSON.stringify(seeds) !== "[1,42,1592594996,4294967295]" || checkRecords.length === 0 || [...drivers].some(([key, driver]) => !keys.includes(key) || typeof driver !== "function")) {
    return { code: 1, output: "simulation-manifest-invalid; nothing may be reported as passed.\n" };
  }
  for (const check of checkRecords) {
    try {
      const evidence = check.run();
      if (evidence !== undefined && (typeof evidence !== "string" || !/^[0-9a-f]{64}$/.test(evidence))) throw new Error("invalid-harness-evidence");
      lines.push(`HARNESS PASS ${check.name}${evidence === undefined ? "" : ` trace-sha256=${evidence}`}`);
    }
    catch (error) {
      failed++;
      capture.error(error);
      lines.push(`HARNESS FAIL ${check.name}: ${capture.errors.at(-1) ?? "unknown-error"}`);
    }
  }
  let unavailable = 0; let ran = 0; let passed = 0; let productFailed = 0;
  for (const test of manifest) {
    const key = `${test.id}/${test.name}`; const driver = drivers.get(key);
    if (driver === undefined) { unavailable++; lines.push(`NOT RUN ${key}: requires ${test.requires.join(" + ")}; production adapter unavailable`); continue; }
    ran++; let caseFailed = false; const hashes: string[] = [];
    for (const seed of seeds) {
      let first: string | undefined;
      for (const repeat of [1, 2]) {
        try {
          const result = await driver(seed);
          assertNoSecrets([JSON.stringify(result.evidence), result.normalized]); // Before Capture redaction.
          test.verify(result.evidence);
          const normalized: unknown = JSON.parse(result.normalized);
          if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) throw new Error("invalid-normalized-evidence");
          const value = normalized as Record<string, unknown>;
          if (value["caseKey"] !== key || value["seed"] !== seed || JSON.stringify(value["evidence"]) !== JSON.stringify(result.evidence)) throw new Error("normalized-evidence-mismatch");
          if (repeat === 1) first = result.normalized;
          else if (first === undefined || first !== result.normalized) throw new Error("normalized-replay-mismatch");
          hashes.push(`seed=${String(seed)} repeat=${String(repeat)} trace-sha256=${createHash("sha256").update(result.normalized).digest("hex")}`);
        } catch (error) {
          caseFailed = true;
          let diagnostic = error;
          try { assertNoSecrets([error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)]); } catch { diagnostic = new Error("simulation-secret-leak"); }
          capture.error(diagnostic);
          lines.push(`PRODUCT FAIL ${key} seed=${String(seed)} repeat=${String(repeat)}: ${capture.errors.at(-1) ?? "unknown-error"}`);
        }
      }
    }
    if (caseFailed) productFailed++;
    else { passed++; lines.push(`PRODUCT PASS ${key}: ${hashes.join("; ")}`); }
  }
  const code = failed > 0 || productFailed > 0 ? 1 : unavailable > 0 ? 2 : 0;
  lines.push(`Harness checks: ${String(checkRecords.length - failed)} passed, ${String(failed)} failed. Product cases: ${String(ran)} ran, ${String(passed)} passed, ${String(productFailed)} failed, ${String(unavailable)} NOT RUN (${String(ids.length)} scenario IDs).`);
  if (unavailable > 0) lines.push("PRODUCT COVERAGE INCOMPLETE. Harness evidence does not satisfy product scenario acceptance.");
  else if (code === 0) lines.push("PRODUCT COVERAGE COMPLETE: every registered case ran and passed.");
  lines.push(`Exit ${String(code)}.`);
  capture.assertClean();
  const output = lines.join("\n") + "\n";
  assertNoSecrets([output]);
  return { code, output };
}
export async function main(argv: readonly string[], write: (value: string) => void): Promise<number> {
  if (argv.length !== 0) {
    write("Usage: pnpm -s test:simulation\nNo scenario ran; help or unknown arguments exit 4.\n"); return 4;
  }
  try { const result = await runSimulation(); write(result.output); return result.code; }
  catch { write("simulation-internal-error; product coverage unknown; exit 1.\n"); return 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2), (value) => process.stdout.write(value));

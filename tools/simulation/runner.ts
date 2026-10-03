// Direct Node entry point; the same no-network guard as Vitest is active before any check.
import "../lib/no-network.ts";
import { pathToFileURL } from "node:url";
import { Capture, assertNoSecrets } from "./capture.ts";
import { harnessChecks, type HarnessCheck } from "./checks.ts";
import { SEEDS } from "./schedule.ts";
import { scenarios } from "./scenarios/index.ts";
const EXPECTED = ["sim-ingest-cas-race", "sim-push-outcome-unknown", "sim-lease-exhausted", "sim-deploy-comment-race",
  "sim-comment-unknown-outcome", "sim-deploy-fails", "sim-cdn-stale-generation", "sim-viewer-stale-assets",
  "sim-migration-vs-writer", "sim-github-faults", "sim-unknown-version"];
export function runSimulation(checks: readonly HarnessCheck[] = harnessChecks): { code: number; output: string } {
  const capture = new Capture();
  const lines = ["PixelWatch local simulation: HARNESS ONLY; product coverage reported below.", `Seeds: ${SEEDS.join(", ")}`];
  let failed = 0;
  const ids = scenarios.map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED) || scenarios.flatMap((s) => s.cases).length !== 14 || checks.length === 0) {
    return { code: 1, output: "simulation-manifest-invalid; nothing may be reported as passed.\n" };
  }
  for (const check of checks) {
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
  let unavailable = 0;
  for (const scenario of scenarios) for (const test of scenario.cases) {
    unavailable++;
    lines.push(`NOT RUN ${scenario.id}/${test.name}: requires ${test.requires.join(" + ")}; production adapter unavailable`);
  }
  lines.push(`Harness checks: ${String(checks.length - failed)} passed, ${String(failed)} failed. Product cases: 0 ran, ${String(unavailable)} NOT RUN (${String(scenarios.length)} scenario IDs).`);
  lines.push("PRODUCT COVERAGE INCOMPLETE. Harness evidence does not satisfy product scenario acceptance.");
  lines.push(`Exit ${failed > 0 ? "1" : "2"}.`);
  capture.assertClean();
  const output = lines.join("\n") + "\n";
  assertNoSecrets([output]);
  return { code: failed > 0 ? 1 : 2, output };
}
export function main(argv: readonly string[], write: (value: string) => void): number {
  if (argv.length !== 0) {
    write("Usage: pnpm -s test:simulation\nNo scenario ran; help or unknown arguments exit 4.\n"); return 4;
  }
  try { const result = runSimulation(); write(result.output); return result.code; }
  catch { write("simulation-internal-error; product coverage unknown; exit 1.\n"); return 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2), (value) => process.stdout.write(value));

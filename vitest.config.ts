import { defineConfig } from "vitest/config";

const include = ["tools/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"];
// Native Git fixtures own real child processes and temporary repositories. Run them in a
// separate, serial phase, after CPU-heavy PNG/property tests have finished. This changes
// file scheduling only: actors inside each harmful-interleaving test still run together.
const native = [
  "packages/store/test/**/*.test.ts",
  "packages/publisher/test/admission.test.ts",
  "packages/publisher/test/ingest-job.test.ts",
  "packages/publisher/test/maintenance.test.ts",
  "tools/simulation/**/*.test.ts",
  "tools/release/**/*.test.ts",
];
const shared = {
  include,
  // Adapter-backed product specifications have their own fail-closed runner. No skip/todo.
  exclude: ["tools/simulation/scenarios/**/*.sim.test.ts"],
  // An empty run is a failure, never a pass (07: a skipped test is not green).
  passWithNoTests: false,
  // `pnpm check` has no network (07 §1). Every test file runs behind this guard.
  setupFiles: ["tools/lib/no-network.ts"],
  // Seeded, replayable property tests: fast-check prints the seed and path on failure.
  testTimeout: 30_000,
};

export default defineConfig({
  test: {
    // Keep discovery local to each project. Vitest concatenates inherited include arrays;
    // a global include would otherwise make the native project rediscover every unit file.
    projects: [
      { test: { ...shared, name: "unit", exclude: [...shared.exclude, ...native], sequence: { groupOrder: 0 } } },
      { test: { ...shared, name: "native", include: native, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});

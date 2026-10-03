import { defineConfig } from "vitest/config";

const include = ["tools/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "actions/publish/test/**/*.test.ts"];
// Native fixtures own real children and scratch directories. Their separate serial phase
// preserves concurrent actors inside each harmful-interleaving test.
const native = [
  "packages/store/test/**/*.test.ts",
  "packages/publisher/test/admission.test.ts",
  "packages/publisher/test/ingest-job.test.ts",
  "packages/publisher/test/maintenance.test.ts",
  "tools/simulation/**/*.test.ts",
  "tools/release/**/*.test.ts",
  "actions/publish/test/**/*.test.ts",
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

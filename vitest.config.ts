import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Adapter-backed product specifications have their own fail-closed runner. No skip/todo.
    exclude: ["tools/simulation/scenarios/**/*.sim.test.ts"],
    // An empty run is a failure, never a pass (07: a skipped test is not green).
    passWithNoTests: false,
    // `pnpm check` has no network (07 §1). Every test file runs behind this guard.
    setupFiles: ["tools/lib/no-network.ts"],
    // Seeded, replayable property tests: fast-check prints the seed and path on failure.
    testTimeout: 30_000,
  },
});

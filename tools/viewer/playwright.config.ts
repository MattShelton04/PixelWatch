import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: fileURLToPath(new URL("../../packages/viewer/test/browser/", import.meta.url)),
  testMatch: "**/*.spec.ts", outputDir: ".tools/viewer-results", fullyParallel: false,
  workers: 1, retries: 0, forbidOnly: true, timeout: 30_000,
  reporter: [["line"], ["json", {outputFile: ".tools/viewer-results/report.json"}]],
  projects: [
    {name: "chromium", use: {...devices["Desktop Chrome"]}},
    {name: "firefox", use: {...devices["Desktop Firefox"]}},
    {name: "webkit", use: {...devices["Desktop Safari"]}},
  ],
});

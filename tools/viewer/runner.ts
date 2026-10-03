import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

if (process.argv.length !== 2) {
  process.stderr.write("Usage: pnpm test:viewer (all three engines, no filters)\nNothing ran.\n"); process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment["PLAYWRIGHT_BROWSERS_PATH"] = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? resolve(root, ".tools/playwright");
  const code = await new Promise<number>((done) => {
    const child = spawn(process.execPath, [resolve(root, "node_modules/@playwright/test/cli.js"), "test", "--config", resolve(root, "tools/viewer/playwright.config.ts")], {cwd: root, env: environment, stdio: "inherit"});
    child.once("error", () => { done(1); }); child.once("exit", (value) => { done(value ?? 1); });
  });
  // An empty engine, skip, unexpected or unexecuted case cannot become a green viewer result.
  try {
    const report: unknown = JSON.parse(readFileSync(resolve(root, ".tools/viewer-results/report.json"), "utf8"));
    const projects = new Map<string, number>(); const flags = {invalid: false};
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const item = value as Record<string, unknown>;
      if (typeof item["projectName"] === "string" && "results" in item) {
        const results = item["results"];
        if (item["status"] !== "expected" || !Array.isArray(results) || results.length !== 1 || typeof results[0] !== "object" || results[0] === null || (results[0] as Record<string, unknown>)["status"] !== "passed") flags.invalid = true;
        projects.set(item["projectName"], (projects.get(item["projectName"]) ?? 0) + 1);
      }
      for (const nested of Object.values(item)) visit(nested);
    }; visit(report);
    if (projects.size !== 3 || ["chromium", "firefox", "webkit"].some((name) => (projects.get(name) ?? 0) === 0) || new Set(projects.values()).size !== 1 || flags.invalid) throw new Error("viewer coverage incomplete");
    process.exitCode = code;
  } catch { process.stderr.write("Viewer coverage incomplete: every case must execute and pass in Chromium, Firefox and WebKit.\n"); process.exitCode = 1; }
}

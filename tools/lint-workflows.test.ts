import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/lint-tools.ts";
import { runActionlint, runZizmor, workflowTargets } from "./lint-workflows.ts";
import { assertNoSecrets, CANARY_TOKEN } from "./simulation/capture.ts";

const fixtures = "testdata/smoke/workflows";

describe("workflow linters", () => {
  it("lint this repo's workflows and the adopter template", () => {
    expect(workflowTargets()).toEqual(
      expect.arrayContaining([
        ".github/workflows/ci.yml",
        ".github/workflows/codeql.yml",
        ".github/workflows/dependency-review.yml",
        "docs/templates/pixelwatch-capture.yml",
      ]),
    );
  });

  it("zizmor flags the insecure fixture offline", () => {
    const result = runZizmor([`${fixtures}/insecure.yml`], ["--format", "json"]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const findings = JSON.parse(result.stdout) as { ident: string }[];
    const audits = new Set(findings.map((finding) => finding.ident));
    for (const audit of [
      "dangerous-triggers",
      "artipacked",
      "unpinned-uses",
      "template-injection",
      "excessive-permissions",
    ]) {
      expect(audits, audit).toContain(audit);
    }
  });

  it("actionlint rejects the broken fixture", () => {
    const result = runActionlint([`${fixtures}/broken.yml`]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('undefined variable "unknown_context"');
  });
});

describe("workflow lint CLI reviewed-source consumer", () => {
  function fixture(): { root: string; report: string } {
    const root = mkdtempSync(path.join(tmpdir(), "pw-lint-policy-"));
    for (const directory of ["tools/lib", "tools/release", ".github/workflows"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    // Execute the actual CLI and root-discovery module. The policy re-export supplies the
    // independently reviewed implementation without inventing a fixture publisher or linter.
    for (const file of ["tools/lint-workflows.ts", "tools/lib/lint-tools.ts", "tools/lint-tools.json"]) {
      writeFileSync(path.join(root, file), readFileSync(path.join(repoRoot, file)), { flag: "wx" });
    }
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', { flag: "wx" });
    const policyUrl = pathToFileURL(path.join(repoRoot, "tools/release/workflow-policy.ts")).href;
    writeFileSync(path.join(root, "tools/release/workflow-policy.ts"), `export * from ${JSON.stringify(policyUrl)};\n`, { flag: "wx" });
    const report = path.join(root, ".github/workflows/report.yml");
    writeFileSync(report, readFileSync(path.join(repoRoot, ".github/workflows/report.yml")), { flag: "wx" });
    return { root, report };
  }
  function child(root: string) {
    const environment: Record<string, string> = { GH_TOKEN: CANARY_TOKEN, GITHUB_TOKEN: CANARY_TOKEN };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR"]) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(repoRoot, "tools/lib/no-network.ts")).href, path.join(root, "tools/lint-workflows.ts")], {
      cwd: root, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true,
    });
    assertNoSecrets([result.stdout, result.stderr, inspect(result.error, { depth: 4 })]);
    expect(result.error).toBeUndefined();
    return result;
  }
  function valid(root: string): void {
    const result = child(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not installed");
    expect(result.stderr).not.toContain("reviewed-contract-refused");
  }
  function refused(root: string): void {
    const result = child(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workflow-policy: reviewed-contract-refused");
    expect(result.stderr).not.toContain("is not installed");
    expect(result.stdout).not.toContain("linting ");
  }
  it("checks actual reviewed workflow bytes before resolving or executing either linter", () => {
    const { root, report } = fixture();
    try {
      valid(root);
      const source = readFileSync(report, "utf8");
      for (const changed of [
        source.replace("cancel-in-progress: false", "cancel-in-progress: true"),
        source.replace("steps.self.outputs.sha", "github.sha"),
        source.replace("steps.self.outputs.repository", "github.repository"),
        source.replace("needs.ingest.result == 'success' && needs.ingest.outputs.project == 'true'", "always()"),
        source.replace("pixelwatch-project-${{ github.repository_id }}", "pixelwatch-project-${{ github.workflow_sha }}"),
        source + "# unreviewed source retains annotations\n",
      ]) {
        expect(changed).not.toBe(source);
        writeFileSync(report, changed);
        refused(root);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("missing and over-bound report sources refuse before tool lookup or a zero-target pass", () => {
    const { root, report } = fixture();
    try {
      valid(root);
      rmSync(report);
      refused(root);
      writeFileSync(report, new Uint8Array(65_537), { flag: "wx" });
      refused(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("capture template (M0.2: read-only, no secrets)", () => {
  const template = readFileSync(
    path.join(repoRoot, "docs", "templates", "pixelwatch-capture.yml"),
    "utf8",
  );
  const code = template
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

  it("grants only contents: read at the top level and nowhere else", () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
    expect(code).not.toMatch(/:\s*write\b/);
  });

  it("uses no secrets, environments or pull_request_target", () => {
    expect(code).not.toMatch(/secrets/);
    expect(code).not.toMatch(/environment:/);
    expect(code).not.toMatch(/pull_request_target/);
  });

  it("never persists checkout credentials", () => {
    const checkouts = code.match(/uses: actions\/checkout@/g) ?? [];
    const disabled = code.match(/persist-credentials: false/g) ?? [];
    expect(checkouts.length).toBeGreaterThan(0);
    expect(disabled).toHaveLength(checkouts.length);
  });

  it("names artifacts per 02 §6 with the run attempt", () => {
    expect(code).toContain(
      "name: pixelwatch-b1-a${{ github.run_attempt }}-${{ matrix.revision }}-${{ matrix.provider }}-s${{ matrix.shard }}-of${{ matrix.shards }}",
    );
  });
});

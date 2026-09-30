import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/lint-tools.ts";
import { runActionlint, runZizmor, workflowTargets } from "./lint-workflows.ts";

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

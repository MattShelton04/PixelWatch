import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/lint-tools.ts";

const smoke = path.join(repoRoot, "testdata", "smoke");
const sinkRules = new Set([
  "no-restricted-syntax",
  "no-eval",
  "no-new-func",
  "@typescript-eslint/no-implied-eval",
]);

// The real eslint.config.js, with ignores off so the (globally ignored) fixtures are linted.
async function lint(file: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const [result] = await eslint.lintFiles([path.join(smoke, file)]);
  if (result === undefined) throw new Error(`no lint result for ${file}`);
  return result;
}

describe("ESLint HTML-sink ban (04 §4)", () => {
  it("reports a sink error on every marked line of the bad fixture, and nowhere else", async () => {
    const result = await lint("html-sinks.bad.ts");
    const expectedLines = readFileSync(path.join(smoke, "html-sinks.bad.ts"), "utf8")
      .split("\n")
      .flatMap((line, index) => (line.includes("// expect-sink") ? [index + 1] : []));
    // `new Function` is reported by both no-new-func and no-implied-eval, so compare lines.
    const sinkLines = new Set(
      result.messages
        .filter((message) => message.ruleId !== null && sinkRules.has(message.ruleId))
        .map((message) => message.line),
    );

    expect(expectedLines.length).toBeGreaterThanOrEqual(13);
    expect([...sinkLines].sort((a, b) => a - b)).toEqual(expectedLines);
  });

  it("accepts text-node DOM construction", async () => {
    const result = await lint("html-sinks.good.ts");
    expect(result.messages).toEqual([]);
  });
});

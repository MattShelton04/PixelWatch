import { spawnSync } from "node:child_process";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/lint-tools.ts";
import { evaluateLiveGate, requiredSettings } from "./live.ts";

const complete = {
  PIXELWATCH_LIVE: "1",
  PIXELWATCH_E2E_OWNER: "pixelwatch-e2e",
  PIXELWATCH_E2E_REPO: "upstream",
  GH_TOKEN: "test-token",
};

// A child environment with none of the CI runner's GITHUB_* variables.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.join(repoRoot, "tools", script), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("test:live gate (07 §5)", () => {
  it("names every missing setting", () => {
    fc.assert(
      fc.property(fc.subarray([...requiredSettings]), (present) => {
        const env = Object.fromEntries(present.map((name) => [name, complete[name]]));
        const gate = evaluateLiveGate(env);
        const expected = requiredSettings.filter((name) => !present.includes(name));
        if (expected.length === 0) {
          expect(gate).toEqual({ ok: true });
        } else {
          expect(gate.ok).toBe(false);
          if (!gate.ok) expect(gate.missing).toEqual(expected);
        }
      }),
    );
  });

  it("requires PIXELWATCH_LIVE to be exactly 1", () => {
    for (const value of ["", "0", "true", "yes"]) {
      const gate = evaluateLiveGate({ ...complete, PIXELWATCH_LIVE: value });
      expect(gate.ok).toBe(false);
    }
  });

  it("refuses every pull_request event, even with all settings", () => {
    for (const event of ["pull_request", "pull_request_target", "pull_request_review"]) {
      const gate = evaluateLiveGate({ ...complete, GITHUB_EVENT_NAME: event });
      expect(gate).toMatchObject({ ok: false, reason: "pull-request" });
    }
    const forkHeadRef = evaluateLiveGate({ ...complete, GITHUB_HEAD_REF: "fork-branch" });
    expect(forkHeadRef).toMatchObject({ ok: false, reason: "pull-request" });
  });

  it("exits non-zero with a clear message when run without settings", () => {
    const result = runScript("live.ts", [], childEnv({}));
    expect(result.status).toBe(1);
    for (const name of requiredSettings) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("Nothing ran");
  });

  it("exits non-zero on a pull_request run and never reports success", () => {
    const result = runScript("live.ts", [], childEnv({ ...complete, GITHUB_EVENT_NAME: "pull_request" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refuses to run for pull_request events");
    expect(result.stderr).not.toContain("test-token");
  });

  it("still fails with settings present, because no scenarios exist yet", () => {
    const result = runScript("live.ts", [], childEnv(complete));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no live scenarios exist yet");
  });
});

describe("suites that don't exist yet", () => {
  it.each(["viewer"])("test:%s fails instead of passing vacuously", (suite) => {
    const result = runScript("not-yet.ts", [suite], childEnv({}));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nothing ran");
  });
});

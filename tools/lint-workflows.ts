// `pnpm lint:workflows`: actionlint + zizmor (offline) over this repo's workflows and the adopter
// templates. Missing or stale binaries fail with an install hint; the check is never skipped.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReportWorkflowTree } from "./release/workflow-policy.ts";
import {
  binaryPath,
  installedManifestPath,
  installHint,
  loadManifest,
  repoRoot,
  toolNames,
  type ToolName,
} from "./lib/lint-tools.ts";

/** Workflow files linted by both tools, relative to the repo root. */
export function workflowTargets(): string[] {
  const dirs = [".github/workflows", "docs/templates"];
  return dirs.flatMap((dir) => {
    const full = path.join(repoRoot, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `${dir}/${name}`);
  });
}

/** Resolves a pinned linter, throwing with an install hint if it's absent or a different version. */
export function linterPath(name: ToolName): string {
  const manifest = loadManifest();
  const bin = binaryPath(manifest[name]);
  let installed: Partial<Record<string, string>> = {};
  if (existsSync(installedManifestPath)) {
    installed = JSON.parse(readFileSync(installedManifestPath, "utf8")) as typeof installed;
  }
  if (!existsSync(bin) || installed[name] !== manifest[name].version) {
    throw new Error(
      `${name} ${manifest[name].version} is not installed (found ${installed[name] ?? "none"}). ${installHint}`,
    );
  }
  return bin;
}

function run(bin: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(bin, args, { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
}

// shellcheck/pyflakes integration is off so Linux and Windows lint identically (06 §2).
export function runActionlint(files: string[], extraArgs: string[] = []): SpawnSyncReturns<string> {
  return run(linterPath("actionlint"), [
    "-no-color",
    "-shellcheck=",
    "-pyflakes=",
    ...extraArgs,
    ...files,
  ]);
}

// --offline: no GitHub API lookups, so `pnpm check` stays network-free (07 §1).
export function runZizmor(files: string[], extraArgs: string[] = []): SpawnSyncReturns<string> {
  return run(linterPath("zizmor"), [
    "--offline",
    "--no-progress",
    "--config",
    path.join(repoRoot, "zizmor.yml"),
    ...extraArgs,
    ...files,
  ]);
}

function main(): void {
  verifyReportWorkflowTree(repoRoot);
  const targets = workflowTargets();
  if (targets.length === 0) throw new Error("no workflow files found to lint");
  for (const name of toolNames) linterPath(name);

  // Returns true when the tool passed.
  const report = (label: string, result: SpawnSyncReturns<string>): boolean => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.error !== undefined || result.status !== 0) {
      console.error(`${label} failed (exit ${String(result.status)})`);
      return false;
    }
    console.log(`${label}: ok`);
    return true;
  };

  console.log(`linting ${String(targets.length)} files: ${targets.join(", ")}`);
  const dependabot = ".github/dependabot.yml";
  const zizmorTargets = existsSync(path.join(repoRoot, dependabot))
    ? [...targets, dependabot]
    : targets;
  const results = [
    report("actionlint", runActionlint(targets)),
    report("zizmor", runZizmor(zizmorTargets)),
  ];
  if (results.includes(false)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`lint:workflows: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

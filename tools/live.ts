// `pnpm test:live`: the live GitHub e2e entry point (07 §5). It needs explicit settings, fails
// clearly without them, and refuses to run for any pull_request event, so fork PRs can never
// reach test credentials. The scenarios themselves land in M2.6.
import { pathToFileURL } from "node:url";

export const requiredSettings = [
  "PIXELWATCH_LIVE",
  "PIXELWATCH_E2E_OWNER",
  "PIXELWATCH_E2E_REPO",
  "GH_TOKEN",
] as const;

export type LiveGate =
  | { ok: true }
  | { ok: false; reason: "pull-request" | "missing-settings"; message: string; missing: string[] };

type Env = Readonly<Partial<Record<string, string>>>;

export function evaluateLiveGate(env: Env): LiveGate {
  const event = env["GITHUB_EVENT_NAME"] ?? "";
  // GITHUB_HEAD_REF is only set for pull_request and pull_request_target runs.
  if (event.startsWith("pull_request") || (env["GITHUB_HEAD_REF"] ?? "") !== "") {
    return {
      ok: false,
      reason: "pull-request",
      message:
        "test:live refuses to run for pull_request events. Live tests run only from trusted " +
        "manual or scheduled workflows on the default branch (07 §5).",
      missing: [],
    };
  }
  const missing = requiredSettings.filter((name) =>
    name === "PIXELWATCH_LIVE" ? env[name] !== "1" : (env[name] ?? "").trim() === "",
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing-settings",
      message:
        `test:live needs explicit settings; missing: ${missing.join(", ")}. ` +
        "Set PIXELWATCH_LIVE=1 plus the e2e owner, repo and a scoped GH_TOKEN. " +
        "Nothing ran.",
      missing,
    };
  }
  return { ok: true };
}

function main(): void {
  const gate = evaluateLiveGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exitCode = 1;
    return;
  }
  console.error("test:live: settings are present, but no live scenarios exist yet (M2.6). Nothing ran.");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

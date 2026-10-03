// Arguments, output streams and exit codes of the internal dev CLI (M1.8, ADR 0014; 06 §2).
// `main` never throws and never exits: it returns the exit code, so tests run it in process.
//
//   pixelwatch-dev compare [--config <file>] [--summary] [--debug] [--] <base> <head>
//   pixelwatch-dev compare --no-baseline [--config <file>] [--summary] [--debug] [--] <head>
//
// stdout carries the report (canonical JSON, or the summary with --summary) and nothing else, and
// only for exits 0–2. stderr carries bounded, escaped error lines, and only for exits 3–5.
import { IngressError, type PngWorker } from "../../packages/core/src/index.ts";
import { RejectedParts, compareLocal } from "./compare.ts";
import { InputError, type ListDir } from "./inputs.ts";
import { EXIT, MAX_LINE_CHARS, OUTCOME_EXIT, errorLine, errorLines, escapeText, reportJson, summaryText } from "./report.ts";

export const USAGE = `Usage:
  pixelwatch-dev compare [options] [--] <base> <head>
  pixelwatch-dev compare --no-baseline [options] [--] <head>

Compares two local captures with the publisher's own ingress, merge and comparator-v1.
No network, no credentials, no Git. Nothing is corroborated: capture claims are untrusted.

<base> and <head> are directories. Each is either one bundle@1 part (it holds bundle.json and
its <viewId>.<variantId>.png files) or a directory of parts, each an extracted artifact directory
named <artifact name>/ or an archive named <artifact name>.zip, where the artifact name is
pixelwatch-b1-a<attempt>-<base|head>-<provider>-s<index>-of<count>. Nothing else may be there.

Options:
  --config <file>  expect the parts this config@1 names (default: the parts the inputs name)
  --no-baseline    compare <head> with no baseline (every result is incomparable)
  --summary        print a human summary instead of the JSON report
  --debug          add a stack trace to internal errors

Exit codes:
  0 no differences   every declared unit captured on both sides and unchanged
  1 differences      complete, and something was added, removed, subtle or changed
  2 incomplete       anything missing, failed or incomparable, or incomplete coverage
  3 invalid input    an input was refused (nothing is printed on stdout)
  4 usage            bad arguments, or --help
  5 internal error
`;

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface Deps {
  /** Directory listing; tests permute it. */
  readonly list?: ListDir;
  /** A shared PngWorker; tests pass one so each run doesn't start a thread. */
  readonly worker?: PngWorker;
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

interface Args {
  readonly help: boolean;
  readonly base?: string;
  readonly head: string;
  readonly config?: string;
  readonly summary: boolean;
}

/** Strict: unknown options, repeats, a missing value or the wrong number of paths are usage errors. */
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return { help: true, head: "", summary: false };
  if (command !== "compare") throw new UsageError(command === undefined ? "no command given" : "unknown command; the only command is compare");
  const seen = new Set<string>();
  const paths: string[] = [];
  let config: string | undefined;
  let help = false;
  let options = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!options || !arg.startsWith("-") || arg === "-") {
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      options = false;
      continue;
    }
    if (!["--config", "--no-baseline", "--summary", "--debug", "--help", "-h"].includes(arg)) throw new UsageError("unknown option");
    if (seen.has(arg)) throw new UsageError("an option is repeated");
    seen.add(arg);
    if (arg === "--help" || arg === "-h") help = true;
    if (arg === "--config") {
      const value = rest[++i];
      if (value === undefined || value === "") throw new UsageError("--config needs a file");
      config = value;
    }
  }
  if (help) return { help: true, head: "", summary: false };
  const noBaseline = seen.has("--no-baseline");
  const want = noBaseline ? 1 : 2;
  if (paths.length !== want) throw new UsageError(noBaseline ? "--no-baseline takes exactly one path, <head>" : "compare takes exactly two paths, <base> and <head>");
  if (paths.some((p) => p === "")) throw new UsageError("a path is empty");
  const [first = "", second = ""] = paths;
  return {
    help: false,
    ...(noBaseline ? { head: first } : { base: first, head: second }),
    ...(config === undefined ? {} : { config }),
    summary: seen.has("--summary"),
  };
}

const CODEC_FAILURES = new Set(["ingest-codec", "ingest-aborted"]);

function failure(error: unknown, debug: boolean): { code: number; text: string } {
  if (error instanceof UsageError) {
    return { code: EXIT.usage, text: errorLine("usage error", "usage", error.message) + "pixelwatch-dev: run `pixelwatch-dev --help` for usage\n" };
  }
  if (error instanceof InputError) return { code: EXIT.invalidInput, text: errorLine("invalid input", error.code, error.message) };
  if (error instanceof RejectedParts) {
    return { code: EXIT.invalidInput, text: errorLines("invalid input", error.parts.map((p) => ({ code: p.code, message: `part ${p.name} was rejected: ${p.message}` }))) };
  }
  // Worker crashes, timeouts and the ingestion deadline say nothing about the input (ADR 0008).
  if (error instanceof IngressError && error.scope === "ingestion" && !CODEC_FAILURES.has(error.code)) {
    return { code: EXIT.invalidInput, text: errorLine("invalid input", error.code, error.detail) };
  }
  const name = error instanceof Error ? error.name : "non-error";
  const code = error instanceof IngressError ? error.code : "internal";
  let text = errorLine("internal error", code, `${name}; run with --debug for a stack trace`);
  if (debug && error instanceof Error && error.stack !== undefined) {
    const lines = error.stack.split("\n").slice(0, 16);
    text += lines.map((line) => `${escapeText(line, MAX_LINE_CHARS)}\n`).join("");
  }
  return { code: EXIT.internal, text };
}

export async function main(argv: readonly string[], io: Io, deps: Deps = {}): Promise<number> {
  const debug = argv.includes("--debug");
  try {
    const args = parseArgs(argv);
    if (args.help) {
      // Help is not a comparison, so it never exits 0 (ADR 0014).
      io.stdout(USAGE);
      return EXIT.usage;
    }
    const report = await compareLocal({
      ...(args.base === undefined ? {} : { base: args.base }),
      head: args.head,
      ...(args.config === undefined ? {} : { config: args.config }),
      ...(deps.list === undefined ? {} : { list: deps.list }),
      ...(deps.worker === undefined ? {} : { worker: deps.worker }),
    });
    io.stdout(args.summary ? summaryText(report) : reportJson(report));
    return OUTCOME_EXIT[report.outcome];
  } catch (error) {
    const { code, text } = failure(error, debug);
    io.stderr(text);
    return code;
  }
}

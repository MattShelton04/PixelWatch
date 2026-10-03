// The internal dev CLI, `pixelwatch-dev` (06 §2; M1.8, ADR 0014). Not shipped, not the public CLI
// (M4). Local only: no network, no credentials, no Git or GitHub calls, and no environment
// variables are read.
//
//   node tools/pixelwatch-dev.ts compare <base> <head>      (or: pnpm dev:compare <base> <head>)
//   node tools/pixelwatch-dev.ts --help
import { main } from "./dev/cli.ts";
import { EXIT, errorLine } from "./dev/report.ts";

// Anything that escapes main is an internal error with a bounded line, never a stack trace and
// never an exit code that could read as a comparison outcome.
const crash = () => {
  process.stderr.write(errorLine("internal error", "internal", "unexpected failure"));
  process.exit(EXIT.internal);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

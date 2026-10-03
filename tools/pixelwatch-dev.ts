// The internal dev CLI, `pixelwatch-dev` (06 §2; M1.8, ADR 0014). Not shipped, not the public CLI
// (M4). Compare reads no credentials/environment/network/Git. Serve lazily loads a loopback-only
// listener for a generated viewer; it never proxies remote data or executes capture/adopter code.
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

const argv = process.argv.slice(2);
process.exitCode = argv[0] === "serve" ? await (await import("./viewer/serve-cli.ts")).serve(argv.slice(1), (text) => process.stdout.write(text)) : await main(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

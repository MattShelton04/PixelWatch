import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { parseViewerDocument } from "../src/browser.ts";
import { parseDocument } from "../src/validate.ts";
import { generateViewerValidators } from "../scripts/generate-viewer-validators.ts";

it("static browser validators agree with canonical site and changes fixture acceptance", () => {
  for (const kind of ["site", "changes"] as const) for (const state of ["valid", "invalid"]) {
    const directory = new URL(`../../../testdata/schemas/${kind}/${state}/`, import.meta.url);
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".json")) continue;
      const bytes = readFileSync(new URL(file, directory));
      expect(parseViewerDocument(kind, bytes).ok, `${kind}/${state}/${file}`).toBe(parseDocument(kind, bytes).ok);
    }
  }
});

it("static browser parsing rejects duplicate keys unsafe keys unknown versions and oversized JSON", () => {
  for (const text of ['{"schemaVersion":1,"schemaVersion":1}', '{"__proto__":{}}', '{"schemaVersion":2}', " ".repeat(1024 * 1024 + 1)]) {
    const expected = parseDocument("site", text);
    const actual = parseViewerDocument("site", text);
    expect(actual.ok).toBe(false);
    if (!actual.ok && !expected.ok) expect(actual.issue.code).toBe(expected.issue.code);
  }
});

it("generated static browser validators are reproducible and current", async () => {
  const generated = await generateViewerValidators();
  expect(generated).toEqual(readFileSync(new URL("../src/generated/viewer-validators.js", import.meta.url), "utf8"));
});

it("the browser validation bundle executes hostile fixtures without Node globals or string code generation", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../src/browser.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "PixelWatchValidation",
    target: "es2022", logLevel: "silent" });
  const output = result.outputFiles[0];
  expect(output).toBeDefined();
  if (output === undefined) throw new Error("browser-validation-build-empty");
  const context = createContext({ TextDecoder, TextEncoder }, { codeGeneration: { strings: false, wasm: false } });
  runInContext(output.text, context);
  const fixture = readFileSync(new URL("../../../testdata/schemas/site/valid/three-streams.json", import.meta.url), "utf8");
  for (const text of [fixture, '{"schemaVersion":2}', '{"schemaVersion":1,"schemaVersion":1}', '{"__proto__":{}}']) {
    const expected = parseViewerDocument("site", text);
    const actual: unknown = runInContext(`PixelWatchValidation.parseViewerDocument("site", ${JSON.stringify(text)})`, context);
    expect(actual).toEqual(expected);
  }
  expect(runInContext("typeof Buffer + ',' + typeof process + ',' + typeof require", context)).toBe("undefined,undefined,undefined");
  expect(() => { runInContext("new Function('return 1')()", context); }).toThrow();
});

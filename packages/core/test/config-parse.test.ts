// Trusted config parsing (M1.4; 02 §10; ADR 0009). The restricted YAML subset refuses every
// construct whose meaning is unsafe or version-dependent, and the `yaml` package (a dev-only
// dependency) checks differentially that every accepted document reads the same under YAML 1.1
// and 1.2.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parseConfig } from "../src/config/parse.ts";
import { YamlError, parseYamlSubset } from "../src/config/yaml.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const BOM = String.fromCharCode(0xfeff);

const BASE = `schemaVersion: 1
source:
  workflowIds: ["101"]
  events: [pull_request, push]
providers:
  - id: fixture
    shards: 1
`;

function code(input: string | Uint8Array): string {
  const result = parseConfig(typeof input === "string" ? encode(input) : input);
  return result.ok ? "ok" : String(result.issue.code);
}

function subset(text: string): unknown {
  try {
    return parseYamlSubset(encode(text));
  } catch (error) {
    if (error instanceof YamlError) return error;
    throw error;
  }
}

function library(text: string, version: "1.1" | "1.2"): unknown {
  return YAML.parse(text, { version, uniqueKeys: true, maxAliasCount: 0 }) as unknown;
}

describe("trusted config parsing", () => {
  it("rejects aliases, anchors, custom tags, duplicate keys, non-finite numbers and input over 1 MiB before validation", () => {
    const deep = `${Array.from({ length: 33 }, (_, i) => `${" ".repeat(i)}k:`).join("\n")} 1\n`;
    const cases: [string | Uint8Array, string][] = [
      [`${BASE}store: &store\n  branch: x\n`, "yaml-anchor"],
      [`${BASE}store: *store\n`, "yaml-alias"],
      [`${BASE}  - *p\n`, "yaml-alias"],
      [`${BASE}theme: !!map {preset: fieldbook}\n`, "yaml-tag"],
      [`${BASE}theme:\n  preset: !custom fieldbook\n`, "yaml-tag"],
      [`${BASE}comment:\n  <<: {enabled: true}\n`, "yaml-merge-key"],
      [`${BASE}schemaVersion: 1\n`, "yaml-duplicate-key"],
      [`${BASE}  - id: stack\n    shards: 2\n    shards: 3\n`, "yaml-duplicate-key"],
      [`${BASE}limits:\n  softBytes: .inf\n`, "yaml-number"],
      [`${BASE}limits:\n  softBytes: -.Inf\n`, "yaml-number"],
      [`${BASE}limits:\n  softBytes: .NaN\n`, "yaml-number"],
      [`${BASE}limits:\n  softBytes: 1e999\n`, "yaml-number"],
      [`${BASE}limits:\n  softBytes: 99999999999999999999\n`, "yaml-number"],
      [`${BASE}limits:\n  softBytes: 1.5\n`, "yaml-number"],
      [`${BASE}#${"x".repeat(1024 * 1024 - BASE.length)}\n`, "yaml-too-large"],
      [`${BASE}__proto__:\n  polluted: true\n`, "yaml-unsafe-key"],
      [`${BASE}? [a, b]\n: c\n`, "yaml-complex-key"],
      [`${BASE}store:\n  branch: |\n    x\n`, "yaml-block-scalar"],
      [`${BASE}comment: {enabled: true}\n`, "yaml-flow-mapping"],
      [`%YAML 1.1\n---\n${BASE}`, "yaml-directive"],
      [`${BASE}---\n${BASE}`, "yaml-multi-document"],
      [`${BASE}...\n`, "yaml-multi-document"],
      [`${BASE}store:\n\tbranch: x\n`, "yaml-tab"],
      [`${BOM}${BASE}`, "yaml-encoding"],
      [new Uint8Array([...encode(BASE), 0x6b, 0x3a, 0x20, 0xc3, 0x28, 0x0a]), "yaml-encoding"],
      [`${BASE}store:\n  branch: "a${NEL}b"\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch: a${LS}b\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch: a\rb\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch:\n`, "yaml-empty-value"],
      [`${BASE}store:\n  branch: pixelwatch\n    -data\n`, "yaml-indent"],
      [`${BASE}store:\n    branch: x\n  prefix: y\n`, "yaml-indent"],
      [`${BASE}store:\n  branch: "\\x41"\n`, "yaml-escape"],
      [`${BASE}store:\n  branch: "\\ud800"\n`, "yaml-escape"],
      [`${BASE}store:\n  branch: a: b\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch: [a, [b]]\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch: [a, b,]\n`, "yaml-syntax"],
      [`${BASE}store:\n  branch: "unterminated\n`, "yaml-syntax"],
      [`a: 1\n${deep}`, "yaml-too-deep"],
      ["", "yaml-syntax"],
      ["# only a comment\n", "yaml-syntax"],
      ['"just a string"\n', "yaml-syntax"],
    ];
    for (const [input, expected] of cases) {
      const result = parseConfig(typeof input === "string" ? encode(input) : input);
      expect(result.ok ? "ok" : result.issue.code, typeof input === "string" ? input.slice(-60) : "bytes").toBe(expected);
      if (!result.ok) {
        expect(Buffer.byteLength(result.issue.message)).toBeLessThanOrEqual(256);
        expect(result.issue.message).not.toMatch(/polluted|store|fieldbook|unterminated/);
      }
    }
    // Exactly 1 MiB passes the size check; a YAML problem wins over a schema problem.
    const padded = `${BASE}#${"x".repeat(1024 * 1024 - BASE.length - 2)}\n`;
    expect(encode(padded).byteLength).toBe(1024 * 1024);
    expect(code(padded)).toBe("ok");
    expect(code(`schemaVersion: 9\nx: &a 1\n`)).toBe("yaml-anchor");
  });

  it("reports an unknown config version before any schema or policy problem", () => {
    const broken = (version: string) =>
      `schemaVersion: ${version}\nsource:\n  workflowIds: [build]\n  events: [pull_request_target]\nproviders: []\nlimits:\n  softBytes: 2\n  hardBytes: 1\nrunScript: x\ntheme: neon\n`;
    for (const version of ["2", "0", "999"]) {
      const result = parseConfig(encode(broken(version)));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue).toMatchObject({ code: "unsupported-version", path: "/schemaVersion" });
        expect(result.issue.message).toMatch(/not supported/);
      }
    }
    expect(code(broken("1"))).toBe("schema");
    expect(code(BASE.replace("schemaVersion: 1\n", ""))).toBe("schema");
    expect(code(BASE.replace("schemaVersion: 1", 'schemaVersion: "1"'))).toBe("schema");
    expect(code(BASE)).toBe("ok");
  });

  it("rejects scalars whose meaning differs between YAML 1.1 and 1.2", () => {
    const differs: [string, string][] = [
      ["a: yes\n", "yaml-ambiguous-scalar"],
      ["a: no\n", "yaml-ambiguous-scalar"],
      ["a: on\n", "yaml-ambiguous-scalar"],
      ["a: Off\n", "yaml-ambiguous-scalar"],
      ["a: y\n", "yaml-ambiguous-scalar"],
      ["a: N\n", "yaml-ambiguous-scalar"],
      ["a: [push, yes]\n", "yaml-ambiguous-scalar"],
      ["on: push\n", "yaml-ambiguous-scalar"],
      ["a: 012\n", "yaml-number"],
      ["a: 0o12\n", "yaml-number"],
      ["a: 0b101\n", "yaml-number"],
      ["a: 1_000\n", "yaml-number"],
      ["a: 1:30\n", "yaml-number"],
      ["a: 2001-12-14\n", "yaml-number"],
      ["a: e5\n", "yaml-number"],
      ["E-3: a\n", "yaml-number"],
      ["a:\n  <<:\n    b: 1\n", "yaml-merge-key"],
    ];
    for (const [text, expected] of differs) {
      expect(library(text, "1.1"), text).not.toEqual(library(text, "1.2"));
      expect(subset(text), text).toMatchObject({ code: expected });
    }
    // Refused although this yaml release happens to agree: the specs differ (\/ is 1.2-only; NEL
    // and LS are 1.1 line breaks), or readers commonly do (Null, ~, TRUE, hex, signs, floats).
    const conservative: [string, string][] = [
      ['a: "\\/"\n', "yaml-escape"],
      [`a: "x${NEL}y"\n`, "yaml-syntax"],
      [`a: "x${LS}y"\n`, "yaml-syntax"],
      ["a: ~\n", "yaml-ambiguous-scalar"],
      ["a: Null\n", "yaml-ambiguous-scalar"],
      ["a: TRUE\n", "yaml-ambiguous-scalar"],
      ["a: 0x1F\n", "yaml-number"],
      ["a: +1\n", "yaml-number"],
      ["a: -0\n", "yaml-number"],
      ["a: 1e3\n", "yaml-number"],
    ];
    for (const [text, expected] of conservative) expect(subset(text), text).toMatchObject({ code: expected });
    // What stays is unambiguous.
    expect(subset('a: [true, false, null, 0, -12, "yes", \'on\', x-y_z, a b]\n')).toEqual({ a: [true, false, null, 0, -12, "yes", "on", "x-y_z", "a b"] });
  });

  it("agrees with the yaml package under YAML 1.1 and 1.2 on every accepted document", () => {
    type Tree = null | boolean | number | string | Tree[] | { [key: string]: Tree };
    const WORDS = ["push", "yes", "No", "on", "OFF", "y", "null", "Null", "~", "true", "True", "x y", "a-b", "_z", "/p", "012", "1:30", "0x1F", "1e3", ".inf", "2001-12-14", "1_000", "#x", "a #b", "a: b", "-a", "'q'", '"d"', "it's", "back\\slash", "tab\tin", "é", ""];
    const scalar: fc.Arbitrary<Tree> = fc.oneof(
      fc.constantFrom<Tree>(true, false, null, 0, -1, 7, 2 ** 53 - 1),
      fc.integer(),
      fc.constantFrom(...WORDS),
      fc.string({ maxLength: 8 }),
    );
    const key = fc.oneof(fc.stringMatching(/^[a-z_][a-z0-9_-]{0,6}$/), fc.constantFrom("on", "y", "no", "true", "null", "__proto__", "<<", "a b"));
    const tree = fc.letrec<{ node: Tree; map: Tree; list: Tree }>((tie) => ({
      node: fc.oneof({ depthSize: "small", withCrossShrink: true }, scalar, tie("map"), tie("list")),
      map: fc.dictionary(key, tie("node"), { minKeys: 1, maxKeys: 4 }),
      list: fc.array(tie("node"), { maxLength: 4 }),
    })).map;
    const style = fc.record({
      indent: fc.integer({ min: 1, max: 4 }),
      quote: fc.constantFrom("plain", "double", "single", "mixed"),
      flow: fc.boolean(),
      compact: fc.boolean(),
      comments: fc.boolean(),
      crlf: fc.boolean(),
      marker: fc.boolean(),
    });
    type Style = typeof style extends fc.Arbitrary<infer S> ? S : never;

    const renderScalar = (value: Tree, s: Style, salt: number): string => {
      if (typeof value !== "string") return JSON.stringify(value);
      const q = s.quote === "mixed" ? (["plain", "double", "single"] as const)[salt % 3] : s.quote;
      if (q === "double") return JSON.stringify(value);
      if (q === "single") return `'${value.replaceAll("'", "''")}'`;
      return value;
    };
    const render = (value: Tree, s: Style, depth: number, out: string[], prefix: string, salt: { n: number }): void => {
      const pad = " ".repeat(depth * s.indent);
      const note = s.comments ? " # note" : "";
      if (Array.isArray(value)) {
        if (s.flow && value.every((v) => v === null || typeof v !== "object")) {
          out.push(`${prefix}[${value.map((v) => renderScalar(v, s, salt.n++)).join(", ")}]${note}`);
          return;
        }
        if (prefix !== "") out.push(prefix.trimEnd());
        const itemPad = s.compact && prefix.endsWith(": ") ? " ".repeat(Math.max(0, depth - 1) * s.indent) : pad;
        if (value.length === 0) out[out.length - 1] = `${prefix}[]`;
        for (const item of value) render(item, s, depth + 1, out, `${itemPad}- `, salt);
        return;
      }
      if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (prefix !== "") out.push(prefix.trimEnd());
        for (const [k, v] of entries) render(v, s, depth + 1, out, `${pad}${k}: `, salt);
        return;
      }
      out.push(`${prefix}${renderScalar(value, s, salt.n++)}${note}`);
    };
    const documentOf = (value: Tree, s: Style) => {
      const out: string[] = s.marker ? ["---"] : [];
      if (s.comments) out.push("# config");
      for (const [k, v] of Object.entries(value as Record<string, Tree>)) render(v, s, 1, out, `${k}: `, { n: 0 });
      return `${out.join(s.crlf ? "\r\n" : "\n")}\n`;
    };

    let accepted = 0;
    let quotedRoundTrips = 0;
    fc.assert(
      fc.property(tree, style, (value, s) => {
        const text = documentOf(value, s);
        const ours = subset(text);
        if (ours instanceof YamlError) return;
        accepted++;
        expect(ours).toEqual(library(text, "1.1"));
        expect(ours).toEqual(library(text, "1.2"));
        if (s.quote === "double") {
          quotedRoundTrips++;
          expect(ours).toEqual(JSON.parse(JSON.stringify(value)));
        }
      }),
      { numRuns: 1500 },
    );
    // Guards against a generator that only produces refusals.
    expect(accepted).toBeGreaterThan(60);
    expect(quotedRoundTrips).toBeGreaterThan(15);

    // Unstructured: lines of indentation, dashes, keys and YAML's own punctuation. Anything
    // accepted must read the same.
    const token = fc.constantFrom("a", "b", "yes", "1", "0", "-", "- ", ": ", ":", " ", "  ", "#", "'", '"', "[", "]", ",", "{", "&a", "*a", "!t", "<<", "|", ">", "?", "---", "...", "%", "\\", "\\u0041", ".", "e", "e1", "~", "null", "true", "\r");
    const line = fc
      .tuple(
        fc.constantFrom("", "", "", " ", "  ", "    "),
        fc.constantFrom("", "", "- ", "- - "),
        fc.constantFrom("", "a: ", "b: ", "c: ", "d: ", "e1: ", "a:", "b:"),
        fc.array(token, { maxLength: 3 }),
      )
      .map(([indent, dash, key, rest]) => `${indent}${dash}${key}${rest.join("")}`);
    let fuzzAccepted = 0;
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
        const text = `${lines.join("\n")}\n`;
        const ours = subset(text);
        if (ours instanceof YamlError) return;
        fuzzAccepted++;
        expect(ours).toEqual(library(text, "1.1"));
        expect(ours).toEqual(library(text, "1.2"));
      }),
      { numRuns: 15000 },
    );
    expect(fuzzAccepted).toBeGreaterThan(20);
  });

  it("falls back to the default theme with a warning, and never for policy", () => {
    for (const theme of ["theme:\n  preset: neon\n", "theme: dark\n", "theme:\n  preset: fieldbook\n  accent: red\n", "theme: []\n"]) {
      const result = parseConfig(encode(`${BASE}${theme}`));
      expect(result.ok, theme).toBe(true);
      if (result.ok) {
        expect(result.config.theme).toBeUndefined();
        expect(result.warnings).toMatchObject([{ code: "theme-fallback" }]);
        expect(result.warnings[0]?.path.startsWith("/theme")).toBe(true);
      }
    }
    const good = parseConfig(encode(`${BASE}theme:\n  preset: midnight\n`));
    expect(good).toMatchObject({ ok: true, warnings: [], config: { theme: { preset: "midnight" } } });

    // Policy never falls back, not even beside a theme that would.
    const policy: [string, string][] = [
      ["limits:\n  softBytes: 524288001\n  hardBytes: 524288000\n", "limit-order"],
      ["comment:\n  enabled: 1\n", "schema"],
      ["store:\n  branch: \"../main\"\n", "schema"],
      ["basePolicy:\n  pullRequest: head\n  push: first-parent\n", "schema"],
      ["comparator:\n  version: 2\n", "schema"],
      ["retention:\n  mainRuns: -1\n", "schema"],
      ["runScript: rm\n", "schema"],
      ["providers2: []\n", "schema"],
    ];
    for (const [extra, expected] of policy) {
      expect(code(`${BASE}${extra}`), extra).toBe(expected);
      expect(code(`${BASE}${extra}theme: neon\n`), extra).toBe(expected);
    }
    expect(code(BASE.replace("events: [pull_request, push]", "events: [pull_request_target]"))).toBe("schema");
    expect(code(BASE.replace("shards: 1", "shards: 1\n  - id: fixture\n    shards: 2"))).toBe("duplicate-provider");
    expect(code(BASE.replace("shards: 1", "shards: 64\n  - id: stack\n    shards: 64\n  - id: extra\n    shards: 1"))).toBe("too-many-parts");
  });
});

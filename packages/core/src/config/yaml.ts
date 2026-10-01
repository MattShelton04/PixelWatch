// Restricted YAML for trusted config (02 §10; ADR 0009). The default-branch config is YAML, but
// only a JSON-compatible subset whose every accepted document means the same under YAML 1.1 and
// 1.2 is read. Anything outside it is refused with its own code, never guessed at:
//
// - block mappings with identifier keys, block sequences (also compact under a key), one-line
//   flow sequences of scalars, `#` comments and one optional leading `---`;
// - scalars: double-quoted (JSON escapes except `\/`, no surrogates), single-quoted, and plain
//   `true`, `false`, `null`, safe decimal integers and conservative strings;
// - no anchors, aliases, tags, merge keys, complex keys, block scalars, flow mappings,
//   directives, multiple documents, duplicate keys, tabs or multi-line scalars;
// - no plain scalar that YAML 1.1 and 1.2 read differently (yes/no/on/off/y/n, leading zeros,
//   `1_000`, `1:30`, timestamps, a bare exponent like `e5`) and no non-integer number;
// - at most 1 MiB, depth 32, UTF-8 without a BOM, LF or CRLF line ends.
//
// Messages carry line numbers and fixed text, never input. The `yaml` package checks the subset
// differentially in tests only; it is not a runtime dependency.
import { type JsonObject, type JsonValue, UNSAFE_KEYS } from "@pixelwatch/schemas";

export type YamlErrorCode =
  | "yaml-too-large"
  | "yaml-encoding"
  | "yaml-syntax"
  | "yaml-tab"
  | "yaml-indent"
  | "yaml-too-deep"
  | "yaml-empty-value"
  | "yaml-anchor"
  | "yaml-alias"
  | "yaml-tag"
  | "yaml-merge-key"
  | "yaml-complex-key"
  | "yaml-block-scalar"
  | "yaml-flow-mapping"
  | "yaml-directive"
  | "yaml-multi-document"
  | "yaml-duplicate-key"
  | "yaml-unsafe-key"
  | "yaml-number"
  | "yaml-ambiguous-scalar"
  | "yaml-escape";

export class YamlError extends Error {
  readonly code: YamlErrorCode;
  /** 1-based; 0 for the whole input. */
  readonly line: number;
  constructor(code: YamlErrorCode, line: number, message: string) {
    super(line === 0 ? message : `line ${String(line)}: ${message}`);
    this.name = "YamlError";
    this.code = code;
    this.line = line;
  }
}

export interface YamlLimits {
  readonly maxBytes: number;
  /** Container nesting; the top-level mapping is depth 1. */
  readonly maxDepth: number;
}

export const YAML_LIMITS: YamlLimits = Object.freeze({ maxBytes: 1024 * 1024, maxDepth: 32 });

interface Line {
  readonly no: number;
  readonly indent: number;
  /** Content after the indent, comment removed, trailing spaces trimmed. Never empty. */
  readonly text: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// C0 except LF/CR (tab is reported separately), DEL, C1 (NEL is a YAML 1.1 line break), LS/PS
// (YAML 1.1 line breaks) and a BOM anywhere.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLAIN = /^[A-Za-z_/][A-Za-z0-9 _./()+-]*$/;
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
/** YAML 1.1 readers take an exponent without a mantissa (`e5`) as a float. */
const EXPONENT = /^[eE][-+]?[0-9]+$/;
/** Plain scalars YAML 1.1 reads as booleans or null (1.2 only takes lowercase true/false/null). */
const AMBIGUOUS = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i;

/** Splits the comment off a line, respecting quotes. A `#` starts a comment at the start or after a space. */
function stripComment(content: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = undefined;
    } else if (quote === "'") {
      if (c === "'") {
        if (content[i + 1] === "'") i++;
        else quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || content[i - 1] === " ")) {
      return content.slice(0, i).trimEnd();
    }
  }
  return content.trimEnd();
}

function lex(text: string): Line[] {
  const lines: Line[] = [];
  const raw = text.split("\n");
  let seenContent = false;
  for (const [i, source] of raw.entries()) {
    const no = i + 1;
    let line = source;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.includes("\r")) throw new YamlError("yaml-syntax", no, "a carriage return must be followed by a line feed");
    if (line.includes("\t")) throw new YamlError("yaml-tab", no, "tabs are not allowed");
    const indent = line.length - line.trimStart().length;
    const content = stripComment(line.slice(indent));
    if (content === "") continue;
    if (indent === 0 && content.startsWith("%")) throw new YamlError("yaml-directive", no, "directives are not allowed");
    if (indent === 0 && (content === "---" || content.startsWith("--- ") || content === "..." || content.startsWith("... "))) {
      if (content === "---" && !seenContent) {
        seenContent = true;
        continue;
      }
      throw new YamlError("yaml-multi-document", no, "only one document, with at most one leading ---, is allowed");
    }
    seenContent = true;
    lines.push({ no, indent, text: content });
  }
  return lines;
}

const isItem = (text: string) => text === "-" || text.startsWith("- ");

function refuseIndicator(text: string, no: number, where: "key" | "value"): void {
  const first = text[0];
  if (first === "&") throw new YamlError("yaml-anchor", no, "anchors are not allowed");
  if (first === "*") throw new YamlError("yaml-alias", no, "aliases are not allowed");
  if (first === "!") throw new YamlError("yaml-tag", no, "tags are not allowed");
  if (first === "?") throw new YamlError("yaml-complex-key", no, "complex keys are not allowed");
  if (text.startsWith("<<")) throw new YamlError("yaml-merge-key", no, "merge keys are not allowed");
  if (where === "key" && (first === "[" || first === "{")) throw new YamlError("yaml-complex-key", no, "keys must be identifiers");
  if (where === "value" && (first === "|" || first === ">")) throw new YamlError("yaml-block-scalar", no, "block scalars are not allowed");
  if (where === "value" && first === "{") throw new YamlError("yaml-flow-mapping", no, "flow mappings are not allowed; use a block mapping");
}

function plainScalar(text: string, no: number): JsonValue {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (AMBIGUOUS.test(text)) throw new YamlError("yaml-ambiguous-scalar", no, "YAML 1.1 and 1.2 read this plain scalar differently; quote it or use lowercase true, false or null");
  if (EXPONENT.test(text)) throw new YamlError("yaml-number", no, "YAML 1.1 readers take this plain scalar as a number; quote it");
  if (INTEGER.test(text)) {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new YamlError("yaml-number", no, "integers must be safe integers");
    return value;
  }
  if (/^[-+]?\.?[0-9]/.test(text) ||/^[-+]?\.(?:inf|nan)$/i.test(text)) {
    throw new YamlError("yaml-number", no, "only decimal integers without leading zeros, signs or separators are allowed; quote anything else");
  }
  if (!PLAIN.test(text)) throw new YamlError("yaml-syntax", no, "this value needs quotes");
  return text;
}

/** Reads a quoted scalar starting at `text[start]`; returns the value and the index after it. */
function quotedScalar(text: string, start: number, no: number): [string, number] {
  const quote = text[start];
  let out = "";
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote === "'") {
      if (c !== "'") out += c;
      else if (text[i + 1] === "'") {
        out += "'";
        i++;
      } else return [out, i + 1];
      continue;
    }
    if (c === '"') return [out, i + 1];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = text[++i];
    const simple: Record<string, string> = { '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
    const unescaped = e === undefined || !Object.hasOwn(simple, e) ? undefined : simple[e];
    if (unescaped !== undefined) {
      out += unescaped;
    } else if (e === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 1, i + 5))) {
      const code = Number.parseInt(text.slice(i + 1, i + 5), 16);
      if (code >= 0xd800 && code <= 0xdfff) throw new YamlError("yaml-escape", no, "surrogate escapes are not allowed");
      out += String.fromCharCode(code);
      i += 4;
    } else {
      throw new YamlError("yaml-escape", no, 'only \\" \\\\ \\b \\f \\n \\r \\t and \\uXXXX escapes are allowed');
    }
  }
  throw new YamlError("yaml-syntax", no, "a quoted scalar must end on its line");
}

class Parser {
  readonly #lines: Line[];
  readonly #limits: YamlLimits;
  #pos = 0;

  constructor(lines: Line[], limits: YamlLimits) {
    this.#lines = lines;
    this.#limits = limits;
  }

  document(): JsonValue {
    const first = this.#lines[0];
    if (first === undefined) throw new YamlError("yaml-syntax", 0, "the document is empty");
    if (first.indent !== 0) throw new YamlError("yaml-indent", first.no, "the document must start at column 1");
    if (/^["'[{|>]/.test(first.text)) {
      refuseIndicator(first.text, first.no, "value");
      throw new YamlError("yaml-syntax", first.no, "the document must be a block mapping or a block sequence");
    }
    const value = this.#block(0, 1);
    const rest = this.#lines[this.#pos];
    if (rest !== undefined) throw new YamlError("yaml-indent", rest.no, "unexpected indentation");
    return value;
  }

  #block(indent: number, depth: number): JsonValue {
    const line = this.#lines[this.#pos];
    if (depth > this.#limits.maxDepth) throw new YamlError("yaml-too-deep", line?.no ?? 0, `nesting deeper than ${String(this.#limits.maxDepth)}`);
    return line !== undefined && isItem(line.text) ? this.#sequence(indent, depth) : this.#mapping(indent, depth);
  }

  /** A nested block after `key:` or `-`, which must follow on a more indented line. */
  #nested(parent: number, depth: number, no: number, compact: boolean): JsonValue {
    const next = this.#lines[this.#pos];
    if (next !== undefined && next.indent > parent) return this.#block(next.indent, depth);
    if (compact && next?.indent === parent && isItem(next.text)) {
      if (depth > this.#limits.maxDepth) throw new YamlError("yaml-too-deep", next.no, `nesting deeper than ${String(this.#limits.maxDepth)}`);
      return this.#sequence(parent, depth);
    }
    throw new YamlError("yaml-empty-value", no, "empty values are not allowed; write null explicitly");
  }

  #after(indent: number): void {
    const next = this.#lines[this.#pos];
    if (next !== undefined && next.indent > indent) throw new YamlError("yaml-indent", next.no, "unexpected indentation (multi-line scalars are not allowed)");
  }

  #sequence(indent: number, depth: number): JsonValue[] {
    const out: JsonValue[] = [];
    for (let line = this.#lines[this.#pos]; line?.indent === indent && isItem(line.text); line = this.#lines[this.#pos]) {
      const after = line.text.slice(1);
      const rest = after.trimStart();
      const column = indent + 1 + after.length - rest.length;
      if (rest === "") {
        this.#pos++;
        out.push(this.#nested(indent, depth + 1, line.no, false));
      } else if (isItem(rest) || this.#isEntry(rest, line.no)) {
        // `- key: value` or `- - x`: the item is a block starting at the item's column.
        this.#lines[this.#pos] = { no: line.no, indent: column, text: rest };
        out.push(this.#block(column, depth + 1));
      } else {
        this.#pos++;
        out.push(this.#inline(rest, line.no, depth + 1));
        this.#after(indent);
      }
    }
    return out;
  }

  #isEntry(text: string, no: number): boolean {
    if (/^["'[{]/.test(text)) return false;
    const colon = text.search(/:(?: |$)/);
    if (colon < 0) return false;
    refuseIndicator(text, no, "key");
    return true;
  }

  #mapping(indent: number, depth: number): JsonObject {
    const out: JsonObject = {};
    const keys = new Set<string>();
    for (let line = this.#lines[this.#pos]; line?.indent === indent; line = this.#lines[this.#pos]) {
      if (isItem(line.text)) throw new YamlError("yaml-syntax", line.no, "a sequence item can't appear among mapping keys");
      refuseIndicator(line.text, line.no, "key");
      const match = /^([^\s:]+):(?: +(.*))?$/.exec(line.text);
      if (match === null) throw new YamlError("yaml-syntax", line.no, "expected `key: value`");
      const [, key = "", rest = ""] = match;
      if (UNSAFE_KEYS.has(key)) throw new YamlError("yaml-unsafe-key", line.no, "this key is not allowed");
      if (!KEY.test(key)) throw new YamlError("yaml-syntax", line.no, "keys must be identifiers (letters, digits, _ and -)");
      if (AMBIGUOUS.test(key)) throw new YamlError("yaml-ambiguous-scalar", line.no, "YAML 1.1 reads this key as a boolean or null");
      if (EXPONENT.test(key)) throw new YamlError("yaml-number", line.no, "YAML 1.1 readers take this key as a number");
      if (keys.has(key)) throw new YamlError("yaml-duplicate-key", line.no, "duplicate key");
      keys.add(key);
      this.#pos++;
      if (rest === "") {
        out[key] = this.#nested(indent, depth + 1, line.no, true);
      } else {
        out[key] = this.#inline(rest, line.no, depth + 1);
        this.#after(indent);
      }
    }
    return out;
  }

  /** A value on the same line as its key or dash. `depth` is the depth a container here would have. */
  #inline(text: string, no: number, depth: number): JsonValue {
    refuseIndicator(text, no, "value");
    if (isItem(text)) throw new YamlError("yaml-syntax", no, "a sequence must start on its own line");
    if (text.startsWith("[")) {
      if (depth > this.#limits.maxDepth) throw new YamlError("yaml-too-deep", no, `nesting deeper than ${String(this.#limits.maxDepth)}`);
      return this.#flow(text, no);
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const [value, end] = quotedScalar(text, 0, no);
      if (end !== text.length) throw new YamlError("yaml-syntax", no, "unexpected text after a quoted scalar");
      return value;
    }
    return plainScalar(text, no);
  }

  /** `[a, "b", 1]` on one line: scalars only. */
  #flow(text: string, no: number): JsonValue[] {
    const out: JsonValue[] = [];
    let i = 1;
    const skip = () => {
      while (text[i] === " ") i++;
    };
    skip();
    if (text[i] === "]") {
      i++;
    } else {
      for (;;) {
        skip();
        const c = text[i];
        if (c === undefined) throw new YamlError("yaml-syntax", no, "a flow sequence must end on its line");
        if (c === "[") throw new YamlError("yaml-syntax", no, "nested flow sequences are not allowed");
        if (c === '"' || c === "'") {
          const [value, end] = quotedScalar(text, i, no);
          out.push(value);
          i = end;
        } else {
          const end = text.slice(i).search(/[,\]]/);
          if (end <= 0) throw new YamlError("yaml-syntax", no, end === 0 ? "empty flow sequence item" : "a flow sequence must end on its line");
          const item = text.slice(i, i + end).trimEnd();
          refuseIndicator(item, no, "value");
          if (item.startsWith("{")) throw new YamlError("yaml-flow-mapping", no, "flow mappings are not allowed");
          out.push(plainScalar(item, no));
          i += end;
        }
        skip();
        if (text[i] === ",") {
          i++;
          skip();
          if (text[i] === "]") throw new YamlError("yaml-syntax", no, "trailing commas are not allowed");
          continue;
        }
        if (text[i] === "]") {
          i++;
          break;
        }
        throw new YamlError("yaml-syntax", no, "expected , or ] in a flow sequence");
      }
    }
    if (i !== text.length) throw new YamlError("yaml-syntax", no, "unexpected text after a flow sequence");
    return out;
  }
}

/** Parses the restricted subset. Throws a YamlError for anything outside it. */
export function parseYamlSubset(input: Uint8Array, limits: YamlLimits = YAML_LIMITS): JsonValue {
  if (input.byteLength > limits.maxBytes) throw new YamlError("yaml-too-large", 0, `config exceeds ${String(limits.maxBytes)} bytes`);
  let text: string;
  try {
    text = decoder.decode(input);
  } catch {
    throw new YamlError("yaml-encoding", 0, "config is not valid UTF-8");
  }
  if (text.startsWith("\ufeff")) throw new YamlError("yaml-encoding", 0, "config must not start with a byte-order mark");
  const bad = FORBIDDEN.exec(text);
  if (bad !== null) {
    const line = text.slice(0, bad.index).split("\n").length;
    throw new YamlError("yaml-syntax", line, "control characters, NEL, LS and PS are not allowed");
  }
  return new Parser(lex(text), limits).document();
}

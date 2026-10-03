// Strict, bounded JSON parser for untrusted documents (02 §1, §5). `JSON.parse` can't reject
// duplicate keys, so every persisted or ingested document goes through this instead.
//
// On top of RFC 8259 it rejects: inputs over the byte limit, nesting over the depth limit, a
// byte-order mark, invalid UTF-8, lone surrogate escapes, duplicate keys, prototype-pollution
// keys, and any number that isn't a safe integer (PixelWatch documents hold integers only).
import { utf8Length } from "./text.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonLimits {
  /** Maximum encoded size in bytes. */
  readonly maxBytes: number;
  /** Maximum container nesting; a top-level object or array is depth 1. */
  readonly maxDepth: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = { maxBytes: 1024 * 1024, maxDepth: 32 };

export type JsonErrorCode =
  | "json-too-large"
  | "json-encoding"
  | "json-syntax"
  | "json-too-deep"
  | "json-duplicate-key"
  | "json-unsafe-key"
  | "json-number";

export class JsonError extends Error {
  readonly code: JsonErrorCode;
  constructor(code: JsonErrorCode, message: string) {
    super(message);
    this.name = "JsonError";
    this.code = code;
  }
}

/** Keys that would reach an object's prototype chain in careless consumers. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function describeKey(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
}

export function parseJson(input: Uint8Array | string, limits: JsonLimits = DEFAULT_JSON_LIMITS): JsonValue {
  let text: string;
  if (typeof input === "string") {
    if (utf8Length(input) > limits.maxBytes) {
      throw new JsonError("json-too-large", `JSON exceeds ${String(limits.maxBytes)} bytes`);
    }
    if (!input.isWellFormed()) throw new JsonError("json-encoding", "JSON text is not well-formed Unicode");
    text = input;
  } else {
    if (input.byteLength > limits.maxBytes) {
      throw new JsonError("json-too-large", `JSON exceeds ${String(limits.maxBytes)} bytes`);
    }
    try {
      text = decoder.decode(input);
    } catch {
      throw new JsonError("json-encoding", "JSON is not valid UTF-8");
    }
  }
  if (text.startsWith("﻿")) throw new JsonError("json-encoding", "JSON must not start with a byte-order mark");
  return new Parser(text, limits.maxDepth).parseDocument();
}

class Parser {
  private pos = 0;
  private readonly text: string;
  private readonly maxDepth: number;

  constructor(text: string, maxDepth: number) {
    this.text = text;
    this.maxDepth = maxDepth;
  }

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) this.fail("unexpected data after the JSON value");
    return value;
  }

  private fail(message: string, code: JsonErrorCode = "json-syntax"): never {
    throw new JsonError(code, `${message} at offset ${String(this.pos)}`);
  }

  private skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }

  private parseValue(depth: number): JsonValue {
    const c = this.text[this.pos];
    switch (c) {
      case "{":
        return this.parseObject(depth + 1);
      case "[":
        return this.parseArray(depth + 1);
      case '"':
        return this.parseString();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
        return this.fail(c === undefined ? "unexpected end of JSON" : "unexpected character");
    }
  }

  private literal<T extends JsonValue>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) this.fail("invalid literal");
    this.pos += word.length;
    return value;
  }

  private enter(depth: number): void {
    if (depth > this.maxDepth) this.fail(`nesting deeper than ${String(this.maxDepth)}`, "json-too-deep");
    this.pos++;
    this.skipWhitespace();
  }

  private parseObject(depth: number): JsonObject {
    this.enter(depth);
    const result: JsonObject = {};
    if (this.text[this.pos] === "}") {
      this.pos++;
      return result;
    }
    for (;;) {
      if (this.text[this.pos] !== '"') this.fail("expected a string key");
      const key = this.parseString();
      if (UNSAFE_KEYS.has(key)) this.fail(`unsafe key ${describeKey(key)}`, "json-unsafe-key");
      if (Object.hasOwn(result, key)) this.fail(`duplicate key ${describeKey(key)}`, "json-duplicate-key");
      this.skipWhitespace();
      if (this.text[this.pos] !== ":") this.fail("expected ':'");
      this.pos++;
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos++;
      if (next === "}") return result;
      if (next !== ",") {
        this.pos--;
        this.fail("expected ',' or '}'");
      }
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.enter(depth);
    const result: JsonValue[] = [];
    if (this.text[this.pos] === "]") {
      this.pos++;
      return result;
    }
    for (;;) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos++;
      if (next === "]") return result;
      if (next !== ",") {
        this.pos--;
        this.fail("expected ',' or ']'");
      }
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.pos++; // opening quote
    let out = "";
    let start = this.pos;
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (Number.isNaN(c)) this.fail("unterminated string");
      if (c === 0x22) {
        out += this.text.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail("unescaped control character in string");
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += this.text.slice(start, this.pos);
      this.pos++;
      const e = this.text[this.pos];
      this.pos++;
      switch (e) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u":
          out += this.parseUnicodeEscape();
          break;
        default:
          this.pos--;
          this.fail("invalid escape");
      }
      start = this.pos;
    }
  }

  private hex4(): number {
    const digits = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("invalid \\u escape");
    this.pos += 4;
    return Number.parseInt(digits, 16);
  }

  private parseUnicodeEscape(): string {
    const unit = this.hex4();
    if (unit >= 0xdc00 && unit <= 0xdfff) this.fail("lone low surrogate escape", "json-encoding");
    if (unit < 0xd800 || unit > 0xdbff) return String.fromCharCode(unit);
    if (!this.text.startsWith("\\u", this.pos)) this.fail("lone high surrogate escape", "json-encoding");
    this.pos += 2;
    const low = this.hex4();
    if (low < 0xdc00 || low > 0xdfff) this.fail("lone high surrogate escape", "json-encoding");
    return String.fromCharCode(unit, low);
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos, this.pos + 400));
    if (!match) return this.fail("invalid number");
    const [token, fraction, exponent] = match;
    if (fraction !== undefined || exponent !== undefined) {
      this.fail("only integers are allowed (no fractions or exponents)", "json-number");
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value)) this.fail("integer outside the safe range", "json-number");
    if (Object.is(value, -0)) this.fail("negative zero is not allowed", "json-number");
    this.pos += token.length;
    return value;
  }
}

// Bounded display text (02 §5): labels ≤ 256 code points (so ≤ 1024 UTF-8 bytes), messages
// ≤ 2048 bytes. No C0/C1 control characters in either.

export const MAX_LABEL_CODE_POINTS = 256;
export const MAX_MESSAGE_BYTES = 2048;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Makes untrusted text fit a bound: control characters become spaces, lone surrogates become
 * U+FFFD, runs of whitespace collapse, and the result is cut at a code point boundary.
 * Returns undefined when nothing printable is left.
 */
export function boundText(value: string, maxCodePoints: number, maxBytes = maxCodePoints * 4): string | undefined {
  const cleaned = value.toWellFormed().replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  let out = "";
  let count = 0;
  let bytes = 0;
  for (const ch of cleaned) {
    const size = utf8Length(ch);
    if (count + 1 > maxCodePoints || bytes + size > maxBytes) break;
    out += ch;
    count++;
    bytes += size;
  }
  out = out.trimEnd();
  return out === "" ? undefined : out;
}

export function boundLabel(value: string): string | undefined {
  return boundText(value, MAX_LABEL_CODE_POINTS);
}

export function boundMessage(value: string): string | undefined {
  return boundText(value, MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES);
}

import { describe, expect, it } from "vitest";
import { normalizePng } from "../src/convert/png-profile.ts";
import { PNG_SIGNATURE, chunk, ihdr, testdata, tinyPng } from "./helpers.ts";

function reason(png: Uint8Array): string {
  const result = normalizePng(png);
  return result.ok ? "ok" : result.reason;
}

describe("PNG chunk profile (02 §5)", () => {
  it("passes real prototype screenshots through unchanged", () => {
    for (const path of [
      ["prototypes", "propertyscope-36405830015", "visual-head-fixture", "f1-overview-error.png"],
      ["prototypes", "tracepilot-36314265418", "visual-head-1", "not-found.png"],
    ]) {
      const png = testdata(...path);
      const result = normalizePng(png);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Buffer.from(result.png).equals(png)).toBe(true);
        expect(result.width).toBe(1440);
      }
    }
  });

  it("strips ancillary chunks and keeps the image chunks", () => {
    const text = chunk("tEXt", Buffer.from("Comment\0hello"));
    const srgb = chunk("sRGB", Uint8Array.of(0));
    const time = chunk("tIME", new Uint8Array(7));
    const result = normalizePng(tinyPng({ before: [text, srgb], after: [time] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Buffer.from(result.png).equals(tinyPng())).toBe(true);
  });

  it("rejects everything outside the profile", () => {
    const idat = chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]));
    const iend = chunk("IEND");
    const build = (...chunks: Buffer[]) => Buffer.concat([PNG_SIGNATURE, ...chunks]);
    expect(reason(Buffer.from("GIF89a"))).toMatch(/signature/);
    expect(reason(build(ihdr(1, 1, 16), idat, iend))).toMatch(/8-bit/);
    expect(reason(build(ihdr(1, 1, 8, 3), idat, iend))).toMatch(/8-bit/);
    expect(reason(build(ihdr(1, 1, 8, 2, 1), idat, iend))).toMatch(/interlaced/);
    expect(reason(build(ihdr(0, 1), idat, iend))).toMatch(/dimension/);
    expect(reason(build(ihdr(16384, 1), idat, iend))).toMatch(/dimension/);
    expect(reason(build(ihdr(5000, 5000), idat, iend))).toMatch(/too many pixels/);
    expect(reason(build(idat, ihdr(1, 1), iend))).toMatch(/IHDR/);
    expect(reason(build(ihdr(1, 1), ihdr(1, 1), idat, iend))).toMatch(/more than one IHDR/);
    expect(reason(build(ihdr(1, 1), iend))).toMatch(/no IDAT/);
    expect(reason(build(ihdr(1, 1), idat, chunk("tEXt"), idat, iend))).toMatch(/contiguous/);
    expect(reason(build(ihdr(1, 1), chunk("ABCD"), idat, iend))).toMatch(/unknown critical/);
    expect(reason(build(ihdr(1, 1), idat, chunk("IEND", Uint8Array.of(1))))).toMatch(/IEND must be empty/);
    expect(reason(build(ihdr(1, 1), chunk("IDAT", Uint8Array.of(1), 0), iend))).toMatch(/CRC/);
    expect(reason(Buffer.concat([build(ihdr(1, 1), idat, iend), Buffer.from([0])]))).toMatch(/trailing/);
    expect(reason(build(ihdr(1, 1), idat))).toMatch(/truncated/);
    expect(reason(build(ihdr(1, 1), chunk("ID1T"), iend))).toMatch(/chunk type/);
    const huge = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from("IDAT")]);
    expect(reason(Buffer.concat([huge, Buffer.alloc(8)]))).toMatch(/exceeds the file/);
  });
});

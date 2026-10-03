import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { expect, it, vi } from "vitest";
import { startPreview } from "./serve.ts";

const race = vi.hoisted(() => ({ target: "", outside: "", armed: false, reached: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, realpathSync(path: import("node:fs").PathLike) {
    const canonical = fs.realpathSync(path);
    if (path === race.target && race.armed) {
      race.armed = false; race.reached++; fs.unlinkSync(race.target); fs.linkSync(race.outside, race.target);
    }
    return canonical;
  } };
});

it("preview refuses a file replaced by a link after canonical path validation before reading", async () => {
  const owned = mkdtempSync(join(tmpdir(), "pixelwatch-preview-race-")); const root = join(owned, "site");
  mkdirSync(join(root, "pixelwatch"), {recursive: true});
  race.target = join(root, "pixelwatch", "site.json"); race.outside = join(owned, "private.txt"); race.reached = 0;
  writeFileSync(race.target, "SAFE"); writeFileSync(race.outside, "LEAK");
  const preview = await startPreview(root); race.armed = true;
  try {
    const response = await new Promise<{status: number; text: string}>((done, fail) => {
      const outgoing = get(`${preview.origin}/pixelwatch/site.json`, (incoming) => {
        const chunks: Uint8Array[] = []; incoming.on("data", (chunk: Uint8Array) => {chunks.push(chunk);});
        incoming.once("end", () => {done({status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8")});});
        incoming.once("error", fail);
      }); outgoing.once("error", fail);
    });
    expect(race.reached).toBe(1); expect(response.status).toBe(404); expect(response.text).not.toContain("LEAK");
  } finally { race.armed = false; await preview.close(); }
});

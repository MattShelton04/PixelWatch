import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseDocument } from "../../packages/schemas/src/index.ts";
import { decodePng, pixelHash } from "../../packages/core/src/index.ts";
import { buildViewerFixture } from "./fixture.ts";
import { startPreview } from "./serve.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "pixelwatch-viewer-tooling-"));
const request = (origin: string, path: string) => new Promise<{status: number; body: Uint8Array}>((resolve, reject) => {
  const response = get(`${origin}${path}`, (incoming) => {
    const chunks: Uint8Array[] = [];
    incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    incoming.on("end", () => { resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }); });
    incoming.on("error", reject);
  }); response.on("error", reject);
});

it("builds reproducible actual app and core projected paired run with canonical PNG hash identities", async () => {
  const first = await buildViewerFixture(scratch()); const second = await buildViewerFixture(scratch());
  const path = `pixelwatch/api/v1/runs/${first.runKey}/changes.json`;
  const bytes = readFileSync(join(first.root, path)); expect(readFileSync(join(second.root, path))).toEqual(bytes);
  const changes = parseDocument("changes", bytes); expect(changes.ok).toBe(true); if (!changes.ok) throw new Error("invalid fixture");
  const pair = changes.value.results[0]; if (pair === undefined) throw new Error("missing paired result");
  for (const side of [pair.base, pair.head]) {
    expect(side.state).toBe("captured"); if (side.state !== "captured") throw new Error("missing side");
    const png = readFileSync(join(first.root, `pixelwatch/blobs/${side.pixelHash.slice(0, 2)}/${side.pixelHash}.png`));
    expect(pixelHash(await decodePng(png))).toBe(side.pixelHash);
  }
  const script = readFileSync(join(first.root, `pixelwatch/app/${first.release}/app.js`));
  expect(readFileSync(join(second.root, `pixelwatch/app/${first.release}/app.js`))).toEqual(script);
  const html = readFileSync(join(first.root, first.entryPath), "utf8");
  expect(html).toContain(`integrity="sha256-${createHash("sha256").update(script).digest("base64")}"`);
  expect(html).toContain("Capture failures"); expect(html).toContain("capture claims are untrusted");
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
});

it("refuses a nonempty fixture destination before writing or replacing existing files", async () => {
  const root = scratch(); writeFileSync(join(root, "preserve.txt"), "keep");
  await expect(buildViewerFixture(root)).rejects.toThrow("empty");
  expect(readFileSync(join(root, "preserve.txt"), "utf8")).toBe("keep");
});

it("loopback preview serves generated entries and refuses arbitrary active files and traversal", async () => {
  const fixture = await buildViewerFixture(scratch()); mkdirSync(join(fixture.root, ".git"));
  writeFileSync(join(fixture.root, ".git", "config"), "private"); writeFileSync(join(fixture.root, "evil.js"), "active");
  const preview = await startPreview(fixture.root);
  try {
    expect(preview.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
    const entry = await request(preview.origin, `/${fixture.entryPath}`); expect(entry.status).toBe(200);
    expect(new TextDecoder().decode(entry.body)).toContain("PixelWatch");
    for (const path of ["/.git/config", "/evil.js", "/pixelwatch/%2e%2e/evil.js", "/pixelwatch/%2f.git/config"]) {
      const value = await request(preview.origin, path); expect(value.status).toBe(404); expect(new TextDecoder().decode(value.body)).not.toMatch(/private|active/);
    }
  } finally { await preview.close(); }
});

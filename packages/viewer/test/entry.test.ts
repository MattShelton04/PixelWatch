import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SiteUrls } from "@pixelwatch/core";
import { canonicalBytes, parseDocument, type Changes } from "@pixelwatch/schemas";
import { renderEntry } from "../src/index.ts";

const release = "0.1.0-rc.1";
const script = new TextEncoder().encode("globalThis.__pixelwatchLoaded = true;\n");
const repository = { repositoryId: "987654321", owner: "owner", name: "repo" };
const urls = (pagesUrl = "https://owner.github.io/repo/", prefix = "pixelwatch") => new SiteUrls({ pagesUrl, prefix, expectedHost: "owner.github.io" });
function changes(): Changes {
  const bytes = readFileSync(new URL("../../../testdata/projection/site/api/v1/runs/10-a1/changes.json", import.meta.url));
  const parsed = parseDocument("changes", bytes); if (!parsed.ok) throw new Error("invalid committed changes fixture"); return parsed.value;
}
const html = (input: Parameters<typeof renderEntry>[0]) => new TextDecoder().decode(renderEntry(input));
const input = () => ({ urls: urls(), repository, assets: { release, script }, changes: changes() });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("base64");

describe("generated final viewer entry pages", () => {
  it("makes generated source and recovery links explicit keyboard tab stops across browser defaults", () => {
    const anchors = [...html(input()).matchAll(/<a\b[^>]*>/g)];
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of anchors) expect(anchor[0]).toContain('tabindex="0"');
  });
  it("puts the hash-only CSP first and pins exactly one classic defer script with matching SRI", () => {
    const page = html(input());
    expect(page).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
    const css = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1]; expect(css).toBeDefined();
    if (css === undefined) throw new Error("missing inline style");
    expect(page).toContain(`script-src 'sha256-${hash(script)}'`);
    expect(page).toContain(`style-src 'sha256-${hash(css)}'`);
    expect(page).toContain(`integrity="sha256-${hash(script)}"`);
    expect(page).toMatch(/<script defer src="\.\.\/\.\.\/app\/0\.1\.0-rc\.1\/app\.js" integrity="sha256-[A-Za-z0-9+/=]+"><\/script>/);
    expect(page.match(/<script\b/g)).toHaveLength(1); expect(page.match(/<style\b/g)).toHaveLength(1);
    expect(page).not.toMatch(/unsafe-inline|unsafe-eval|script-src 'self'|type="module"|worker-src|frame-ancestors/);
    expect(page).toContain("default-src 'none'"); expect(page).toContain("img-src 'self' blob:"); expect(page).toContain("connect-src 'self'");
  });

  it("regenerates script and style authorization from the release bytes rather than data claims", () => {
    const original = input(); const first = html(original);
    const changedScript = new TextEncoder().encode("globalThis.__pixelwatchLoaded = false;\n");
    const second = html({ ...original, assets: { release: "0.1.0", script: changedScript } });
    expect(second).toContain(`integrity="sha256-${hash(changedScript)}"`); expect(second).not.toContain(hash(script));
    expect(second).toContain("../../app/0.1.0/app.js"); expect(first).not.toContain("__pixelwatchLoaded");
  });

  it("keeps static reload home summary and source links outside the app root when JavaScript is absent", () => {
    const page = html(input());
    const app = /<div id="pixelwatch"[^>]*>([\s\S]*?)<\/div>/.exec(page)?.[1]; expect(app).toBeDefined();
    expect(app).not.toContain("Reload report"); expect(app).not.toContain("PixelWatch home");
    expect(page).toContain('href="https://owner.github.io/repo/pixelwatch/runs/10-a1/"');
    expect(page).toContain('href="https://owner.github.io/repo/pixelwatch/"');
    expect(page).toContain("Reload report"); expect(page).toContain("PixelWatch home");
    expect(page).toContain("expired or unavailable"); expect(page).toContain("JavaScript");
    expect(page).toContain("1 failed"); expect(page).toContain("1 missing"); expect(page).toContain("incomplete");
    expect(page).toContain("2 accounted"); expect(page).toContain("3 declared");
    expect(page).toContain("capture-error"); expect(page).toContain("advisory");
  });

  it("resolves the one app and bootstrap root for root project and nested-prefix sites", () => {
    for (const [pagesUrl, prefix] of [["https://owner.github.io/", "pixelwatch"], ["https://owner.github.io/repo/", "pixelwatch"], ["https://owner.github.io/repo/", "reports/visual"]]) {
      if (pagesUrl === undefined || prefix === undefined) throw new Error("fixture location missing");
      const location = urls(pagesUrl, prefix);
      const home = html({ urls: location, repository, assets: { release, script } });
      const run = html({ ...input(), urls: location });
      expect(home).toContain(`data-pw-site="${location.base}"`); expect(run).toContain(`data-pw-site="${location.base}"`);
      expect(home).toContain('src="app/0.1.0-rc.1/app.js"'); expect(run).toContain('src="../../app/0.1.0-rc.1/app.js"');
      const homeSource = /<script defer src="([^"]+)"/.exec(home)?.[1]; const runSource = /<script defer src="([^"]+)"/.exec(run)?.[1];
      if (homeSource === undefined || runSource === undefined) throw new Error("missing app URL");
      expect(new URL(homeSource, location.base).href).toBe(new URL(runSource, `${location.base}runs/10-a1/`).href);
      expect(home).not.toContain("data-pw-run-key"); expect(run).toContain('data-pw-run-key="10-a1"');
    }
  });

  it("uses escaped bounded capture text and suppresses bidi controls and mentions in the static failure summary", () => {
    const value = input(); const failed = value.changes.results[0]; if (failed === undefined || failed.head.state !== "failed") throw new Error("missing failure fixture");
    failed.labels = { title: '<img src=x onerror="alert(1)"><script>alert(2)</script> \u202e@maintainer \u2066@everyone & quote\'' };
    const page = html(value);
    expect(page).toContain("&lt;img"); expect(page).toContain("&lt;script&gt;"); expect(page).toContain("&amp;");
    expect(page).not.toContain("<img src=x"); expect(page).not.toContain("<script>steal"); expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("\u202e"); expect(page).not.toContain("\u2066"); expect(page).not.toContain("@maintainer"); expect(page).not.toContain("@everyone");
    expect(page.match(/<script\b/g)).toHaveLength(1);
  });

  it("builds source links only from the trusted repository and validated source identity", () => {
    const value = input(); value.changes.claims.head = { revisionSha: "f".repeat(40) };
    const page = html(value);
    expect(page).toContain('href="https://github.com/owner/repo/actions/runs/10/attempts/1"');
    expect(page).toContain(`href="https://github.com/owner/repo/commit/${"7".repeat(40)}"`);
    expect(page).not.toContain("f".repeat(40));
    const pr = structuredClone(value.changes); pr.source.event = "pull_request"; pr.source.association = "corroborated"; pr.source.prNumber = "7";
    expect(html({ ...value, changes: pr })).toContain('href="https://github.com/owner/repo/pull/7"');
    for (const match of page.matchAll(/<a [^>]*href="https:\/\/github\.com[^>]*>/g)) expect(match[0]).toContain('rel="noopener"');
  });

  it("emits an absolute OG PNG only from the generated pool path and a valid preview hash", () => {
    const value = input(); expect(html(value)).not.toContain('property="og:image"');
    const pixelHash = "a".repeat(64); const page = html({ ...value, previewPixelHash: pixelHash });
    expect(page).toContain(`property="og:image" content="https://owner.github.io/repo/pixelwatch/blobs/aa/${pixelHash}.png"`);
    for (const previewPixelHash of ["../bad", "javascript:alert(1)", "a".repeat(63), "A".repeat(64)]) expect(() => html({ ...value, previewPixelHash })).toThrow();
  });

  it("refuses unknown changes versions mismatched repositories unsafe source identities and executable fields", () => {
    for (const extra of [{ schemaVersion: 2 }, { source: { ...changes().source, repositoryId: "1" } }, { runKey: "../../head" }, { source: { ...changes().source, runId: "1?token=FAKE_CANARY" } }, { appUrl: "https://evil.invalid/active.js" }, { appHash: "a".repeat(64) }]) {
      expect(() => html({ ...input(), changes: { ...changes(), ...extra } as unknown as Changes })).toThrow();
    }
    for (const badRepository of [{ ...repository, owner: "../owner" }, { ...repository, owner: 'owner" onload="bad' }, { ...repository, name: "../head" }, { ...repository, repositoryId: "0" }]) expect(() => html({ ...input(), repository: badRepository })).toThrow();
    for (const badRelease of ["../release", "https://evil.invalid/app", "v0.1.0", '0.1.0" onload="bad']) expect(() => html({ ...input(), assets: { release: badRelease, script } })).toThrow();
  });

  it("revalidates mutable site URL fields and never treats data methods as trusted URL builders", () => {
    for (const base of ["javascript:alert(1)", "https://evil.invalid/?token=FAKE_CANARY", "https://owner.github.io/repo/pixelwatch/../other/"]) {
      const forged = urls(); Object.assign(forged, { base }); expect(() => html({ ...input(), urls: forged })).toThrow();
    }
  });

  it("shows unknown missing-part unit counts without claiming complete coverage or zero missing work", () => {
    const value = input(); value.changes.results = []; value.changes.counts = { missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: 0, subtle: 0, changed: 0 };
    value.changes.parts = []; value.changes.coverage = { status: "unknown", declaredUnits: 0, accountedUnits: 0, missingParts: [{ revision: "head", providerId: "tiny", shard: { index: 1, count: 1 }, reason: "not-received" }] };
    const page = html(value); expect(page).toContain("Coverage: unknown"); expect(page).toContain("1 missing parts with unknown unit counts");
    expect(page).not.toContain("complete-declared"); expect(page).not.toContain("0 missing parts");
  });

  it("bounds a long failure list while preserving its full failed count and mandatory warning", () => {
    const value = input(); const exemplar = value.changes.results[0]; if (exemplar === undefined) throw new Error("missing failure fixture");
    value.changes.results = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(exemplar), viewId: `failed-${String(index).padStart(2, "0")}`, labels: { title: "😀".repeat(256) } }));
    value.changes.counts = { missing: 0, failed: 20, incomparable: 0, added: 0, removed: 0, unchanged: 0, subtle: 0, changed: 0 };
    value.changes.coverage = { status: "complete-declared", declaredUnits: 20, accountedUnits: 20, missingParts: [] };
    const page = html(value); expect(page).toContain("20 failed"); expect(page).toContain("Showing 10 of 20 failed results.");
    expect(page).toContain("capture claims are untrusted"); expect(new TextEncoder().encode(page).byteLength).toBeLessThan(20_000);
  });

  it("invalid entry diagnostics never expose rejected fake tokens URL claims or label payloads", () => {
    const canary = "FAKE_ENTRY_CANARY"; const value = input(); Object.assign(value.changes, { appUrl: `https://evil.invalid/?token=${canary}` });
    let error: unknown; try { renderEntry(value); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(TypeError); expect(String(error) + JSON.stringify(error)).not.toContain(canary);
    expect(String(error) + JSON.stringify(error)).not.toContain("evil.invalid");
  });

  it("preserves canonical changes bytes and emits deterministic measured entry bytes", () => {
    const value = input(); const before = canonicalBytes(value.changes); const first = renderEntry(value); const second = renderEntry(value);
    expect(first).toEqual(second); expect(canonicalBytes(value.changes)).toEqual(before);
    expect(first.byteLength).toBeGreaterThan(1024); expect(first.byteLength).toBeLessThan(20_000);
  });
});

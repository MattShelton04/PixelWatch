import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "@playwright/test";
import type { Changes } from "@pixelwatch/schemas";
import { buildViewerFixture } from "../../../../tools/viewer/fixture.ts";
import { startPreview } from "../../../../tools/viewer/serve.ts";

type Fixture = Awaited<ReturnType<typeof buildViewerFixture>>;
let fixture: Fixture; let temporary: string; let preview: Awaited<ReturnType<typeof startPreview>> | undefined;
function currentPreview(): Awaited<ReturnType<typeof startPreview>> { if (preview === undefined) throw new Error("preview fixture was not started"); return preview; }
test.beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), "pixelwatch-viewer-")); fixture = await buildViewerFixture(temporary);
  preview = await startPreview(fixture.root);
});
test.afterAll(async () => {
  await preview?.close();
  const target = resolve(temporary); const confined = relative(resolve(tmpdir()), target);
  if (isAbsolute(confined) || !/^pixelwatch-viewer-[A-Za-z0-9_-]+$/.test(confined)) throw new Error("refuse fixture cleanup");
  rmSync(target, { recursive: true, force: true });
});
const entry = () => new URL(fixture.entryPath.replaceAll("\\", "/"), `${currentPreview().origin}/`).href;
test.beforeEach(async ({ page }) => {
  // Browser traffic has its own guard; the Node no-network guard cannot police a browser.
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === currentPreview().origin) await route.continue(); else await route.abort();
  });
});

test("actual generated run entry loads the final classic app with matching CSP SRI and before after images", async ({ page }) => {
  const violations: string[] = []; page.on("console", (message) => { if (message.type() === "error") violations.push(message.text()); });
  await page.goto(entry()); await expect(page.getByLabel("Visual result")).toBeVisible();
  await expect(page.getByRole("figure", { name: "Before" })).toBeVisible(); await expect(page.getByRole("figure", { name: "After" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reload report" })).toBeVisible(); await expect(page.getByRole("link", { name: "Source capture" }).first()).toBeVisible();
  const images = page.locator("#pixelwatch img"); await expect(images).toHaveCount(2);
  await expect.poll(() => images.evaluateAll((values) => values.every((value) => value instanceof HTMLImageElement && value.complete && value.naturalWidth > 0))).toBe(true);
  expect(violations.filter((value) => /content security policy|integrity|refused to/i.test(value))).toEqual([]);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test("missing or tampered app bytes leave the generated static reload home and summary usable", async ({ page }) => {
  for (const status of [404, 200]) {
    await page.route("**/app/*/app.js", (route) => route.fulfill({ status, contentType: "text/javascript", body: "globalThis.__tampered = true;" }));
    await page.goto(entry()); await expect(page.getByText("Loading visual report…")).toBeVisible();
    await expect(page.getByRole("link", { name: "Reload report" })).toBeVisible(); await expect(page.getByRole("link", { name: "PixelWatch home" })).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(globalThis, "__tampered"))).toBe(false);
    await expect(page.getByLabel("Run summary")).toBeVisible(); await page.unroute("**/app/*/app.js");
  }
});

test("JSON and PNG unavailability produce useful visible fallbacks without reload loops", async ({ page }) => {
  let documents = 0; page.on("request", (request) => { if (request.isNavigationRequest()) documents++; });
  await page.route("**/changes.json", (route) => route.fulfill({ status: 404, body: "unavailable" }));
  await page.goto(entry()); await expect(page.locator("#pixelwatch")).toContainText("Unable to load");
  await expect(page.getByRole("link", { name: "Reload report" })).toBeVisible(); expect(documents).toBe(1);
  await page.unroute("**/changes.json"); await page.route("**/blobs/**/*.png", (route) => route.fulfill({ status: 404, body: "unavailable" }));
  await page.goto(entry()); await expect(page.locator("#pixelwatch")).toContainText("Image expired or unavailable");
  await expect(page.getByRole("link", { name: "Reload report" })).toBeVisible(); expect(documents).toBe(2);
});

test("disabled JavaScript preserves the actual entry summary warnings source and recovery links", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  await context.route("**/*", async (route) => { if (new URL(route.request().url()).origin === currentPreview().origin) await route.continue(); else await route.abort(); });
  await page.goto(entry()); await expect(page.getByLabel("Run summary")).toBeVisible(); await expect(page.getByText(/capture claims are untrusted/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Source capture" })).toBeVisible(); await expect(page.getByRole("link", { name: "Reload report" })).toBeVisible(); await context.close();
});

test("poisoned shared origin storage cannot select app code destinations or approvals", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pixelwatch", '{"appUrl":"https://evil.invalid/active.js","token":"FAKE_VIEWER_CANARY","approved":true}');
    sessionStorage.setItem("pixelwatch", "javascript:alert(1)");
  });
  const external: string[] = []; await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== currentPreview().origin) { external.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  await page.goto(entry()); await expect(page.getByLabel("Visual result")).toBeVisible(); expect(external).toEqual([]);
  expect(await page.evaluate(() => document.cookie)).toBe("");
});

test("capture labels use text nodes with safe links and standard keyboard focus at each viewport", async ({ page }) => {
  await page.route("**/changes.json", async (route) => {
    const response = await route.fetch(); const value = await response.json() as { results: { labels?: { title: string } }[] };
    const first = value.results[0]; if (first === undefined) throw new Error("fixture missing selected result"); first.labels = { title: '<img src=x onerror="globalThis.__injected=true"> \u202e@maintainer' };
    await route.fulfill({ response, json: value });
  });
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(entry()); await expect(page.getByLabel("Visual result")).toBeVisible();
    await expect(page.locator("#pixelwatch")).toContainText("<img src=x"); expect(await page.evaluate(() => Object.hasOwn(globalThis, "__injected"))).toBe(false);
    expect(await page.locator("#pixelwatch [onerror]").count()).toBe(0); expect(await page.locator("#pixelwatch").textContent()).not.toContain("\u202e");
    await expect(page.locator("#pixelwatch")).toContainText("＠maintainer"); expect(await page.locator("#pixelwatch").textContent()).not.toContain("@maintainer");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByLabel("Visual result").focus(); await expect(page.getByLabel("Visual result")).toBeFocused(); await page.keyboard.press("Tab"); expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    const sources = page.getByRole("navigation", { name: "Source links" }).locator("a"); expect(await sources.count()).toBeGreaterThan(0);
    for (const source of await sources.evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute("href"), rel: node.getAttribute("rel") })))) {
      if (source.href === null) throw new Error("source anchor missing destination"); const destination = new URL(source.href);
      expect(destination.origin).toBe("https://github.com"); expect(destination.search).toBe(""); expect(destination.hash).toBe("");
      expect(destination.pathname).toMatch(/^\/PixelWatchPreview\/example\/(?:actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*|commit\/[a-f0-9]{40}|pull\/[1-9][0-9]*)$/);
      expect(source.rel?.split(/\s+/)).toContain("noopener");
    }
  }
});

test("only the selected pair is requested and switching units removes prior image sources", async ({ page }) => {
  const requests: string[] = []; page.on("request", (request) => { if (/\/blobs\/.+\.png$/.test(request.url())) requests.push(request.url()); });
  await page.goto(entry()); await expect(page.getByLabel("Visual result")).toBeVisible();
  const select = page.getByLabel("Visual result"); const options = await select.locator("option").count(); expect(options).toBeGreaterThan(1); expect(options).toBeLessThanOrEqual(100);
  const firstPair = await page.locator("#pixelwatch img").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  const previous = await page.evaluateHandle(() => Array.from(document.querySelectorAll("#pixelwatch img")));
  expect(new Set(requests).size).toBeLessThanOrEqual(2);
  const selected = await select.inputValue(); const next = await select.locator("option").evaluateAll((nodes, value) => nodes.find((node) => node.getAttribute("value") !== value)?.getAttribute("value"), selected);
  if (next === undefined || next === null) throw new Error("missing alternate fixture result");
  await select.selectOption(next); await expect(page.locator("#pixelwatch figure")).toHaveCount(2); expect(await page.locator("#pixelwatch img").count()).toBeLessThanOrEqual(2);
  expect(await previous.evaluate((nodes) => nodes.every((node) => !node.isConnected && !node.hasAttribute("src")))).toBe(true);
  await previous.dispose();
  expect(firstPair.every((value) => typeof value === "string" && new URL(value).origin === currentPreview().origin)).toBe(true);
});

test("large valid runs keep at most one hundred result options and one selected pair in the DOM", async ({ page }) => {
  await page.route("**/changes.json", async (route) => {
    const response = await route.fetch(); const value = await response.json() as Changes;
    const exemplar = value.results.find((result) => result.base.state === "captured" && result.head.state === "captured");
    if (exemplar === undefined || exemplar.images?.base === undefined) throw new Error("fixture missing two captured sides");
    const simple = { ...structuredClone(exemplar), status: "unchanged" as const, reasons: [], head: structuredClone(exemplar.base), images: { base: exemplar.images.base, head: exemplar.images.base } };
    delete simple.diff; delete simple.labels;
    value.capabilities = { diff: false, regions: false };
    value.parts = value.parts.filter((part) => part.status === "valid");
    value.results = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(simple), viewId: `unit-${String(index).padStart(4, "0")}` }));
    value.counts = { missing: 0, failed: 0, incomparable: 0, added: 0, removed: 0, unchanged: 1000, subtle: 0, changed: 0 };
    value.coverage = { status: "complete-declared", declaredUnits: 1000, accountedUnits: 1000, missingParts: [] };
    await route.fulfill({ response, json: value });
  });
  await page.goto(entry()); await expect(page.getByLabel("Visual result").locator("option")).toHaveCount(100);
  await expect(page.locator("#pixelwatch img")).toHaveCount(2); await expect(page.locator("#pixelwatch")).toContainText("of 1000 results");
  await page.getByRole("button", { name: "Next results" }).click(); await expect(page.getByLabel("Visual result")).toHaveValue("100");
  await expect(page.getByLabel("Visual result").locator("option")).toHaveCount(100);
  await page.getByRole("button", { name: "Previous results" }).click(); await expect(page.getByLabel("Visual result")).toHaveValue("0");
});

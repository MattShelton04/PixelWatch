import { createServer } from "node:http";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appScriptPath, classifyStorePath } from "../../packages/core/src/index.ts";
import { parseRunKey } from "../../packages/schemas/src/index.ts";

function servedPath(path: string): boolean {
  const stored = classifyStorePath(path);
  if (stored?.kind === "blob" || stored?.kind === "derived") return true;
  if (["index.html", "site.json", "llms.txt", "api/v1/index.json"].includes(path)) return true;
  if (/^api\/v1\/schemas\/(?:api-index|changes|pr-pointer|stream)-1\.json$/.test(path) || /^api\/v1\/pr\/[1-9][0-9]{0,18}\/latest\.json$/.test(path) || /^data\/v1\/streams\/(?:main|pr-[1-9][0-9]{0,18})\.json$/.test(path)) return true;
  const run = /^(?:runs\/([^/]+)\/index\.html|api\/v1\/runs\/([^/]+)\/changes\.json)$/.exec(path);
  if (run !== null) return parseRunKey(run[1] ?? run[2] ?? "") !== undefined;
  const app = /^app\/([^/]+)\/app\.js$/.exec(path);
  if (app === null) return false;
  try { return appScriptPath(app[1] ?? "") === path; } catch { return false; }
}

/** Loopback-only preview of generated files. It never proxies or executes store content. */
export async function startPreview(directory: string, options: {port?: number} = {}): Promise<{origin: string; close(): Promise<void>}> {
  const root = resolve(directory); const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error("invalid preview directory");
  const port = options.port ?? 0; if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("invalid preview port");
  const server = createServer((request, response) => {
    const missing = () => { response.writeHead(404, {"content-type": "text/plain", "x-content-type-options": "nosniff"}); response.end("Unavailable"); };
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { missing(); return; }
      const raw = request.url ?? "";
      if (!raw.startsWith("/") || raw.length > 2048 || /[%\\?#]|[^\x21-\x7e]/.test(raw)) { missing(); return; }
      const requested = raw.endsWith("/") ? `${raw}index.html` : raw;
      const segments = requested.slice(1).split("/");
      if (segments.length < 2 || segments.some((part) => !/^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}$/.test(part) || part === "." || part === "..")) { missing(); return; }
      // A configured prefix may have multiple segments. The suffix still must be a served shape.
      let allowed = false;
      for (let offset = 1; offset < segments.length; offset++) {
        if (servedPath(segments.slice(offset).join("/"))) { allowed = true; break; }
      }
      if (!allowed) { missing(); return; }
      let target = root;
      for (const segment of segments) {
        target = join(target, segment); const current = lstatSync(target);
        if (current.isSymbolicLink() || (!current.isDirectory() && (!current.isFile() || current.nlink !== 1))) { missing(); return; }
      }
      const file = lstatSync(target);
      if (!file.isFile() || file.size > 32 * 1024 * 1024 || realpathSync(target) !== target) { missing(); return; }
      const mime = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".json") ? "application/json" : target.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
      response.writeHead(200, {"content-type": mime, "content-length": String(file.size), "cache-control": "no-store", "x-content-type-options": "nosniff"});
      response.end(request.method === "HEAD" ? undefined : readFileSync(target));
    } catch { if (!response.headersSent) missing(); else response.destroy(); }
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => {server.off("error", fail); done();}); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("preview listener unavailable");
  return { origin: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((done, fail) => {server.close((error) => { if (error === undefined) done(); else fail(error); }); server.closeAllConnections();}) };
}

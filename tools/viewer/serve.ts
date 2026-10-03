import { createServer } from "node:http";
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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

interface PreviewFile { readonly target: string; readonly ancestors: readonly string[]; readonly dev: number; readonly ino: number; readonly bytes: number }
/** Requests only select these owned paths; an HTTP value never constructs a filesystem path. */
function inventory(root: string): ReadonlyMap<string, PreviewFile> {
  const files = new Map<string, PreviewFile>(); let visited = 0;
  const confined = (path: string): boolean => path.startsWith(`${root}${sep}`) && realpathSync(path) === path;
  const visit = (directory: string, parts: readonly string[], ancestors: readonly string[]): void => {
    const reader = opendirSync(directory);
    try {
      for (;;) {
        const entry = reader.readSync(); if (entry === null) break;
        if (++visited > 20_000) throw new Error("preview inventory limit");
        if (!/^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}$/.test(entry.name) || entry.name === "." || entry.name === "..") continue;
        const target = join(directory, entry.name); const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !confined(target)) continue;
        const next = [...parts, entry.name]; const chain = [...ancestors, target];
        if (stat.isDirectory()) { visit(target, next, chain); continue; }
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) continue;
        const path = next.join("/"); let allowed = false;
        for (let prefix = 1; prefix <= Math.min(4, next.length - 1); prefix++) {
          if (next.slice(0, prefix).every((part) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(part)) && servedPath(next.slice(prefix).join("/"))) { allowed = true; break; }
        }
        if (allowed) files.set(`/${path}`, {target, ancestors: chain, dev: stat.dev, ino: stat.ino, bytes: stat.size});
      }
    } finally { reader.closeSync(); }
  };
  visit(root, [], [root]); return files;
}

/** Loopback-only preview of generated files. It never proxies or executes store content. */
export async function startPreview(directory: string, options: {port?: number} = {}): Promise<{origin: string; close(): Promise<void>}> {
  const root = resolve(directory); const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw new Error("invalid preview directory");
  const port = options.port ?? 0; if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("invalid preview port");
  const files = inventory(root);
  let authority = "";
  const server = createServer((request, response) => {
    const missing = () => { response.writeHead(404, {"content-type": "text/plain", "x-content-type-options": "nosniff"}); response.end("Unavailable"); };
    try {
      const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host");
      if (authority === "" || hosts.length !== 1 || request.headers.host !== authority) { missing(); return; }
      if (request.method !== "GET" && request.method !== "HEAD") { missing(); return; }
      const raw = request.url ?? "";
      if (!raw.startsWith("/") || raw.length > 2048 || /[%\\?#]|[^\x21-\x7e]/.test(raw)) { missing(); return; }
      const requested = raw.endsWith("/") ? `${raw}index.html` : raw;
      const captured = files.get(requested); if (captured === undefined) { missing(); return; }
      const target = captured.target;
      for (const path of captured.ancestors) {
        const current = lstatSync(path);
        if (current.isSymbolicLink() || (!current.isDirectory() && (!current.isFile() || current.nlink !== 1))) { missing(); return; }
      }
      const file = lstatSync(target);
      if (!file.isFile() || file.dev !== captured.dev || file.ino !== captured.ino || file.size !== captured.bytes
        || !target.startsWith(`${root}${sep}`) || realpathSync(target) !== target) { missing(); return; }
      let body: Buffer | undefined; const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const checked = fstatSync(fd);
        if (!checked.isFile() || checked.nlink !== 1 || checked.dev !== captured.dev || checked.ino !== captured.ino || checked.size !== captured.bytes) { missing(); return; }
        if (request.method !== "HEAD") {
          body = Buffer.alloc(captured.bytes); let offset = 0;
          while (offset < body.byteLength) {
            const count = readSync(fd, body, offset, body.byteLength - offset, offset);
            if (count === 0) { missing(); return; } offset += count;
          }
          const after = fstatSync(fd);
          if (readSync(fd, Buffer.alloc(1), 0, 1, captured.bytes) !== 0 || after.size !== captured.bytes || after.nlink !== 1) { missing(); return; }
        }
      } finally { closeSync(fd); }
      const mime = target.endsWith(".html") ? "text/html; charset=utf-8" : target.endsWith(".js") ? "text/javascript; charset=utf-8" : target.endsWith(".json") ? "application/json" : target.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
      response.writeHead(200, {"content-type": mime, "content-length": String(file.size), "cache-control": "no-store", "x-content-type-options": "nosniff"});
      response.end(body);
    } catch { if (!response.headersSent) missing(); else response.destroy(); }
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => {server.off("error", fail); done();}); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("preview listener unavailable");
  authority = `127.0.0.1:${String(address.port)}`;
  return { origin: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((done, fail) => {server.close((error) => { if (error === undefined) done(); else fail(error); }); server.closeAllConnections();}) };
}

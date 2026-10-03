import { createHash } from "node:crypto";
import { appScriptPath, SiteUrls } from "@pixelwatch/core";
import { isGitHubId, validateDocument, type Changes } from "@pixelwatch/schemas";
import { ENTRY_STYLE } from "./style.ts";
import type { EntryInput } from "./types.ts";

const STATUS = ["missing", "failed", "incomparable", "added", "removed", "unchanged", "subtle", "changed"] as const;
const invalid = (): never => { throw new TypeError("PixelWatch entry: invalid-input"); };
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("base64");
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const display = (value: string, maxCodePoints = 256): string => {
  // The schema rejects controls; display also suppresses bidi/format controls and mentions.
  // eslint-disable-next-line no-control-regex -- untrusted display control suppression is intentional
  const cleaned = value.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "").replaceAll("@", "＠");
  let out = ""; let count = 0;
  for (const char of cleaned) { if (count++ >= maxCodePoints) return `${out}…`; out += char; }
  return out;
};
const link = (url: string, label: string): string => `<a href="${escape(url)}" rel="noopener">${escape(label)}</a>`;

/** Generate a pinned final entry using data only. The app bundle is trusted release input. */
export function renderEntry(input: EntryInput): Uint8Array {
  const { repository, assets, changes } = input;
  if (!isGitHubId(repository.repositoryId) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name) || repository.name === "." || repository.name === ".."
    || !(assets.script instanceof Uint8Array) || assets.script.byteLength === 0) invalid();
  // Reconstruct from fields rather than calling methods on an input object whose mutable
  // properties/prototype might have been replaced. SiteUrls revalidates host/path syntax.
  let urls: SiteUrls; let scriptPath: string;
  try {
    if (!input.urls.base.endsWith(`${input.urls.prefix}/`)) invalid();
    urls = new SiteUrls({ pagesUrl: input.urls.base.slice(0, -(input.urls.prefix.length + 1)), expectedHost: input.urls.host, prefix: input.urls.prefix });
    if (urls.base !== input.urls.base) invalid();
    scriptPath = appScriptPath(assets.release);
  } catch { return invalid(); }
  if (changes !== undefined) {
    const checked = validateDocument("changes", changes);
    if (!checked.ok || changes.source.repositoryId !== repository.repositoryId) invalid();
  }
  let preview = "";
  if (input.previewPixelHash !== undefined) {
    try { preview = `<meta property="og:image" content="${escape(urls.blob(input.previewPixelHash))}">`; } catch { return invalid(); }
  }
  const appHash = digest(assets.script); const styleHash = digest(ENTRY_STYLE);
  const csp = `default-src 'none'; script-src 'sha256-${appHash}'; style-src 'sha256-${styleHash}'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const title = changes === undefined ? "PixelWatch" : `PixelWatch · Run ${changes.runKey}`;
  const reload = changes === undefined ? urls.base : urls.runPage(changes.runKey);
  const app = changes === undefined ? scriptPath : `../../${scriptPath}`;
  const attributes = `data-pw-site="${escape(urls.base)}" data-pw-release="${escape(assets.release)}" data-pw-repository-id="${escape(repository.repositoryId)}" data-pw-owner="${escape(repository.owner)}" data-pw-repo="${escape(repository.name)}"${changes === undefined ? "" : ` data-pw-run-key="${escape(changes.runKey)}"`}`;
  const summary = changes === undefined ? "" : runSummary(changes, `https://github.com/${repository.owner}/${repository.name}`);
  const page = `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>${preview}<style>${ENTRY_STYLE}</style><script defer src="${escape(app)}" integrity="sha256-${appHash}"></script></head><body><main><header><span class="pw-brand">PixelWatch</span><span class="pw-repository">${escape(`${repository.owner}/${repository.name}`)}</span></header><h1>${escape(changes === undefined ? "Visual reports" : `Run ${changes.runKey}`)}</h1>${summary}<div id="pixelwatch" ${attributes}><p class="pw-loading" role="status">Loading visual report…</p></div><footer class="pw-fallback"><p>If JavaScript is disabled or this viewer cannot load, use the links below. A retained report may be expired or unavailable.</p><nav class="pw-links" aria-label="Report recovery">${link(reload, "Reload report")}${link(urls.base, "PixelWatch home")}</nav><p>PixelWatch ${escape(assets.release)} · Reports are public and advisory.</p></footer></main></body></html>`;
  return new TextEncoder().encode(page);
}

function runSummary(changes: Changes, repositoryUrl: string): string {
  const counts = `<ul class="pw-counts" aria-label="Result counts">${STATUS.map((status) => `<li>${String(changes.counts[status])} ${status}</li>`).join("")}</ul>`;
  const coverage = changes.coverage;
  const declared = `${String(coverage.declaredUnits)} declared`;
  const missing = coverage.missingParts.length === 0 ? "" : ` · ${String(coverage.missingParts.length)} missing parts with unknown unit counts`;
  const source = changes.source;
  const sources = [link(`${repositoryUrl}/actions/runs/${source.runId}/attempts/${source.attempt}`, "Source capture")];
  if (source.headSha !== undefined) sources.push(link(`${repositoryUrl}/commit/${source.headSha}`, "Head commit"));
  if (source.baseSha !== undefined) sources.push(link(`${repositoryUrl}/commit/${source.baseSha}`, "Baseline commit"));
  if (source.association === "corroborated" && source.prNumber !== undefined) sources.push(link(`${repositoryUrl}/pull/${source.prNumber}`, `Pull request #${source.prNumber}`));
  const failed = changes.results.filter((result) => result.status === "failed");
  const failureRows = failed.slice(0, 10).map((result) => {
    const identity = `${result.providerId}/${result.viewId}/${result.variantId}`;
    const label = result.labels?.title === undefined ? "" : ` · ${display(result.labels.title)}`;
    const sides = (["base", "head"] as const).flatMap((revision) => {
      const side = result[revision]; return side.state === "failed" ? [`${revision}: ${side.category}`] : [];
    });
    return `<li>${escape(identity + label)}: ${escape(sides.join("; "))}</li>`;
  }).join("");
  const failures = failed.length === 0 ? "" : `<section><h2>Capture failures</h2><ul class="pw-failures">${failureRows}</ul>${failed.length > 10 ? `<p>Showing 10 of ${String(failed.length)} failed results.</p>` : ""}</section>`;
  return `<section class="pw-card" aria-label="Run summary">${counts}<p>Coverage: ${escape(coverage.status)} · ${String(coverage.accountedUnits)} accounted · ${escape(declared + missing)}</p><p class="pw-warning">These results describe submitted pixels. Coverage reflects the capture’s declared catalog; capture claims are untrusted. Visual reports are advisory.</p><nav class="pw-links" aria-label="Source links">${sources.join("")}</nav>${failures}</section>`;
}

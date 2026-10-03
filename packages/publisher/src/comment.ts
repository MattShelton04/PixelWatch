// Layout derived from PropertyScope scripts/visual/comment.py at6378d8be (ADR0001).
// Data-only links, ownership, escaping and UTF-8 budgets follow05/ADR0026.
import { siteLocation, siteUrls } from "@pixelwatch/core";
import { isGitHubId, parseRunKey, type RunResult } from "@pixelwatch/schemas";
import { captureContext, checkedDocument, safely } from "./assembly-input.ts";
import { refuse, type CommentRenderInput, type CommentStamp, type RenderedComment } from "./types.ts";

const MAX_BODY = 60_000;
const MAX_FALLBACK = 8192;
const GENERATION = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STATUSES = ["missing","failed","incomparable","added","removed","unchanged","subtle","changed"] as const;
const length = (body: string): number => Buffer.byteLength(body,"utf8");
function display(value: string, bound: number): string {
  // eslint-disable-next-line no-control-regex -- Capture display intentionally strips control/bidi/format characters.
  const clean = value.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu,"").replaceAll("@","＠");
  let result = "", count = 0;
  for (const char of clean) {if (count++ >= bound) return `${result}…`; result += char;}
  return result;
}
/** Capture punctuation cannot become Markdown links, HTML or table delimiters. */
function tableText(value: string, bound: number): string {
  return display(value,bound).replace(/[&<>"'\\`*_[\]()|#!~:+./=\-{}%]/gu,char => `&#${String(char.codePointAt(0))};`);
}
const generatedLink = (label: string, url: string): string => `[${label}](<${url}>)`;
function rowText(row: RunResult, bound: number): string {
  return `| ${tableText(row.labels?.title ?? row.viewId,bound)} | ${tableText(`${row.providerId}/${row.viewId}/${row.variantId}`,256)} | ${row.status} |`;
}
function markers(repositoryId: string, stamp: CommentStamp): string {
  return `<!-- pixelwatch:repo:${repositoryId} -->\n<!-- pixelwatch:report:v1:${stamp.runKey}:${stamp.headSha ?? "none"}:${stamp.generation} -->`;
}

/** Pure renderer; the serialized caller separately proves readiness, head and numeric bot ownership. */
export function renderComment(input: CommentRenderInput): RenderedComment {
  return safely(() => {
    const context = captureContext(input.context);
    const run = checkedDocument("run",structuredClone(input.run));
    const generation = input.generation;
    if (typeof generation !== "string" || !GENERATION.test(generation) || run.source.repositoryId !== context.repository.repositoryId) refuse("comment-input-invalid");
    const urls = siteUrls(siteLocation(context.config,context.pages));
    const report = urls.runPage(run.runKey), repository = `https://github.com/${context.repository.owner}/${context.repository.name}`;
    const source = `${repository}/actions/runs/${run.source.runId}/attempts/${run.source.attempt}`;
    if (context.config.comment?.enabled === false) return {status: "disabled"};
    const stamp: CommentStamp = {runKey: run.runKey,generation,...(run.source.commits.head === undefined ? {} : {headSha: run.source.commits.head})};
    const mark = markers(context.repository.repositoryId,stamp);
    const warnings: string[] = [];
    if (run.counts.failed > 0) warnings.push(`Capture failures: ${String(run.counts.failed)}.`);
    if (run.counts.missing > 0) warnings.push(`Missing results: ${String(run.counts.missing)}.`);
    if (run.counts.incomparable > 0) warnings.push(`Incomparable results: ${String(run.counts.incomparable)}.`);
    if (run.coverage.status !== "complete-declared") warnings.push(`Coverage ${run.coverage.status}; the full declared capture is not proved.`);
    if (run.coverage.missingParts.length > 0) warnings.push(`Missing parts: ${String(run.coverage.missingParts.length)} with unknown unit counts.`);
    if (run.source.commits.base === undefined) warnings.push("Baseline unavailable; these results cannot prove an unchanged comparison.");
    if (run.source.commits.head === undefined) warnings.push("Head identity unavailable; no current-head PR reconciliation is eligible.");
    const complete = run.coverage.status === "complete-declared" && run.results.length > 0 && run.source.commits.base !== undefined && run.source.commits.head !== undefined && run.counts.unchanged === run.results.length;
    const verdict = complete ? "No visual changes in the declared coverage." : run.counts.changed > 0 ? `${String(run.counts.changed)} changed results; review the full report.` : "Review the declared results and their limitations in the full report.";
    const identity = `Run ${run.runKey} · Head ${run.source.commits.head ?? "unavailable"} · Attempt ${run.source.attempt}`;
    const coverage = `Coverage: ${run.coverage.status} · ${String(run.coverage.accountedUnits)} accounted · ${String(run.coverage.declaredUnits)} declared.`;
    const counts = STATUSES.map(status => `${String(run.counts[status])} ${status}`).join(" · ");
    const advisory = "Capture claims are untrusted; results describe submitted pixels and are advisory.";
    const required = [mark,"## PixelWatch",identity,verdict,...warnings,coverage,counts,advisory].join("\n\n");
    const reportLink = generatedLink("Full report",report);
    const fallbackBody = [mark,"PixelWatch",identity,verdict,...warnings,coverage,counts,advisory,`Full report: ${report}`].join("\n\n");
    if (length(fallbackBody) > MAX_FALLBACK) refuse("comment-budget-refused");
    const selected = run.results.filter(row => row.status !== "unchanged");
    const options = [{rows: 40,characters: 256,degradation: "full"}, {rows: 10,characters: 64,degradation: "shortened"}, {rows: 0,characters: 0,degradation: "summary"}] as const;
    for (const option of options) {
      const rows = selected.slice(0,option.rows);
      const table = rows.length === 0 ? "" : ["| View | Identity | Result |","|---|---|---|",...rows.map(row => rowText(row,option.characters))].join("\n");
      const omitted = selected.length > rows.length ? `${String(selected.length - rows.length)} more results in the full report.` : "";
      const body = [required,table,omitted,reportLink,`${generatedLink("Source capture",source)} · ${generatedLink("History",urls.base)}`].filter(Boolean).join("\n\n");
      const bytes = length(body);
      if (bytes <= MAX_BODY) return {status: "rendered",body,fallbackBody,bytes,degradation: option.degradation,stamp};
    }
    return refuse("comment-budget-refused");
  });
}

/** Stamp data alone authenticates no author and selects no mutation target. */
export function readCommentStamp(body: string, repositoryId: string): CommentStamp | undefined {
  try {
    if (typeof body !== "string" || length(body) > MAX_BODY || typeof repositoryId !== "string" || !isGitHubId(repositoryId)) return undefined;
    if ([...body.matchAll(/<!-- pixelwatch:repo:/gu)].length !== 1 || [...body.matchAll(/<!-- pixelwatch:report:/gu)].length !== 1) return undefined;
    const ownership = [...body.matchAll(/<!-- pixelwatch:repo:[^\r\n]*? -->/gu)];
    if (ownership.length !== 1 || ownership[0]?.[0] !== `<!-- pixelwatch:repo:${repositoryId} -->`) return undefined;
    const reports = [...body.matchAll(/<!-- pixelwatch:report:[^\r\n]*? -->/gu)];
    if (reports.length !== 1) return undefined;
    const match = /^<!-- pixelwatch:report:v1:([0-9]+-a[0-9]+):([a-f0-9]+|none):([a-f0-9]{64}) -->$/u.exec(reports[0]?.[0] ?? "");
    if (match === null) return undefined;
    const [,runKey = "",head = "",generation = ""] = match;
    if (parseRunKey(runKey)?.kind !== "source" || (head !== "none" && !OID.test(head))) return undefined;
    return {runKey,generation,...(head === "none" ? {} : {headSha: head})};
  } catch {return undefined;}
}

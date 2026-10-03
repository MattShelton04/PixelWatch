// The pure half of `pixelwatch-dev compare` (M1.8, ADR 0014): the exit-code table, the outcome
// rule, the report document, the summary text and bounded, escaped output lines. No I/O.
//
// Unknown is never safe (01 §4.3, R4.3-12): "no differences" needs a complete declared catalog,
// at least one result, and every result `unchanged`. Missing, failed and incomparable work, or
// incomplete coverage, is `incomplete`, whatever else changed.
import { type Analysis, capabilitiesOf } from "../../packages/core/src/index.ts";
import { type Changes, type ReceivedPart, canonicalJson } from "../../packages/schemas/src/index.ts";

/** Fixed and documented in ADR 0014. 0 comes only from a finished comparison with no differences. */
export const EXIT = Object.freeze({
  noDifferences: 0,
  differences: 1,
  incomplete: 2,
  invalidInput: 3,
  usage: 4,
  internal: 5,
});

export type Outcome = "no-differences" | "differences" | "incomplete";

export const OUTCOME_EXIT: Readonly<Record<Outcome, number>> = Object.freeze({
  "no-differences": EXIT.noDifferences,
  differences: EXIT.differences,
  incomplete: EXIT.incomplete,
});

const INCOMPLETE_STATUSES = new Set(["missing", "failed", "incomparable"]);

/** The outcome of one finished comparison, from the results themselves rather than the counts. */
export function outcomeOf(analysis: Pick<Analysis, "coverage" | "results">): Outcome {
  const { coverage, results } = analysis;
  if (coverage.status !== "complete-declared" || coverage.missingParts.length > 0) return "incomplete";
  if (results.length === 0 || coverage.declaredUnits !== results.length || coverage.accountedUnits !== results.length) return "incomplete";
  if (results.some((r) => INCOMPLETE_STATUSES.has(r.status))) return "incomplete";
  return results.every((r) => r.status === "unchanged") ? "no-differences" : "differences";
}

/** Where the expected parts came from: an adopter config, or the parts the inputs name. */
export type ExpectedFrom = "config" | "inputs";

export interface Excluded {
  readonly count: number;
  readonly sample: readonly { providerId: string; viewId: string; variantId: string }[];
}

/**
 * The report on stdout. It's a local, internal document, not a 02 §1 contract: there is no
 * source envelope, so it is neither run@1 nor changes@1, and it says so instead of faking one.
 * Results, parts, coverage and counts are exactly what buildAnalysis gives a run (minus the
 * artifact IDs, which a local input doesn't have).
 */
export interface DevReport {
  readonly report: "pixelwatch-dev-compare";
  readonly reportVersion: 1;
  readonly outcome: Outcome;
  readonly source: { readonly kind: "local"; readonly corroborated: false };
  readonly captureClaimsTrusted: false;
  readonly expectedParts: ExpectedFrom;
  readonly baseline: "inputs" | "none";
  readonly comparator: { readonly version: 1 };
  readonly capabilities: Changes["capabilities"];
  readonly claims: Analysis["claims"];
  readonly parts: readonly Omit<ReceivedPart, "artifactId">[];
  readonly coverage: Analysis["coverage"];
  readonly counts: Analysis["counts"];
  readonly excluded: Excluded;
  readonly results: Analysis["results"];
}

export function buildReport(analysis: Analysis, excluded: Excluded, expectedParts: ExpectedFrom, baseline: "inputs" | "none"): DevReport {
  return {
    report: "pixelwatch-dev-compare",
    reportVersion: 1,
    outcome: outcomeOf(analysis),
    source: { kind: "local", corroborated: false },
    captureClaimsTrusted: false,
    expectedParts,
    baseline,
    comparator: { version: 1 },
    capabilities: capabilitiesOf(analysis.results, "the local comparison"),
    claims: analysis.claims,
    parts: analysis.parts.map(({ revision, providerId, shard, status, diagnostic }) => ({
      revision,
      providerId,
      shard,
      status,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })),
    coverage: analysis.coverage,
    counts: analysis.counts,
    excluded: { count: excluded.count, sample: excluded.sample.map((k) => ({ providerId: k.providerId, viewId: k.viewId, variantId: k.variantId })) },
    results: analysis.results,
  };
}

function hex4(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

/**
 * Canonical JSON (02 §3) with every code unit outside printable ASCII written as a \u escape, plus
 * one LF. It parses to exactly the canonical document, and no label can put a control, bidi or
 * other invisible character on the terminal.
 */
export function reportJson(report: DevReport): string {
  return `${canonicalJson(report).replace(/[^\x20-\x7e]/g, (c) => hex4(c.charCodeAt(0)))}\n`;
}

/** Bounds on everything written to stderr. */
export const MAX_LINE_CHARS = 1024;
export const MAX_ERROR_LINES = 20;

/**
 * Printable ASCII only: a backslash and every other code point are escaped (`\\`, `\u{…}`), so
 * control, bidi and zero-width characters never reach the terminal raw. Cut on an escape boundary
 * at `max` characters.
 */
export function escapeText(text: string, max = MAX_LINE_CHARS): string {
  let out = "";
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const piece = char === "\\" ? "\\\\" : cp >= 0x20 && cp <= 0x7e ? char : `\\u{${cp.toString(16)}}`;
    if (out.length + piece.length > max - 3) return `${out}...`;
    out += piece;
  }
  return out;
}

/** One bounded stderr line. */
export function errorLine(kind: string, code: string, message: string): string {
  return `${escapeText(`pixelwatch-dev: ${kind} [${code}]: ${message}`)}\n`;
}

/** At most MAX_ERROR_LINES lines; the rest are counted, never printed. */
export function errorLines(kind: string, items: readonly { code: string; message: string }[]): string {
  const shown = items.slice(0, MAX_ERROR_LINES - 1).map((i) => errorLine(kind, i.code, i.message));
  const more = items.length - shown.length;
  return shown.join("") + (more > 0 ? errorLine(kind, "more", `${String(more)} more not shown`) : "");
}

const MAX_SUMMARY_RESULTS = 200;

function partName(p: { revision: string; providerId: string; shard: { index: number; count: number } }): string {
  return `${p.revision}/${p.providerId}/s${String(p.shard.index)}-of${String(p.shard.count)}`;
}

/**
 * A human summary. It names units by their IDs only (02 §3 patterns) and never prints labels,
 * claims or other capture text. Every result that isn't `unchanged` is listed, up to 200.
 */
export function summaryText(report: DevReport): string {
  const { coverage, counts } = report;
  const lines = [
    `outcome: ${report.outcome} (exit ${String(OUTCOME_EXIT[report.outcome])})`,
    "source: local inputs; nothing is corroborated and capture claims are untrusted",
    `comparator: v${String(report.comparator.version)}; expected parts from: ${report.expectedParts}; baseline: ${report.baseline}`,
    `coverage: ${coverage.status}; ${String(coverage.declaredUnits)} declared, ${String(coverage.accountedUnits)} accounted, ${String(coverage.missingParts.length)} missing parts`,
    `counts: ${(Object.keys(counts) as (keyof typeof counts)[]).map((k) => `${k} ${String(counts[k])}`).join(", ")}`,
  ];
  for (const part of coverage.missingParts) lines.push(`missing part: ${partName(part)} (${part.reason})`);
  if (report.excluded.count > 0) lines.push(`excluded: ${String(report.excluded.count)} units absent on both sides`);
  const listed = report.results.filter((r) => r.status !== "unchanged");
  for (const r of listed.slice(0, MAX_SUMMARY_RESULTS)) {
    lines.push(`${r.status} ${r.providerId}/${r.viewId}/${r.variantId}${r.reasons.length > 0 ? ` [${r.reasons.join(", ")}]` : ""}`);
  }
  if (listed.length > MAX_SUMMARY_RESULTS) lines.push(`... ${String(listed.length - MAX_SUMMARY_RESULTS)} more results not shown`);
  return lines.map((line) => `${escapeText(line)}\n`).join("");
}

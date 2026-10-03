// changes@1 from one run@1 (02 §7; ADR 0013). A pure function of the run and the site location,
// serialized as canonical JSON, so a run's changes.json never changes under its URL.
//
// - Status, reasons, sides, coverage, counts and parts pass through from the run unchanged: the
//   projection never reclassifies, so missing, failed and incomparable can't become unchanged.
// - `source` holds only corroborated envelope facts; `claims` holds the capture's untrusted
//   claims, and `captureClaimsTrusted` is always false.
// - Image URLs exist only for captured sides, built from the site location and the pixel hash.
// - A capability is true exactly when its fields are present: `diff` when some result has a diff,
//   `regions` when every analysis has regions. A run that has regions on only some analyses can't
//   be stated truthfully and is refused.
import { type ChangeResult, type Changes, type Run, type Side, validateDocument } from "@pixelwatch/schemas";
import { refuse } from "./errors.ts";
import type { SiteUrls } from "./site.ts";

function capabilities(run: Run): Changes["capabilities"] {
  const analyses = run.results.flatMap((r) => r.diff?.analyses ?? []);
  const diff = run.results.some((r) => r.diff !== undefined);
  const grouped = analyses.filter((a) => a.regions !== undefined).length;
  if (grouped !== 0 && grouped !== analyses.length) {
    refuse("invalid-input", `${run.runKey} has regions on some analyses but not others`);
  }
  return { diff, regions: diff && grouped === analyses.length };
}

function source(run: Run): Changes["source"] {
  const { repositoryId, workflowId, runId, attempt, event, createdAt, association, commits } = run.source;
  return {
    repositoryId,
    workflowId,
    runId,
    attempt,
    event,
    createdAt,
    association: association.status,
    ...(association.prNumber === undefined ? {} : { prNumber: association.prNumber }),
    ...(commits.head === undefined ? {} : { headSha: commits.head }),
    ...(commits.base === undefined ? {} : { baseSha: commits.base }),
    ...(commits.baseBranch === undefined ? {} : { baseBranchSha: commits.baseBranch }),
  };
}

function images(base: Side, head: Side, urls: SiteUrls): ChangeResult["images"] {
  const out: NonNullable<ChangeResult["images"]> = {};
  if (base.state === "captured") out.base = urls.blob(base.pixelHash);
  if (head.state === "captured") out.head = urls.blob(head.pixelHash);
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Projects one run. Throws a ProjectionError for an invalid run; nothing is repaired. */
export function projectChanges(run: Run, urls: SiteUrls): Changes {
  const checked = validateDocument("run", run);
  if (!checked.ok) refuse("invalid-input", `the run is invalid: ${checked.issue.message}`);
  const results: ChangeResult[] = run.results.map((r) => {
    const urlsFor = images(r.base, r.head, urls);
    return {
      providerId: r.providerId,
      viewId: r.viewId,
      variantId: r.variantId,
      status: r.status,
      reasons: [...r.reasons],
      ...(r.labels === undefined ? {} : { labels: structuredClone(r.labels) }),
      base: structuredClone(r.base),
      head: structuredClone(r.head),
      ...(urlsFor === undefined ? {} : { images: urlsFor }),
      ...(r.diff === undefined ? {} : { diff: structuredClone(r.diff) }),
    };
  });
  const changes: Changes = {
    schemaVersion: 1,
    runKey: run.runKey,
    source: source(run),
    captureClaimsTrusted: false,
    claims: structuredClone(run.claims),
    comparator: { version: run.versions.comparator },
    capabilities: capabilities(run),
    parts: structuredClone(run.parts),
    coverage: structuredClone(run.coverage),
    counts: { ...run.counts },
    results,
  };
  const valid = validateDocument("changes", changes);
  if (!valid.ok) refuse("invalid-input", `the projected changes are invalid: ${valid.issue.message}`);
  return changes;
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, validateDocument, type Run } from "@pixelwatch/schemas";
import { GOLDEN_RUNS } from "../../../tools/projection-goldens/generate.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";
import { readCommentStamp, renderComment } from "../src/comment.ts";
import { PublisherError, type CommentRenderInput, type RenderedComment } from "../src/types.ts";

function fixture(name = "all-eight-statuses"): CommentRenderInput {
  const parsed = parseDocument("run", readFileSync(new URL(`../../../testdata/schemas/run/valid/${name}.json`, import.meta.url)));
  if (!parsed.ok) throw new Error("comment-fixture-invalid");
  return {run: parsed.value, generation: "a".repeat(64), context: {
    config: {schemaVersion: 1, source: {workflowIds: ["123456"], events: ["push", "pull_request"]}, providers: [{id: "fixture", shards: 1}]},
    configCommit: "3".repeat(40), repository: {repositoryId: "987654321", owner: "owner", name: "repo"},
    pages: {url: "https://owner.github.io/repo/", host: "owner.github.io"}, assets: {release: "0.1.0-rc.1", releaseCommit: "4".repeat(40), script: new Uint8Array([1])},
  }};
}
function output(input: CommentRenderInput): Extract<RenderedComment, {status: "rendered"}> {
  const result = renderComment(input); expect(result.status).toBe("rendered");
  if (result.status !== "rendered") throw new Error("comment-unexpected-disabled");
  expect(result.bytes).toBe(Buffer.byteLength(result.body)); expect(result.bytes).toBeLessThanOrEqual(60_000);
  expect(Buffer.byteLength(result.fallbackBody)).toBeLessThanOrEqual(8192);
  assertNoSecrets([JSON.stringify(result), result.body, result.fallbackBody]); return result;
}
function refuses(input: CommentRenderInput): void {
  let caught: unknown; try {renderComment(input);} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(PublisherError);
  const error = caught as PublisherError; assertNoSecrets([String(error), JSON.stringify(error), error.stack ?? ""]); expect(error.cause).toBeUndefined();
}
describe("fixed trusted PR comment rendering", () => {
  it("renders authenticated source identity all eight counts warnings and canonical report links", () => {
    const w = fixture(); const r = output(w);
    expect(r.body).toContain("## PixelWatch"); expect(r.body).toContain(w.run.runKey); expect(r.body).toContain(w.run.source.commits.head);
    for (const status of Object.keys(w.run.counts)) expect(r.body).toContain(`${String(w.run.counts[status as keyof Run["counts"]])} ${status}`);
    expect(r.body).toContain("Capture failures"); expect(r.body).toContain("Missing results"); expect(r.body).toContain("Incomparable results");
    expect(r.body).toContain("https://owner.github.io/repo/pixelwatch/runs/36405830015-a2/"); expect(r.body).toContain("https://github.com/owner/repo/actions/runs/36405830015/attempts/2");
    expect(r.body).not.toContain("No visual changes"); expect(r.body).not.toMatch(/<img|<script|<details/i);
  });
  it("allows no visual changes only for a nonempty complete comparable unchanged declared catalog", () => {
    const w = fixture(); (w as {run: Run}).run = structuredClone(GOLDEN_RUNS["propertyscope-pr123"]);
    expect(validateDocument("run", w.run).ok).toBe(true); const r = output(w);
    expect(r.body).toContain("No visual changes in the declared coverage"); expect(r.body).toContain("Capture claims are untrusted"); expect(r.body).toContain("advisory");
  });
  it.each(["initial-commit-no-baseline", "no-usable-artifact"])("%s never reports unchanged or zero missing work", name => {
    const w = fixture(name); const r = output(w); expect(r.body).not.toContain("No visual changes");
    expect(r.body).toContain("Baseline unavailable");
    if (name === "no-usable-artifact") expect(r.body).toContain("unknown unit counts");
    expect(r.fallbackBody).not.toContain("No visual changes");
  });
  it("capture Markdown HTML mentions bidi and URL text stay canonical safe table text", () => {
    const w = fixture(); const row = w.run.results.find(result => result.status === "changed"); if (row === undefined) throw new Error("row-fixture-invalid");
    row.labels = {title: 'a|b [x](https://evil.invalid/) `<img>` @team & &#64; \u202etext 😀'};
    expect(validateDocument("run", w.run).ok).toBe(true); const r = output(w);
    expect(r.body).toContain("＠team"); expect(r.body).not.toContain("\u202e"); expect(r.body).not.toContain("<img>"); expect(r.body).not.toContain("https://evil.invalid/");
    expect(r.body).toContain("&#124;"); expect(r.body).toContain("&#91;"); expect(r.body).toContain("&#96;"); expect(r.body).toContain("😀"); expect(r.body).not.toContain("@team");
  });
  it("natural escaped multibyte overflow degrades rows deterministically and retains every required warning", () => {
    const w = fixture(); const row = w.run.results.find(result => result.status === "changed"); if (row === undefined) throw new Error("row-fixture-invalid");
    const clone = structuredClone(row); clone.labels = {title: "~".repeat(255) + "😀"};
    w.run.results.push(...Array.from({length: 60}, (_, index) => ({...structuredClone(clone), viewId: `overflow-${String(index).padStart(3,"0")}`})));
    w.run.results.sort((a,b) => a.providerId.localeCompare(b.providerId) || a.viewId.localeCompare(b.viewId) || a.variantId.localeCompare(b.variantId));
    w.run.counts.changed += 60; w.run.coverage.declaredUnits += 60; w.run.coverage.accountedUnits += 60;
    expect(validateDocument("run", w.run).ok).toBe(true); const r = output(w); expect(r.degradation).toBe("shortened");
    expect(renderComment(w)).toEqual(r);
    for (const body of [r.body,r.fallbackBody]) for (const required of [w.run.runKey,"Capture failures","Missing results","Incomparable results","Full report","advisory"]) expect(body).toContain(required);
    expect(r.body).toContain("more results in the full report");
  });
  it("unknown policy and run versions refuse even if comments are disabled", () => {
    for (const target of ["config", "run"] as const) {const w = fixture(); w.context.config.comment = {enabled: false};
      if (target === "config") (w.context.config as {schemaVersion: number}).schemaVersion = 99; else (w.run as {schemaVersion: number}).schemaVersion = 99;
      refuses(w);
    }
  });
  it("valid disabled comments return no body and do not imply served or commented status", () => {
    const w = fixture(); w.context.config.comment = {enabled: false}; expect(renderComment(w)).toEqual({status: "disabled"});
  });
  it.each(["repository", "host", "generation"])("refuses %s mismatch before producing a destination", field => {
    const w = fixture(); if (field === "repository") (w.context.repository as {repositoryId: string}).repositoryId = "1";
    if (field === "host") (w.context.pages as {host: string}).host = "evil.invalid";
    if (field === "generation") (w as {generation: string}).generation = SIGNED_URL;
    refuses(w);
  });
  it("poisoned capture getters refuse without raw causes or fake secrets", () => {
    const w = fixture(); let reached = 0; Object.defineProperty(w.run,"counts",{get() {reached++; throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}});
    refuses(w); expect(reached).toBe(1);
  });
  it("input capture reads each trusted parent once and cannot call supplied URL or array methods", () => {
    const w = fixture(); let parents = 0; let maps = 0;
    Object.defineProperty(w,"context",{get() {parents++; return parents === 1 ? fixture().context : {pages: {url: SIGNED_URL}};}});
    Object.defineProperty(w.run.results,"map",{value() {maps++; throw new Error(CANARY_TOKEN);}});
    const r = output(w); expect(parents).toBe(1); expect(maps).toBe(0); expect(r.body).toContain("https://owner.github.io/repo/pixelwatch/");
  });
  it("stamp roundtrip validates exact repository marker run head and generation without granting author ownership", () => {
    const w = fixture(); const r = output(w); expect(readCommentStamp(r.body,w.run.source.repositoryId)).toEqual(r.stamp);
    expect(readCommentStamp(r.fallbackBody,w.run.source.repositoryId)).toEqual(r.stamp);
    expect(readCommentStamp(r.body,"1")).toBeUndefined();
  });
  it("duplicate forged malformed unknown and oversized stamps provide no ordering proof", () => {
    const w = fixture(); const r = output(w); const repo = w.run.source.repositoryId;
    const stamp = /<!-- pixelwatch:report:[^\n]+ -->/.exec(r.body)?.[0]; if (stamp === undefined) throw new Error("stamp-missing");
    for (const body of [r.body + stamp,r.body.replace("report:v1:","report:v99:"),r.body.replace(w.run.runKey, "../bad"),r.body + `<!-- pixelwatch:repo:${repo} -->`,"x".repeat(60001)]) expect(readCommentStamp(body,repo)).toBeUndefined();
    expect(readCommentStamp(`${r.body}\n<!-- pixelwatch:report:v1:1-a1:none:${"a".repeat(64)} -->`,repo)).toBeUndefined();
  });
  it.each(["0-a1","01-a1","1-a0","12345678901234567890-a1"])("invalid source stamp key %s cannot supply ordering proof", key => {
    const w = fixture(); const r = output(w); expect(readCommentStamp(r.body.replaceAll(w.run.runKey,key),w.run.source.repositoryId)).toBeUndefined();
  });
  it("an extra unterminated report or ownership marker refuses a previously valid stamp", () => {
    const w = fixture(); const r = output(w);
    for (const prefix of ["<!-- pixelwatch:report:","<!-- pixelwatch:repo:"]) expect(readCommentStamp(r.body + prefix,w.run.source.repositoryId)).toBeUndefined();
  });
});

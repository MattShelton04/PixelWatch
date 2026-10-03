// Traceability check for docs/security/threat-model.md (07 §6, M0.4): every 01 §4 rule maps to a
// named test or evidence item, and no row claims more than exists.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/lint-tools.ts";
import { scenarios } from "./simulation/scenarios/index.ts";

const doc = readFileSync(path.join(repoRoot, "docs", "security", "threat-model.md"), "utf8");

/** Rows of the Markdown table between `<!-- name:begin -->` and `<!-- name:end -->`, header and rule dropped. */
function tableRows(name: string): string[][] {
  const begin = doc.indexOf(`<!-- ${name}:begin -->`);
  const end = doc.indexOf(`<!-- ${name}:end -->`);
  if (begin < 0 || end < begin) throw new Error(`missing ${name} markers`);
  return doc
    .slice(begin, end)
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

const RULE_ID = /^R4\.[1-7]-\d{2}$/;
const STATUSES = new Set(["passing", "planned", "recorded", "evidence-planned"]);
const OWNER = /^(M\d\.\d+|S\d+)$/;
const WHERE = /^`([^`]+)`(?: › "([^"]+)"| .+)?$/;

const rules = tableRows("rules").map(([id, , boundary]) => ({
  id: id ?? "",
  boundaries: (boundary ?? "").split(",").map((b) => b.trim()),
}));
const checks = tableRows("verification").map(([rule, layer, status, where, invariant, owner]) => ({
  rules: (rule ?? "").split(",").map((r) => r.trim()),
  layer: layer ?? "",
  status: status ?? "",
  where: where ?? "",
  invariant: invariant ?? "",
  owner: owner ?? "",
}));
const boundaryIds = [...doc.matchAll(/^\| (TB\d+) \|/gm)].map((m) => m[1] ?? "");

describe("threat model traceability (07 §6)", () => {
  it("has unique, well-formed rule IDs covering every 01 §4 subsection", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const { id } of rules) expect(id).toMatch(RULE_ID);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    const sections = new Set(rules.map((r) => r.id.slice(1, 4)));
    expect([...sections].sort()).toEqual(["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7"]);
  });

  it("maps every trust boundary to at least one rule, and every rule to known boundaries", () => {
    expect(boundaryIds.length).toBeGreaterThan(0);
    const used = new Set(rules.flatMap((r) => r.boundaries));
    for (const tb of boundaryIds) expect(used, `${tb} has no rule`).toContain(tb);
    for (const tb of used) expect(boundaryIds, `unknown boundary ${tb}`).toContain(tb);
  });

  it("gives every rule at least one test or evidence item, and cites only known rules", () => {
    const known = new Set(rules.map((r) => r.id));
    const covered = new Set(checks.flatMap((c) => c.rules));
    for (const { id } of rules) expect(covered, `${id} has no check`).toContain(id);
    for (const id of covered) expect(known, `unknown rule ${id}`).toContain(id);
  });

  it("uses the status vocabulary and names an invariant and owner on every row", () => {
    for (const c of checks) {
      const at = `${c.rules.join(",")} ${c.where}`;
      expect(STATUSES, at).toContain(c.status);
      expect(c.where, at).toMatch(WHERE);
      expect(c.invariant.length, at).toBeGreaterThan(10);
      expect(c.owner, at).toMatch(OWNER);
    }
  });

  it("claims passing or recorded only for files (and test titles) that exist", () => {
    for (const c of checks.filter((c) => c.status === "passing" || c.status === "recorded")) {
      const [, file = "", title] = WHERE.exec(c.where) ?? [];
      const full = path.join(repoRoot, file);
      expect(existsSync(full), `${c.status} row points at missing ${file}`).toBe(true);
      if (title !== undefined) {
        expect(readFileSync(full, "utf8"), `no test titled "${title}" in ${file}`).toContain(`"${title}"`);
      }
    }
  });

  it("keeps the CAS race and the deploy/comment race as separate named simulation tests", () => {
    const sim = (name: string) =>
      checks.filter((c) => c.layer === "simulation" && c.where.includes(`/${name}.sim.test.ts`));
    const cas = sim("sim-ingest-cas-race");
    const deploy = sim("sim-deploy-comment-race");
    expect(cas.flatMap((c) => c.rules)).toContain("R4.5-03");
    expect(deploy.flatMap((c) => c.rules)).toEqual(expect.arrayContaining(["R4.5-06", "R4.6-09"]));
    expect(cas.some((c) => deploy.some((d) => d.where === c.where))).toBe(false);
  });

  it("keeps every simulation row at a registered stable-ID path and requires real titles for harness evidence", () => {
    for (const c of checks.filter((c) => c.layer === "simulation")) {
      const [, file = "", title] = WHERE.exec(c.where) ?? [];
      if (file.endsWith(".sim.test.ts")) {
        const id = path.basename(file, ".sim.test.ts");
        expect(scenarios.map((s) => s.id)).toContain(id);
        expect(file).toBe(`tools/simulation/scenarios/${id}.sim.test.ts`);
        expect(c.status).toBe("planned"); // Product adapters are absent in M2.4.
      } else {
        expect(c.status).toBe("passing");
        expect(title).toBeDefined();
        expect(readFileSync(path.join(repoRoot, file), "utf8")).toContain(`it("${title ?? ""}"`);
      }
    }
  });
});

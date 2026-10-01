// One unit's run@1 result (02 §4, ADR 0003, ADR comparator-v1 §Side states). Side states decide
// first, in precedence order missing > failed > incomparable > added/removed, and pixels are
// compared only when both sides are captured. A threshold can't turn missing or failed work into
// unchanged, because a comparison is refused for any unit the side states decide (R4.3-12).
import { type Reason, type RunResult, type Side, checkResult } from "@pixelwatch/schemas";
import type { Comparison } from "./compare.ts";

export interface UnitIdentity {
  readonly providerId: string;
  readonly viewId: string;
  readonly variantId: string;
}

export type SideStatus = "missing" | "failed" | "incomparable" | "added" | "removed";

/**
 * The result the side states force, or undefined when both sides are captured and pixels decide.
 * Reasons are in the schema's enum order. Throws for a pair that isn't a unit.
 */
export function sideResult(base: Side, head: Side): { status: SideStatus; reasons: Reason[] } | undefined {
  if (head.state === "none") throw new Error("the head side can't be none; only the base can lack a baseline");
  if (base.state === "absent" && head.state === "absent") throw new Error("both sides absent is not a unit");
  if (base.state === "none" && head.state === "absent") throw new Error("an absent head with no baseline is not a unit");
  const sides = [base, head];
  const noBaseline: Reason[] = base.state === "none" ? ["no-baseline"] : [];
  if (sides.some((s) => s.state === "missing")) {
    const causes = (["part-missing", "unit-missing"] as const).filter((cause) => sides.some((s) => s.state === "missing" && s.cause === cause));
    return { status: "missing", reasons: [...causes, ...noBaseline] };
  }
  if (sides.some((s) => s.state === "failed")) return { status: "failed", reasons: ["capture-failed", ...noBaseline] };
  if (base.state === "none") return { status: "incomparable", reasons: ["no-baseline"] };
  if (base.state === "absent") return { status: "added", reasons: [] };
  if (head.state === "absent") return { status: "removed", reasons: [] };
  return undefined;
}

/**
 * Builds the result. `comparison` (from compareImages on the two sides' pixels) is required when
 * both sides are captured and refused otherwise. The result is checked against the run@1 result
 * rules, so a comparison that contradicts the pixel hashes throws instead of being stored.
 */
export function unitResult(identity: UnitIdentity, base: Side, head: Side, comparison?: Comparison): RunResult {
  const { providerId, viewId, variantId } = identity;
  const decided = sideResult(base, head);
  let result: RunResult;
  if (decided !== undefined) {
    if (comparison !== undefined) throw new Error(`a pixel comparison needs both sides captured; ${base.state}/${head.state} is decided by side states`);
    result = { providerId, viewId, variantId, status: decided.status, reasons: decided.reasons, base, head };
  } else {
    if (comparison === undefined) throw new Error("a unit with two captured sides needs a pixel comparison");
    if (base.state === "captured" && head.state === "captured") {
      const expectedTotal = base.width === head.width ? base.width * Math.max(base.height, head.height) : undefined;
      if (comparison.diff?.totalPixels !== expectedTotal) throw new Error("the comparison doesn't match the sides' dimensions");
    }
    const { status, reasons, diff } = comparison;
    result = { providerId, viewId, variantId, status, reasons: [...reasons], ...(diff === undefined ? {} : { diff }), base, head };
  }
  const issue = checkResult(result, "");
  if (issue !== undefined) throw new Error(`inconsistent result: ${issue.message}`);
  return result;
}

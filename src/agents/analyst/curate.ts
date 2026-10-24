import type { Risk, RiskMap } from "../../crew/contracts.ts";

// What the model proposes, code checks. Scoring and grounding are deterministic,
// so the same risk map always gets the same scores and the same warnings.

export function scoreRisk(impact: number, likelihood: number): { score: number; level: "high" | "medium" | "low" } {
  const score = impact * likelihood;
  return { score, level: score >= 15 ? "high" : score >= 8 ? "medium" : "low" };
}

/**
 * Score every risk, flag the ones that cite requirements that do not exist,
 * mark them as proposed for human review, and sort the most serious first.
 */
export function curateRiskMap(map: RiskMap, knownRequirementIds: Iterable<string>): RiskMap {
  const known = new Set(knownRequirementIds);

  const risks: Risk[] = map.risks.map((risk) => {
    const warnings: string[] = [];
    const unknown = risk.requirementIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      warnings.push(`Cites requirements that do not exist: ${unknown.join(", ")}. Check before accepting.`);
    }
    if (risk.requirementIds.length === 0) {
      warnings.push("Not linked to any requirement: is a requirement missing?");
    }
    return {
      ...risk,
      ...scoreRisk(risk.impact, risk.likelihood),
      status: risk.status ?? "proposed",
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });

  risks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { ...map, risks };
}

/** The risks a human accepted (or, before review, every risk not rejected). */
export function risksForDesign(map: RiskMap, { requireReview = false } = {}): Risk[] {
  return map.risks.filter((r) => (requireReview ? r.status === "accepted" : r.status !== "rejected"));
}

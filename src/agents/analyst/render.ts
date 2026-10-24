import type { RiskMap } from "../../crew/contracts.ts";

// A risk map as Markdown: what a human reviews in a pull request or a chat.

const LEVEL_ICON = { high: "HIGH", medium: "MED", low: "LOW" } as const;

export function renderRiskMap(map: RiskMap): string {
  const lines = [`# Risk map: ${map.feature}`, "", map.summary, ""];

  lines.push("## Risks", "", "| | Risk | Impact × Likelihood | Requirements | Status |", "|---|---|---|---|---|");
  for (const r of map.risks) {
    const level = r.level ? LEVEL_ICON[r.level] : "";
    lines.push(
      `| ${level} | **${r.id}** ${r.title} | ${r.impact} × ${r.likelihood} = ${r.score ?? r.impact * r.likelihood} | ${r.requirementIds.join(", ") || "—"} | ${r.status ?? "proposed"} |`,
    );
  }

  lines.push("", "## Why", "");
  for (const r of map.risks) {
    lines.push(`**${r.id}. ${r.title}** ${r.rationale}`);
    for (const e of r.evidence) lines.push(`- Evidence: ${e}`);
    for (const w of r.warnings ?? []) lines.push(`- ⚠ ${w}`);
    lines.push("");
  }

  if (map.questions.length > 0) {
    lines.push("## Open questions", "");
    for (const q of map.questions) lines.push(`- ${q.requirementId ? `[${q.requirementId}] ` : ""}${q.question} — ${q.whyItMatters}`);
    lines.push("");
  }

  if (map.missingRequirements.length > 0) {
    lines.push("## Possibly missing requirements", "");
    for (const m of map.missingRequirements) lines.push(`- **${m.title}** — ${m.why}`);
    lines.push("");
  }

  lines.push(
    "## How to review",
    "",
    'Edit the JSON file next to this one: adjust `impact` and `likelihood` where you disagree, and set `"status"` to `"accepted"` or `"rejected"` for each risk. The Designer only works on risks that are not rejected.',
    "",
  );
  return lines.join("\n");
}

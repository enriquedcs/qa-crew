import type { ExecutionReport, Risk, RiskMap, TestCase, TestPlan, TriageItem } from "../crew/contracts.ts";
import type { CalibrationReport } from "../agents/reviewer/calibration.ts";
import { Store } from "../app/store.ts";
import {
  ANALYST_MUST_FIND,
  CAPACITY_LEVEL,
  EXECUTOR_TRUTH,
  RISK_COUNT,
  TODAY_QUESTION,
  TRIAGE_TRUTH,
  type MustFind,
} from "./golden.ts";

// Chapter 12: scorers. Each one turns an agent's output into checks that pass or fail.
// They are plain code: no model grades another model here. A check a script can decide
// is cheaper, faster and more stable than any judge, so we use code wherever we can.

export interface Check {
  name: string;
  passed: boolean;
  /** What the scorer saw, for the human reading the scorecard. */
  detail?: string;
}

const cites = (ids: string[], requirement: string) => ids.some((id) => id.endsWith(`:${requirement}`) || id === requirement);

// ---------------------------------------------------------------------------
// Analyst: did it find what matters, without inventing anything?
// ---------------------------------------------------------------------------

export function matchRisk(risks: Risk[], target: MustFind): Risk | undefined {
  return risks.find((r) => cites(r.requirementIds, target.requirement) && target.title.test(r.title));
}

export function scoreRiskMap(map: RiskMap | undefined): Check[] {
  if (!map) return [{ name: "Submitted a risk map", passed: false }];
  const checks: Check[] = ANALYST_MUST_FIND.map((target) => {
    const found = matchRisk(map.risks, target);
    return { name: `Finds: ${target.name}`, passed: !!found, detail: found ? `${found.id} ${found.title}` : "not found" };
  });

  const capacity = matchRisk(map.risks, ANALYST_MUST_FIND[0]);
  checks.push({
    name: `Rates capacity ${CAPACITY_LEVEL}`,
    passed: capacity?.level === CAPACITY_LEVEL,
    detail: capacity ? `${capacity.id} scored ${capacity.score} (${capacity.level})` : "no capacity risk",
  });

  const today = map.questions.find((q) => TODAY_QUESTION.test(q.question) || (q.requirementId ?? "").endsWith("FR-007"));
  checks.push({ name: "Asks whose 'today' counts (FR-007)", passed: !!today, detail: today?.question ?? "no question about FR-007" });

  const invented = map.risks.filter((r) => (r.warnings ?? []).some((w) => w.includes("do not exist")));
  checks.push({
    name: "Cites only requirements that exist",
    passed: invented.length === 0,
    detail: invented.length ? invented.map((r) => `${r.id}: ${r.requirementIds.join(", ")}`).join("; ") : "all grounded",
  });

  const n = map.risks.length;
  checks.push({ name: `Stays focused (${RISK_COUNT.min}-${RISK_COUNT.max} risks)`, passed: n >= RISK_COUNT.min && n <= RISK_COUNT.max, detail: `${n} risks` });
  return checks;
}

// ---------------------------------------------------------------------------
// Designer: does the plan cover the risks with sharp, honest oracles?
// ---------------------------------------------------------------------------

const ACCEPTS = /\b20[01]\b|\baccepted\b|\bconfirmed\b|\bsucceeds\b|\ballowed\b/i;
const REJECTS = /\b4\d\d\b|\brejected\b|\brefused\b/i;
const STATUS_OR_MESSAGE = /\b[1-5]\d\d\b|'[^']{3,}'|"[^"]{3,}"/;

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && !isNaN(Number(value)) ? Number(value) : undefined;
}

/** The two sides of the capacity boundary: a room filled exactly, and one guest too many. */
export function capacityBoundary(cases: TestCase[]): { passed: boolean; detail: string } {
  const store = new Store();
  const capacityCases = cases.filter((c) => cites(c.requirementIds, "FR-005"));
  const sides = capacityCases.map((c) => {
    const roomId = String(c.data.roomId ?? "");
    const capacity = store.getRoom(roomId)?.capacity;
    const guests = num(c.data.guests);
    const expectsReject = REJECTS.test(c.expected);
    const expectsAccept = !expectsReject && ACCEPTS.test(c.expected);
    return { id: c.id, at: capacity !== undefined && guests === capacity && expectsAccept, over: capacity !== undefined && guests === capacity + 1 && expectsReject };
  });
  const at = sides.find((s) => s.at);
  const over = sides.find((s) => s.over);
  return {
    passed: !!at && !!over,
    detail: `at capacity, accepted: ${at?.id ?? "missing"}; one over, rejected: ${over?.id ?? "missing"}`,
  };
}

/**
 * Scores the Designer twice over: `raw` is what the model proposed, `curated` is what code kept.
 * Curation hides some mistakes from the human. The eval must not: it measures the agent.
 */
export function scoreTestPlan(raw: TestPlan | undefined, curated: TestPlan | undefined, risks: Risk[]): Check[] {
  if (!raw || !curated) return [{ name: "Submitted a test plan", passed: false }];
  const checks: Check[] = [];

  const covered = new Set(curated.cases.flatMap((c) => c.riskIds));
  const uncovered = risks.filter((r) => !covered.has(r.id));
  checks.push({ name: "Covers every accepted risk", passed: uncovered.length === 0, detail: uncovered.length ? `no test for ${uncovered.map((r) => r.id).join(", ")}` : `${risks.length} of ${risks.length}` });

  const boundary = capacityBoundary(raw.cases);
  checks.push({ name: "Tests both sides of the capacity boundary", ...boundary });

  const backToBack = raw.cases.find((c) => cites(c.requirementIds, "FR-009") && ACCEPTS.test(c.expected) && !REJECTS.test(c.expected));
  checks.push({ name: "Expects a back-to-back stay to succeed (FR-009)", passed: !!backToBack, detail: backToBack ? backToBack.id : "missing" });

  const todayCases = raw.cases.filter((c) => cites(c.requirementIds, "FR-007") && (num(c.data.checkInDays) === 0 || /\btoday\b/i.test(c.title)));
  const unblocked = todayCases.filter((c) => !c.blockedBy);
  checks.push({
    name: "Holds the 'today' case until FR-007 is clarified",
    passed: unblocked.length === 0,
    detail: todayCases.length === 0 ? "no case on today itself" : unblocked.length ? `${unblocked.map((c) => c.id).join(", ")} has an oracle nobody agreed on` : "blocked by the open question",
  });

  const vague = raw.cases.filter((c) => !c.blockedBy && !STATUS_OR_MESSAGE.test(c.expected));
  checks.push({ name: "Every oracle names a status or a message", passed: vague.length === 0, detail: vague.length ? vague.map((c) => `${c.id}: "${c.expected}"`).join("; ") : "all specific" });

  const known = new Set(risks.map((r) => r.id));
  const orphans = raw.cases.filter((c) => !c.riskIds.some((id) => known.has(id)));
  checks.push({ name: "Every case traces to an accepted risk", passed: orphans.length === 0, detail: orphans.length ? orphans.map((c) => `${c.id} -> ${c.riskIds.join(", ") || "none"}`).join("; ") : "all traced" });

  const duplicates = (curated.dropped ?? []).filter((d) => d.reason.startsWith("duplicate"));
  checks.push({ name: "Proposes no duplicate cases", passed: duplicates.length === 0, detail: duplicates.length ? duplicates.map((d) => `${d.id} ${d.reason}`).join("; ") : "none" });

  return checks;
}

// ---------------------------------------------------------------------------
// Executor: does each case end the way the app really behaves?
// ---------------------------------------------------------------------------

export function scoreExecution(reports: ExecutionReport[]): Check[] {
  return Object.entries(EXECUTOR_TRUTH).map(([caseId, truth]) => {
    const report = reports.find((r) => r.caseId === caseId);
    if (!report) return { name: `${caseId} ends ${truth.outcome}`, passed: false, detail: "no report" };
    const right = report.outcome === truth.outcome && report.verified !== false;
    const detail = right
      ? `${report.outcome}, verified by a re-run`
      : report.outcome !== truth.outcome
        ? `${report.outcome}: a miss. ${truth.why}.`
        : `${report.outcome}, but the re-run disagreed`;
    return { name: `${caseId} ends ${truth.outcome}`, passed: right, detail };
  });
}

// ---------------------------------------------------------------------------
// Triager: the right classification, linked to what the team already knows
// ---------------------------------------------------------------------------

export function scoreTriage(items: TriageItem[]): Check[] {
  const checks: Check[] = [];
  for (const truth of TRIAGE_TRUTH) {
    const name = truth.file.split("/").pop()!.replace(".spec.ts", "");
    const item = items.find((i) => i.file === truth.file);
    checks.push({
      name: `${name} classified as ${truth.classification}`,
      passed: item?.classification === truth.classification,
      detail: item ? `${item.classification} (${item.confidence})${item.warnings?.length ? `, ${item.warnings.length} guard warning(s)` : ""}` : "not triaged",
    });
    if (truth.duplicateOf) {
      checks.push({
        name: `${name} is linked to ${truth.duplicateOf}, not filed again`,
        passed: item?.duplicateOf === truth.duplicateOf && !item?.bugReport,
        detail: item?.duplicateOf ? `duplicate of ${item.duplicateOf}${item.bugReport ? ", but also drafted a new report" : ""}` : "no duplicate found",
      });
    }
    if (truth.cites) {
      const report = item?.bugReport;
      checks.push({
        name: `${name}'s bug report cites ${truth.cites}`,
        passed: !!report && cites(report.requirementIds, truth.cites),
        detail: report ? `cites ${report.requirementIds.join(", ") || "nothing"}` : "no bug report",
      });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Reviewer: the calibration set from Chapter 10, one check per sample
// ---------------------------------------------------------------------------

export function scoreCalibration(report: CalibrationReport): Check[] {
  return report.results.map((r) => ({
    name: r.defect ? `Catches: ${r.sample}` : `Approves: ${r.sample}`,
    passed: r.correct,
    detail: `${r.verdict ?? "no review"}${r.findings.length ? `; ${r.findings.join(", ")}` : ""}`,
  }));
}

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { curateRiskMap, risksForDesign } from "../../src/agents/analyst/curate.ts";
import { scriptedAnalyst } from "../../src/agents/analyst/demo.ts";
import { curateTestPlan } from "../../src/agents/designer/curate.ts";
import { scriptedDesigner } from "../../src/agents/designer/demo.ts";
import type { ExecutionReport, RiskMap, TestCase, TestPlan, TriageItem } from "../../src/crew/contracts.ts";
import type { MockTurn } from "../../src/llm/index.ts";
import { regressions, renderComparison, renderScorecard, summarize, unstable, type Scorecard, type Trial } from "../../src/evals/scorecard.ts";
import { capacityBoundary, scoreExecution, scoreRiskMap, scoreTestPlan, scoreTriage } from "../../src/evals/scorers.ts";

const submitted = <T>(turns: MockTurn[]): T => {
  const last = turns.at(-1);
  return (typeof last === "object" ? last.toolCalls![0].input : undefined) as T;
};
const KNOWN = Array.from({ length: 10 }, (_, i) => `booking-rules:FR-${String(i + 1).padStart(3, "0")}`);
const scriptedMap = () => curateRiskMap(submitted<RiskMap>(scriptedAnalyst()), KNOWN);
const fixtureRisks = () => risksForDesign(JSON.parse(readFileSync("src/evals/fixtures/risk-map.json", "utf8")) as RiskMap);
const failed = (checks: { name: string; passed: boolean }[]) => checks.filter((c) => !c.passed).map((c) => c.name);

test.describe("Analyst scorer", () => {
  test("the scripted risk map finds every must-find risk but cites an invented requirement", () => {
    expect(failed(scoreRiskMap(scriptedMap()))).toEqual(["Cites only requirements that exist"]);
  });

  test("a risk map without the capacity risk misses it and cannot rate it", () => {
    const map = scriptedMap();
    const checks = scoreRiskMap({ ...map, risks: map.risks.filter((r) => r.id !== "R1") });
    expect(failed(checks)).toEqual(expect.arrayContaining(["Finds: The API ignores room capacity", "Rates capacity high"]));
  });

  test("a time-zone risk on FR-007 is not the past check-in risk: same requirement, different problem", () => {
    const map = scriptedMap();
    const risks = map.risks.map((r) => (r.id === "R2" ? { ...r, title: "Whose 'today' counts is undefined" } : r));
    expect(failed(scoreRiskMap({ ...map, risks }))).toContain("Finds: Stays that start in the past");
  });

  test("capacity rated medium fails the rating check", () => {
    const map = scriptedMap();
    const risks = map.risks.map((r) => (r.id === "R1" ? { ...r, score: 8, level: "medium" as const } : r));
    expect(failed(scoreRiskMap({ ...map, risks }))).toContain("Rates capacity high");
  });

  test("no risk map is one failed check, not a crash", () => {
    expect(scoreRiskMap(undefined)).toEqual([{ name: "Submitted a risk map", passed: false }]);
  });
});

test.describe("Designer scorer", () => {
  const raw = () => submitted<TestPlan>(scriptedDesigner());

  test("scores the raw proposal, so curation does not hide the planted mistakes", () => {
    const risks = fixtureRisks();
    const plan = raw();
    expect(failed(scoreTestPlan(plan, curateTestPlan(plan, risks), risks))).toEqual([
      "Holds the 'today' case until FR-007 is clarified",
      "Every case traces to an accepted risk",
      "Proposes no duplicate cases",
    ]);
  });

  test("a 'today' case blocked by the open question passes", () => {
    const risks = fixtureRisks();
    const plan = raw();
    plan.cases = plan.cases.map((c) => (c.id === "TC-06" ? { ...c, blockedBy: "Whose 'today' counts?" } : c));
    expect(failed(scoreTestPlan(plan, curateTestPlan(plan, risks), risks))).not.toContain("Holds the 'today' case until FR-007 is clarified");
  });

  test("the capacity boundary needs the room filled exactly AND one guest too many", () => {
    const tc = (id: string, roomId: string, guests: number, expected: string) =>
      ({ id, requirementIds: ["booking-rules:FR-005"], data: { roomId, guests }, expected }) as unknown as TestCase;
    expect(capacityBoundary([tc("A", "r3", 4, "201 Created"), tc("B", "r3", 5, "400 Bad Request")]).passed).toBe(true);
    // Both sides on the wrong side of the line: r2 fits 2, not 3.
    expect(capacityBoundary([tc("A", "r2", 3, "201 Created"), tc("B", "r2", 4, "400")]).passed).toBe(false);
    expect(capacityBoundary([tc("B", "r2", 3, "400 Bad Request")]).detail).toContain("at capacity, accepted: missing");
  });
});

test.describe("Executor scorer", () => {
  const report = (caseId: string, outcome: ExecutionReport["outcome"], verified = true): ExecutionReport => ({ caseId, file: "", outcome, attempts: 1, evidence: "", notes: "", verified });

  test("a green test for a red rule is a miss", () => {
    const checks = scoreExecution([report("TC-02", "failing-suspected-product-bug"), report("TC-05", "passed"), report("TC-08", "passed")]);
    expect(failed(checks)).toEqual(["TC-05 ends failing-suspected-product-bug"]);
    expect(checks[1].detail).toContain("FR-007");
  });

  test("the right outcome that a re-run contradicts does not count", () => {
    expect(scoreExecution([report("TC-08", "passed", false)]).find((c) => c.name.startsWith("TC-08"))?.passed).toBe(false);
  });
});

test.describe("Triager scorer", () => {
  const item = (file: string, over: Partial<TriageItem>): TriageItem => ({ file: `tests/triage-demo/${file}.spec.ts`, title: file, classification: "product-bug", confidence: "high", rationale: "", evidence: ["e"], ...over });
  const bug = { title: "t", severity: "high" as const, summary: "", stepsToReproduce: ["s"], expected: "", actual: "", requirementIds: ["booking-rules:FR-007"], suspectedArea: "" };

  test("the right answers pass every check", () => {
    const items = [
      item("past-checkin", { bugReport: bug }),
      item("capacity", { duplicateOf: "ISSUE-0031" }),
      item("book-from-form", { classification: "test-bug" }),
      item("new-booking-row", { classification: "flaky" }),
    ];
    expect(failed(scoreTriage(items))).toEqual([]);
  });

  test("a known issue filed again fails, even when the classification is right", () => {
    const checks = scoreTriage([item("capacity", { duplicateOf: "ISSUE-0031", bugReport: { ...bug, requirementIds: ["booking-rules:FR-005"] } })]);
    expect(failed(checks)).toContain("capacity is linked to ISSUE-0031, not filed again");
    expect(failed(checks)).not.toContain("capacity classified as product-bug");
  });
});

test.describe("scorecard", () => {
  const trial = (passed: boolean[]): Trial => ({
    score: passed.filter(Boolean).length / passed.length,
    checks: passed.map((p, i) => ({ name: `check ${i + 1}`, passed: p })),
    usage: { inputTokens: 1000, outputTokens: 100 },
    steps: 3,
    seconds: 2,
  });

  test("summarizes the mean, the range, the spread and which checks are unstable", () => {
    const s = summarize("analyst", "mock / scripted", [trial([true, true]), trial([true, false]), trial([true, true])]);
    expect(s.mean).toBeCloseTo(5 / 6);
    expect([s.min, s.max]).toEqual([0.5, 1]);
    expect(s.spread).toBeGreaterThan(0);
    expect(s.checks.filter(unstable).map((c) => c.name)).toEqual(["check 2"]);
    expect(renderScorecard({ label: "x", createdAt: "now", trials: 3, suites: [s] })).toContain("| check 2 | ~ 2/3 |");
  });

  test("identical trials have no spread", () => {
    expect(summarize("a", "m", [trial([true, false]), trial([true, false])]).spread).toBe(0);
  });

  test("a comparison lists only the checks that differ", () => {
    const card = (label: string, t: Trial): Scorecard => ({ label, createdAt: "now", trials: 1, suites: [summarize("analyst", label, [t])] });
    const text = renderComparison(card("a", trial([true, true])), card("b", trial([true, false])));
    expect(text).toContain("analyst · check 2: a 1/1, b 0/1");
    expect(text).not.toContain("check 1:");
  });

  test("a regression: the mean dropped too far, or a check that always passed now fails", () => {
    const card = (trials: Trial[]): Scorecard => ({ label: "x", createdAt: "now", trials: trials.length, suites: [summarize("analyst", "m", trials)] });
    const before = card([trial([true, true, true, true]), trial([true, true, true, false])]);
    expect(regressions(before, before)).toEqual([]);

    // One trial loses check 1, which always passed: a regression, even though the mean moves little.
    const wobble = card([trial([true, true, true, true]), trial([false, true, true, false])]);
    expect(regressions(before, wobble, 0.2)).toEqual(["analyst · check 1: always passed before, now 1/2"]);

    // check 4 was already unstable: losing it is not a new regression, but the mean drop is.
    const worse = card([trial([true, true, true, false]), trial([true, true, true, false])]);
    expect(regressions(before, worse, 0)).toEqual(["analyst: mean 88% -> 75% (tolerance 0%)"]);
    expect(regressions(before, worse, 0.2)).toEqual([]);
  });
});

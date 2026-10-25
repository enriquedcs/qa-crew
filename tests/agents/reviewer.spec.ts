import { expect, test } from "@playwright/test";
import { CALIBRATION_SET, calibrate } from "../../src/agents/reviewer/calibration.ts";
import { assertedStatuses, expectedStatuses, preReview } from "../../src/agents/reviewer/checks.ts";
import { applyReviewGuards, numbered, revisionRequest, runReviewer } from "../../src/agents/reviewer/reviewer.ts";
import { runExecutor } from "../../src/agents/executor/executor.ts";
import type { Review, TestCase } from "../../src/crew/contracts.ts";
import { createMockClient } from "../../src/llm/index.ts";

const sample = (name: string) => CALIBRATION_SET.find((s) => s.name.startsWith(name))!;
const review = (over: Partial<Review>): Review => ({ caseId: "TC-05", file: "tc-05.spec.ts", verdict: "approve", summary: "s", findings: [], ...over });

test.describe("code checks before the Reviewer", () => {
  test("read statuses from the case and from the test", () => {
    expect(expectedStatuses("First DELETE 204, second DELETE 404")).toEqual([204, 404]);
    expect(assertedStatuses("expect(res.status()).toBe(400);\nexpect(a.status()).toBe( 201 )")).toEqual([400, 201]);
  });

  test("a clean test has no facts and no suspicions", () => {
    const s = sample("clean: capacity");
    expect(preReview(s.testCase, s.source)).toEqual({ facts: [], suspicions: [] });
  });

  test("asserting a different status than the case expects is a weakened oracle", () => {
    const s = sample("weakened oracle");
    const { facts } = preReview(s.testCase, s.source);
    expect(facts[0]).toMatchObject({ check: "no-weakening", severity: "blocker", source: "code" });
    expect(facts[0].problem).toContain("expects 400, but the test asserts 201");
  });

  test("a quoted message and stored state must be checked", () => {
    expect(preReview(sample("incomplete oracle: the quoted").testCase, sample("incomplete oracle: the quoted").source).facts[0].problem).toContain("room is already booked");
    expect(preReview(sample("incomplete oracle: status only").testCase, sample("incomplete oracle: status only").source).facts[0].check).toBe("oracle-complete");
  });

  test("two bookings in one room, when a rejection is expected, is a suspicion, not a fact", () => {
    const s = sample("wrong reason");
    const { facts, suspicions } = preReview(s.testCase, s.source);
    expect(facts).toEqual([]);
    expect(suspicions[0]).toMatchObject({ check: "right-reason", line: 4 });
  });

  test("no suspicion when the case is about the overlap rule itself", () => {
    const s = sample("incomplete oracle: the quoted");
    expect(preReview(s.testCase, s.source).suspicions).toEqual([]);
  });

  test("missing tags are a minor traceability fact", () => {
    const s = sample("clean: capacity");
    const { facts } = preReview(s.testCase, s.source.replace('"@booking-rules:FR-005"', ""));
    expect(facts).toEqual([expect.objectContaining({ check: "traceable", severity: "minor" })]);
  });
});

test.describe("guards on the Reviewer's verdict", () => {
  const wrongReason = sample("wrong reason");
  const code = preReview(wrongReason.testCase, wrongReason.source);

  test("a code fact cannot be approved away", () => {
    const weak = sample("weakened oracle");
    const out = applyReviewGuards(review({ verdict: "approve" }), preReview(weak.testCase, weak.source), weak.source);
    expect(out.verdict).toBe("request-changes");
    expect(out.findings.map((f) => f.check)).toContain("no-weakening");
  });

  test("dismissing a suspicion is allowed, and flagged for a human", () => {
    const out = applyReviewGuards(review({ verdict: "approve" }), code, wrongReason.source);
    expect(out.verdict).toBe("approve");
    expect(out.warnings?.[0]).toContain("code suspicion (right-reason)");
  });

  test("a finding that confirms a code suspicion says so, and makes the verdict stricter", () => {
    const out = applyReviewGuards(
      review({ verdict: "approve", findings: [{ check: "right-reason", severity: "major", line: 6, problem: "overlap", suggestion: "isolate" }] }),
      code,
      wrongReason.source,
    );
    expect(out.verdict).toBe("request-changes");
    expect(out.findings[0].source).toBe("code and reviewer");
  });

  test("unknown checks are dropped and impossible line numbers removed", () => {
    const out = applyReviewGuards(
      review({ verdict: "request-changes", findings: [{ check: "vibes" as never, severity: "major", problem: "p", suggestion: "s" }, { check: "isolated", severity: "major", line: 999, problem: "p", suggestion: "s" }] }),
      { facts: [], suspicions: [] },
      wrongReason.source,
    );
    expect(out.findings).toEqual([expect.objectContaining({ check: "isolated", line: undefined })]);
    expect(out.warnings?.[0]).toContain('unknown check "vibes"');
  });

  test("requesting changes without a finding gives the Executor nothing to act on", () => {
    const out = applyReviewGuards(review({ verdict: "request-changes" }), { facts: [], suspicions: [] }, "x");
    expect(out.warnings?.[0]).toContain("without a single finding");
  });
});

test("the Reviewer sees numbered source, code facts and suspicions, never the Executor's reasoning", async () => {
  const s = sample("wrong reason");
  const model = createMockClient([{ toolCalls: [{ name: "submit_result", input: { verdict: "request-changes", summary: "Overlap.", findings: [{ check: "right-reason", severity: "major", line: 6, problem: "p", suggestion: "s" }] } }] }]);
  const { review: out } = await runReviewer({ model, tools: [], testCase: s.testCase, source: s.source });
  const task = model.requests[0].messages[0];
  const text = task.role === "user" ? task.content : "";
  expect(text).toContain(numbered(s.source.trimEnd()).split("\n")[5]);
  expect(text).toContain("Suspicions from code checks");
  expect(text).toContain("right-reason (line 4)");
  expect(out?.verdict).toBe("request-changes");
});

test("a review's findings reach the Executor as a revision request", async () => {
  const request = revisionRequest(review({ verdict: "request-changes", summary: "Overlap.", findings: [{ check: "right-reason", severity: "major", line: 6, problem: "Two stays in r2.", suggestion: "Isolate it." }] }));
  expect(request).toContain("[major] right-reason (line 6): Two stays in r2. Suggestion: Isolate it.");
  expect(request).toContain("Keep the case's expected result exactly as it is");

  const testCase: TestCase = { ...sample("wrong reason").testCase };
  const model = createMockClient([{ toolCalls: [{ name: "submit_result", input: { caseId: "TC-05", file: "", outcome: "blocked", attempts: 1, evidence: "", notes: "n" } }] }]);
  await runExecutor({ model, tools: [], testCase, revision: request, verify: false });
  const task = model.requests[0].messages[0];
  expect(task.role === "user" ? task.content : "").toContain("A reviewer read your test");
});

test("calibration: a rubber stamp catches only what code checks catch, and raises no false alarms", async () => {
  const model = createMockClient(CALIBRATION_SET.map(() => ({ toolCalls: [{ name: "submit_result", input: { verdict: "approve", summary: "Looks good.", findings: [] } }] })));
  const report = await calibrate(model);
  expect(report.defective).toBe(7);
  expect(report.caught).toBe(report.byCodeAlone);
  expect(report.caught).toBe(3);
  expect(report.falseAlarms).toBe(0);
  const missed = report.results.filter((r) => r.defect && !r.correct).map((r) => r.defect);
  expect(missed).toEqual(["right-reason", "setup-verified", "data-matches-case", "isolated"]);
});

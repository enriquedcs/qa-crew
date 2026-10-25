import { runAgent, type AgentEvent, type AgentResult, type Tool } from "../../agent/runAgent.ts";
import { REVIEW_CHECKS, reviewSchema, type ExecutionReport, type Review, type ReviewFinding, type TestCase } from "../../crew/contracts.ts";
import type { ModelClient } from "../../llm/types.ts";
import { preReview, type PreReview } from "./checks.ts";

// The Reviewer: a second agent that reads a generated test against its test case and asks one
// question about every assertion: can this pass for any other reason?
// It sees the artifacts, not the Executor's reasoning, so it does not inherit its blind spots.
// It never edits the test. Its findings go back to the Executor, and disagreements go to a human.

const RUBRIC = Object.entries(REVIEW_CHECKS)
  .map(([id, text]) => `- ${id}: ${text}`)
  .join("\n");

export const REVIEWER_SYSTEM = `You are the Reviewer on a QA team. Another agent wrote a Playwright test for a test case.
You decide whether the test can be trusted: whether it checks what the case says, for the reason the case says.
You did not write it, and you do not fix it. You review it.

You receive the test case, the test's source with line numbers, the result of running it, and the output
of code checks that ran before you: facts (certain from the text of the test) and suspicions (patterns that
are often wrong, and sometimes are not). You can read the team's test support code and the requirements.

Review against this rubric:
${RUBRIC}

The most important question, for every assertion: can it pass for any other reason?
- A rejection (400) is only evidence for the rule the case is about if no other rule could cause it.
  Two bookings in the same room on overlapping nights can be rejected by the overlap rule.
- A pass is only evidence if the setup the test depends on actually happened. An unchecked setup that
  silently fails can make the step under test succeed or fail for the wrong reason.
- A passing test that checks only the status, when the case also names a message or stored state, is incomplete.

Rules:
- Cite the line and the code for every finding. Be concrete.
- Severity: blocker = the test cannot be trusted as evidence; major = it can pass or fail for the wrong reason,
  or misses part of the oracle; minor = style or traceability.
- Every suggestion must keep what the case expects. Never suggest changing the expected status, message or state.
- Code facts stand: you cannot approve a test with one. Each code suspicion needs your decision: confirm it
  as a finding, or say in the summary why it does not apply to this test.
- A test that fails is not a problem by itself. A correct test that fails on the oracle is a finding about the
  application, and you approve it.
- Approve only when there is no blocker and no major finding. Otherwise request changes.
When you are done, call submit_result.`;

/** The test's source with line numbers, so findings can cite them. */
export function numbered(source: string): string {
  return source
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(3)} | ${l}`)
    .join("\n");
}

export function reviewBrief(testCase: TestCase, source: string, report: ExecutionReport | undefined, code: PreReview): string {
  const result = report
    ? `Result: ${report.outcome}${report.verified === false ? " (not confirmed by the re-run)" : ""}. ${report.evidence}`.trim()
    : "Result: not run.";
  const list = (items: ReviewFinding[]) =>
    items.length ? items.map((f) => `- [${f.severity}] ${f.check}${f.line ? ` (line ${f.line})` : ""}: ${f.problem}`).join("\n") : "- none";
  return [
    `Test case:\n${JSON.stringify(testCase, null, 2)}`,
    `Test file: tests/generated/${report?.file ?? ""}`,
    "```typescript",
    numbered(source.trimEnd()),
    "```",
    result,
    `Facts from code checks:\n${list(code.facts)}`,
    `Suspicions from code checks, for you to confirm or dismiss:\n${list(code.suspicions)}`,
  ].join("\n\n");
}

/**
 * Code checks the Reviewer's verdict. A verdict can be stricter than the findings, never more lenient:
 * an approval with a blocker or major finding, or with a code fact, becomes a request for changes.
 */
export function applyReviewGuards(review: Review, code: PreReview, source: string): Review {
  const warnings: string[] = [];
  const lines = source.split("\n").length;

  // Findings must name a real check, and a real line.
  const findings: ReviewFinding[] = [];
  for (const f of review.findings) {
    if (!(f.check in REVIEW_CHECKS)) {
      warnings.push(`Dropped a finding with an unknown check "${f.check}".`);
      continue;
    }
    const confirms = [...code.facts, ...code.suspicions].some((c) => c.check === f.check);
    const source = confirms ? "code and reviewer" : (f.source ?? "reviewer");
    findings.push({ ...f, source, ...(f.line && (f.line < 1 || f.line > lines) ? { line: undefined } : {}) });
  }

  // Code facts the Reviewer did not mention stay in the review. Suspicions it did not confirm do not.
  for (const c of code.facts) {
    if (!findings.some((f) => f.check === c.check)) findings.push(c);
  }

  let verdict = review.verdict;
  const serious = findings.filter((f) => f.severity === "blocker" || f.severity === "major");
  if (verdict === "approve" && serious.length > 0) {
    warnings.push(`Approved with ${serious.length} serious finding(s); changed to request-changes.`);
    verdict = "request-changes";
  }
  const dismissed = code.suspicions.filter((c) => !review.findings.some((f) => f.check === c.check));
  if (verdict === "approve" && dismissed.length > 0) {
    warnings.push(`Approved despite a code suspicion (${dismissed.map((c) => c.check).join(", ")}): ${dismissed[0].problem} Check the Reviewer's reason in the summary.`);
  }
  if (verdict === "request-changes" && findings.length === 0) {
    warnings.push("Requested changes without a single finding: nothing for the Executor to act on.");
  }

  return { ...review, verdict, findings, ...(warnings.length ? { warnings: [...(review.warnings ?? []), ...warnings] } : {}) };
}

export interface ReviewerOptions {
  model: ModelClient;
  tools: Tool[];
  testCase: TestCase;
  source: string;
  report?: ExecutionReport;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export async function runReviewer(options: ReviewerOptions): Promise<{ review?: Review; run: AgentResult<Omit<Review, "caseId" | "file">> }> {
  const { model, tools, testCase, source, report, maxSteps = 8, onEvent } = options;
  const code = preReview(testCase, source);

  const run = await runAgent<Omit<Review, "caseId" | "file">>({
    model,
    system: REVIEWER_SYSTEM,
    task: `Review this generated test.\n\n${reviewBrief(testCase, source, report, code)}`,
    tools,
    output: { schema: reviewSchema, description: "Submit your review of this one test." },
    maxSteps,
    onEvent,
  });
  if (!run.output) return { run };
  const review: Review = { ...run.output, caseId: testCase.id, file: report?.file ?? "" };
  return { run, review: applyReviewGuards(review, code, source) };
}

/** What the Executor reads when a review asks for changes. */
export function revisionRequest(review: Review): string {
  return [
    `A reviewer read your test tests/generated/${review.file} and asked for changes:`,
    review.summary,
    ...review.findings
      .filter((f) => f.severity !== "minor" || review.findings.every((x) => x.severity === "minor"))
      .map((f) => `- [${f.severity}] ${f.check}${f.line ? ` (line ${f.line})` : ""}: ${f.problem} Suggestion: ${f.suggestion}`),
    "Change the test to address these findings. Keep the case's expected result exactly as it is.",
    "Run the test again, decide whether a failure is the test or the application, and submit a new report.",
  ].join("\n");
}

export function renderReviews(reviews: Review[]): string {
  const lines = ["# Reviews", "", "| Case | Round | Verdict | Findings |", "|---|---|---|---|"];
  for (const r of reviews) {
    const count = (s: ReviewFinding["severity"]) => r.findings.filter((f) => f.severity === s).length;
    lines.push(`| ${r.caseId} | ${r.round ?? 1} | ${r.verdict} | ${count("blocker")} blocker, ${count("major")} major, ${count("minor")} minor |`);
  }
  for (const r of reviews) {
    lines.push("", `## ${r.caseId}, round ${r.round ?? 1}: ${r.verdict}`, "", r.summary, "");
    for (const f of r.findings) lines.push(`- **${f.severity}** \`${f.check}\`${f.line ? ` line ${f.line}` : ""} (${f.source ?? "reviewer"}): ${f.problem} _Suggestion:_ ${f.suggestion}`);
    for (const w of r.warnings ?? []) lines.push(`- ⚠ ${w}`);
  }
  return lines.join("\n") + "\n";
}

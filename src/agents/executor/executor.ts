import { runAgent, type AgentEvent, type AgentResult, type Tool } from "../../agent/runAgent.ts";
import { executionReportSchema, type ExecutionReport, type TestCase } from "../../crew/contracts.ts";
import type { ModelClient } from "../../llm/types.ts";
import { runPlaywright, type RunSummary } from "../../runner/playwright.ts";

// The Executor: turns one test case into a Playwright test, runs it, and iterates
// until the test is right. "Right" means it checks the case's oracle, not that it is green.

export const EXECUTOR_SYSTEM = `You are the Executor on a QA team. You receive ONE test case and turn it into a
Playwright test in TypeScript that checks exactly what the case says.

How you work:
1. Read the team's test support code first: support/fixtures.ts (fixtures, BookingApi, BookingPage) and support/dates.ts.
   Read one existing test (for example spec/booking-rules.spec.ts) to copy its style.
2. Write the test with write_generated_test. Use one file per case, named after the case id, for example tc-02-capacity.spec.ts.
   - Import { test, expect } from "../support/fixtures.ts" and use the bookingApi and bookingPage fixtures.
   - Tag the test with the case id and its requirement ids: { tag: ["@TC-02", "@booking-rules:FR-005"] }.
   - Describe dates as offsets (checkInDays, checkOutDays). Never hard-code dates.
   - Locate UI elements by role and label, through BookingPage when possible.
   - Assert the full oracle: the status code, the message, and the state that must or must not change.
3. Run it with run_generated_test. Read the result carefully.
4. If the test fails, decide WHY before changing anything:
   - The test is wrong (bad setup, wrong field name, wrong locator, wrong import): fix the test and run again.
   - The test is right and the application does not do what the case expects: STOP. That is a finding, not a problem to fix.
   Make sure each request can only fail for the reason the case is about. When a test sends several requests,
   give each one its own room or dates that do not overlap, and for a rejection assert the error message as well
   as the status. A 400 for the wrong reason is a pass for the wrong reason.
5. Never weaken the oracle to make a test pass. Do not change the expected status, message or state,
   do not remove assertions, do not catch errors, do not skip the test. If the app is wrong, the test must stay red.

Finish with submit_result:
- "passed" when the test passes and asserts the full oracle.
- "failing-suspected-product-bug" when the test is correct and fails on the oracle. Put the failing assertion,
  with expected and received values, in evidence.
- "blocked" when you could not make the test run correctly within your attempts, or when the expected result
  depends on a decision nobody has made. Do not guess an answer to an open question. Explain what is missing.`;

export interface ExecutorOptions {
  model: ModelClient;
  tools: Tool[];
  testCase: TestCase;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
  /** Re-run the test independently and compare with the agent's claim. On by default. */
  verify?: boolean;
  /** A reviewer's request for changes to the test written earlier (Chapter 10). */
  revision?: string;
  runnerAppPort?: number;
}

export interface ExecutorResult {
  report?: ExecutionReport;
  run: AgentResult<ExecutionReport>;
}

/** The lines of a Playwright error that matter most: expected vs received. */
export function errorHeadline(error = ""): string {
  const key = error.split("\n").map((l) => l.trim()).filter((l) => /^(Expected|Received)/.test(l));
  return key.length > 0 ? key.join(", ") : (error.split("\n")[0] ?? "");
}

/** Does an independent run agree with what the agent claims? */
export function reconcile(report: ExecutionReport, rerun: RunSummary): { verified: boolean; verification: string } {
  if (rerun.crash) return { verified: report.outcome === "blocked", verification: `Re-run could not execute: ${rerun.crash.split("\n")[0]}` };
  const allPassed = rerun.tests.length > 0 && rerun.failed === 0;
  if (report.outcome === "passed") {
    return allPassed
      ? { verified: true, verification: `Re-run passed (${rerun.passed} test${rerun.passed === 1 ? "" : "s"}).` }
      : { verified: false, verification: "The agent reported a pass, but the re-run failed." };
  }
  if (report.outcome === "failing-suspected-product-bug") {
    return allPassed
      ? { verified: false, verification: "The agent reported a failure, but the re-run passed. Possibly flaky." }
      : { verified: true, verification: `Re-run failed the same way: ${errorHeadline(rerun.tests.find((t) => t.error)?.error)}` };
  }
  return { verified: true, verification: "Blocked: nothing to verify." };
}

export async function runExecutor(options: ExecutorOptions): Promise<ExecutorResult> {
  const { model, tools, testCase, maxSteps = 14, onEvent, verify = true, runnerAppPort = 3200, revision } = options;

  // A case that waits on an open question is not automated: there is no oracle to automate yet.
  if (testCase.blockedBy) {
    const report: ExecutionReport = {
      caseId: testCase.id,
      file: "",
      outcome: "blocked",
      attempts: 0,
      evidence: "",
      notes: `Not automated: the expected result depends on an open question. ${testCase.blockedBy}`,
      verified: true,
      verification: "Blocked by the test plan.",
    };
    return { report, run: { status: "done", output: report, steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, transcript: [] } };
  }

  const run = await runAgent<ExecutionReport>({
    model,
    system: EXECUTOR_SYSTEM,
    task: `Automate this test case:\n${JSON.stringify(testCase, null, 2)}${revision ? `\n\n${revision}` : ""}`,
    tools,
    output: { schema: executionReportSchema, description: "Submit the execution report for this case. Call this exactly once." },
    maxSteps,
    onEvent,
  });

  if (!run.output) return { run };
  const report = { ...run.output, caseId: testCase.id };
  if (!verify || report.outcome === "blocked") return { run, report };

  // Trust, but verify: the agent's own words are not evidence.
  const rerun = await runPlaywright(`tests/generated/${report.file}`, { appPort: runnerAppPort });
  return { run, report: { ...report, ...reconcile(report, rerun) } };
}

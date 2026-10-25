import type { MockTurn } from "../../llm/index.ts";

// The scripted Reviewer used in a crew run when QA_MODEL_PROVIDER=mock, in review order:
// TC-02, TC-05 (round 1), TC-05 (round 2, after the Executor's revision), TC-08.
// The code checks and the guards on its verdicts are real.

const approve = (summary: string): MockTurn => ({ toolCalls: [{ name: "submit_result", input: { verdict: "approve", summary, findings: [] } }] });

export function scriptedReviewer(): MockTurn[] {
  return [
    approve("One request, in its own room, asserted on status and on stored state. It fails with 201 where FR-005 requires 400: a correct test, and evidence about the application."),
    {
      text: "Two bookings in r2 in one test, and the case expects a rejection. Do the two stays overlap?",
      toolCalls: [{ name: "read_test_file", input: { path: "support/fixtures.ts" } }],
    },
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          verdict: "request-changes",
          summary: "The test passes, but not because of FR-007. Its first booking holds room r2 tonight, and the booking under test asks for r2 from yesterday to tomorrow, so the overlap rule rejects it whether or not the API checks past dates.",
          findings: [
            {
              check: "right-reason",
              severity: "major",
              line: 11,
              problem: "Line 7 books r2 from today to tomorrow. Line 11 asks for r2 from yesterday to tomorrow. The stays overlap tonight, so the 400 on line 12 can come from 'room is already booked for those dates'.",
              suggestion: "Make the request under test the only booking in the test, or give it a room and dates nothing else uses. Then a 400 can only come from the date rule.",
            },
            {
              check: "oracle-complete",
              severity: "minor",
              line: 13,
              problem: "The case expects that no booking is stored. The test expects one, because of its own setup booking.",
              suggestion: "Once the request under test stands alone, assert that no booking is stored, as the case says.",
            },
          ],
        },
      }],
    },
    approve("The request is now the only booking in the test, so only the date rule can reject it. The test fails with 201 where FR-007 requires 400: a correct test, and a real finding about the application."),
    approve("The setup booking is asserted, the two stays touch without overlapping, and both bookings are checked as stored. Back-to-back stays are what FR-009 allows."),
  ];
}

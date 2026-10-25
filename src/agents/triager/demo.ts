import type { MockTurn } from "../../llm/index.ts";

// The scripted Triager used when QA_MODEL_PROVIDER=mock, in the same order as the four failures
// of the demo red build in tests/triage-demo/. Evidence, re-runs and guards are real.

export function scriptedTriager(): MockTurn[] {
  return [
    // past-checkin: new product bug
    { text: "Is this already reported?", toolCalls: [{ name: "search_issues", input: { query: "API accepts past check-in date" } }, { name: "list_requirements", input: { key: "booking-rules" } }, { name: "recent_changes", input: {} }] },
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          classification: "product-bug",
          confidence: "high",
          rationale: "All three runs fail identically on the status assertion: the API returns 201 for a stay that started yesterday. FR-007 says check-in must not be in the past. The setup is a single valid request, so the test cannot be failing for another reason.",
          evidence: ["3 of 3 runs: Expected 400, Received 201.", "FR-007: check-in MUST NOT be in the past.", "No issue in the tracker mentions past dates.", "No recent changes to src/app: the rule was never implemented."],
          bugReport: {
            title: "Bookings can be made for stays that have already started",
            severity: "high",
            summary: "POST /api/bookings accepts a check-in date in the past and stores the booking. Guests can book nights that have already gone, and those bookings block real availability.",
            stepsToReproduce: ["POST /api/bookings with { guestName: 'Ana Prueba', roomId: 'r2', guests: 1, checkIn: <yesterday>, checkOut: <tomorrow> }", "GET /api/bookings"],
            expected: "400 Bad Request and nothing stored (booking-rules:FR-007).",
            actual: "201 Created; the booking is stored.",
            requirementIds: ["booking-rules:FR-007"],
            suspectedArea: "validateBooking() in src/app/validation.ts: it checks the date format and the order of the dates, but never compares check-in with today.",
          },
        },
      }],
    },
    // capacity: duplicate
    { text: "Search the tracker before writing anything.", toolCalls: [{ name: "search_issues", input: { query: "API capacity guests" } }] },
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          classification: "product-bug",
          confidence: "high",
          rationale: "Same failure on every run: 201 for 3 guests in a room of capacity 2. This is exactly ISSUE-0031, which is still open, so it should be linked, not filed again.",
          evidence: ["3 of 3 runs: Expected 400, Received 201.", "ISSUE-0031 (open): The API accepts more guests than the room's capacity."],
          duplicateOf: "ISSUE-0031",
        },
      }],
    },
    // book-from-form: test bug
    { text: "A locator timed out. What does the page object call this button?", toolCalls: [{ name: "read_test_file", input: { path: "support/fixtures.ts" } }] },
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          classification: "test-bug",
          confidence: "high",
          rationale: "Every run times out looking for a button named 'Book now'. The page object, written against the real page, names it 'Book room'. The test never reached its assertions, so it says nothing about the application.",
          evidence: ["3 of 3 runs: locator.click: Timeout 3000ms exceeded, waiting for getByRole('button', { name: 'Book now' }).", "tests/support/fixtures.ts: bookButton = getByRole('button', { name: 'Book room' })."],
          testFix: {
            summary: "Use the page object's button instead of a hand-written locator with the wrong name. The assertions stay exactly as they are.",
            change: "- await page.getByRole(\"button\", { name: \"Book now\" }).click({ timeout: 3000 });\n+ await bookingPage.bookButton.click();",
          },
        },
      }],
    },
    // new-booking-row: flaky
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          classification: "flaky",
          confidence: "medium",
          rationale: "The same test failed, passed and failed again with no change. Each failure is the table not yet showing the new row 500 ms after submitting. The page reloads the list with a second request, so the wait races that request.",
          evidence: ["Runs: failed, passed, failed.", "The failure is a toContainText timeout of 500 ms on the bookings table.", "The test shortens the default 5 s expect timeout to 500 ms."],
          flakinessCause: "The test waits only 500 ms for the table to refresh, which depends on how fast GET /api/bookings answers. Use the default timeout, or wait for the GET /api/bookings response before asserting. Do not add retries: they would hide the race, not fix it.",
        },
      }],
    },
  ];
}

/** The scripted Triager for a crew run (Chapter 9): the Executor's one real finding, TC-02. */
export function scriptedCrewTriager(): MockTurn[] {
  return [
    { text: "A wrong status on a capacity check. Is it already in the tracker?", toolCalls: [{ name: "search_issues", input: { query: "API capacity guests" } }] },
    {
      toolCalls: [{
        name: "submit_result",
        input: {
          classification: "product-bug",
          confidence: "high",
          rationale: "Every run fails the same way: the API returns 201 for 3 guests in room r2, whose capacity is 2. FR-005 requires the API to enforce capacity. ISSUE-0031 already reports this and is still open, so it should be linked, not filed again.",
          evidence: ["3 of 3 runs: Expected 400, Received 201.", "FR-005: capacity must be enforced in the UI and the API.", "ISSUE-0031 (open): The API accepts more guests than the room's capacity."],
          duplicateOf: "ISSUE-0031",
        },
      }],
    },
  ];
}

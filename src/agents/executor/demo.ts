import type { MockTurn } from "../../llm/index.ts";

// The scripted Executor used when QA_MODEL_PROVIDER=mock. The gates, the test runs and the
// verification are all real; only the model's decisions are scripted.
//   TC-02: a correct test that fails, because the app has a real bug.
//   TC-08: a correct test that passes.
//   TC-05: a test that passes for the wrong reason, the mistake from Chapter 7's real run.
//          The crew's Reviewer catches it (Chapter 10), and the revised test finds a real bug.

/** The cases the Chapter 7 example automates, in order. */
export const SCRIPTED_EXECUTOR_CASES = ["TC-02", "TC-08"];
/** The cases a scripted crew run automates (Chapter 10 adds TC-05). */
export const SCRIPTED_CREW_CASES = ["TC-02", "TC-05", "TC-08"];

const HEADER = `import { test, expect } from "../support/fixtures.ts";\n`;

const TC02_FIRST_TRY = `${HEADER}
test("TC-02 the API rejects 3 guests for a room of capacity 2", { tag: ["@TC-02", "@booking-rules:FR-005"] }, async ({ request }) => {
  const res = await request.post("/api/bookings", {
    data: { guestName: "Ana Prueba", roomId: "r2", guests: 3, checkIn: "2030-05-01", checkOut: "2030-05-03" },
  });
  expect(res.status()).toBe(400);
});
`;

const TC02 = `${HEADER}
// TC-02: The API rejects 3 guests for a room of capacity 2
// Oracle: 400 Bad Request and no booking is stored
test("TC-02 the API rejects 3 guests for a room of capacity 2", { tag: ["@TC-02", "@booking-rules:FR-005"] }, async ({ bookingApi }) => {
  const res = await bookingApi.create({ roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 });

  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);
});
`;

const TC08 = `${HEADER}
// TC-08: A stay may end on the day another stay starts
// Oracle: 201 Created, and both bookings are stored
test("TC-08 a stay may end on the day another stay starts", { tag: ["@TC-08", "@booking-rules:FR-009"] }, async ({ bookingApi }) => {
  const existing = await bookingApi.create({ roomId: "r2", checkInDays: 5, checkOutDays: 7 });
  expect(existing.status()).toBe(201);

  const res = await bookingApi.create({ roomId: "r2", guestName: "Luis Ejemplo", checkInDays: 3, checkOutDays: 5 });

  expect(res.status()).toBe(201);
  expect(await bookingApi.list()).toHaveLength(2);
});
`;

const TC05_WRONG_REASON = `${HEADER}
// TC-05: A stay that started yesterday is rejected
// Oracle: 400 Bad Request and no booking is stored
test("TC-05 a stay that started yesterday is rejected", { tag: ["@TC-05", "@booking-rules:FR-007"] }, async ({ bookingApi }) => {
  // A stay that starts today is accepted...
  const today = await bookingApi.create({ roomId: "r2", checkInDays: 0, checkOutDays: 1 });
  expect(today.status()).toBe(201);

  // ...and a stay that started yesterday is rejected.
  const yesterday = await bookingApi.create({ roomId: "r2", guestName: "Luis Ejemplo", checkInDays: -1, checkOutDays: 1 });
  expect(yesterday.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(1);
});
`;

const TC05 = `${HEADER}
// TC-05: A stay that started yesterday is rejected
// Oracle: 400 Bad Request and no booking is stored
test("TC-05 a stay that started yesterday is rejected", { tag: ["@TC-05", "@booking-rules:FR-007"] }, async ({ bookingApi }) => {
  // The only booking in this test: no other rule can reject it.
  const res = await bookingApi.create({ roomId: "r2", checkInDays: -1, checkOutDays: 1 });

  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);
});
`;

const CONVENTIONS: MockTurn = { text: "Read the team's fixtures and helpers first.", toolCalls: [{ name: "read_test_file", input: { path: "support/fixtures.ts" } }, { name: "read_test_file", input: { path: "support/dates.ts" } }] };

const TURNS: Record<string, MockTurn[]> = {
  "TC-02": [
    { text: "First draft.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-02-capacity.spec.ts", caseId: "TC-02", content: TC02_FIRST_TRY } }] },
    { text: "The gates rejected the fixed dates. Use the fixture with day offsets, and check that nothing is stored.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-02-capacity.spec.ts", caseId: "TC-02", content: TC02 } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-02-capacity.spec.ts" } }] },
    {
      text: "The setup is correct (valid room, valid dates, one field changed). The API returned 201 where the case expects 400. That is the application, not the test.",
      toolCalls: [{ name: "submit_result", input: { caseId: "TC-02", file: "tc-02-capacity.spec.ts", outcome: "failing-suspected-product-bug", attempts: 1, evidence: "expect(res.status()).toBe(400): Expected 400, Received 201. The API stored a booking for 3 guests in room r2 (capacity 2).", notes: "Matches risk R1 and the known FR-005 gap. Do not change the oracle; hand to the Triager." } }],
    },
  ],
  "TC-05": [
    { text: "Check both sides of the boundary in one test: today is accepted, yesterday is rejected.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-05-past-checkin.spec.ts", caseId: "TC-05", content: TC05_WRONG_REASON } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-05-past-checkin.spec.ts" } }] },
    { toolCalls: [{ name: "submit_result", input: { caseId: "TC-05", file: "tc-05-past-checkin.spec.ts", outcome: "passed", attempts: 1, evidence: "1 passed: today's stay returned 201, yesterday's stay returned 400, and one booking is stored.", notes: "Covers both sides of the FR-007 boundary in one test." } }] },
  ],
  "TC-08": [
    { text: "Same conventions as before.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-08-back-to-back.spec.ts", caseId: "TC-08", content: TC08 } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-08-back-to-back.spec.ts" } }] },
    { toolCalls: [{ name: "submit_result", input: { caseId: "TC-08", file: "tc-08-back-to-back.spec.ts", outcome: "passed", attempts: 1, evidence: "1 passed: both bookings returned 201 and both are listed.", notes: "Asserts the setup booking too, so a failure in setup cannot look like a pass." } }] },
  ],
};

/** The scripted turns for these cases, in order. The first case starts by reading the conventions. */
export function scriptedExecutor(cases: string[] = SCRIPTED_EXECUTOR_CASES): MockTurn[] {
  const turns = cases.flatMap((id) => TURNS[id] ?? []);
  return turns.length > 0 ? [CONVENTIONS, ...turns] : [];
}

/** The scripted Executor revising TC-05 after the Reviewer's findings (Chapter 10). */
export function scriptedExecutorRevision(): MockTurn[] {
  return [
    { text: "The reviewer is right: the second booking overlaps the first, so the overlap rule can reject it. Give the request under test the room to itself.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-05-past-checkin.spec.ts", caseId: "TC-05", content: TC05 } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-05-past-checkin.spec.ts" } }] },
    {
      text: "Now the request can only be rejected by the date rule, and it is not rejected at all. The test is correct; the application accepts a stay that started yesterday.",
      toolCalls: [{ name: "submit_result", input: { caseId: "TC-05", file: "tc-05-past-checkin.spec.ts", outcome: "failing-suspected-product-bug", attempts: 2, evidence: "expect(res.status()).toBe(400): Expected 400, Received 201. A booking that starts yesterday is accepted and stored.", notes: "The first version passed only because of the overlap rule. Do not change the oracle; hand to the Triager." } }],
    },
  ];
}

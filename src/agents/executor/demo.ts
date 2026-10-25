import type { MockTurn } from "../../llm/index.ts";

// The scripted Executor used when QA_MODEL_PROVIDER=mock: one case the app fails (a real bug),
// one it passes. The gates, the test runs and the verification are all real.

/** The cases the script automates, in order. */
export const SCRIPTED_EXECUTOR_CASES = ["TC-02", "TC-08"];

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

export function scriptedExecutor(): MockTurn[] {
  return [
    // TC-02
    { text: "Read the team's fixtures and helpers first.", toolCalls: [{ name: "read_test_file", input: { path: "support/fixtures.ts" } }, { name: "read_test_file", input: { path: "support/dates.ts" } }] },
    { text: "First draft.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-02-capacity.spec.ts", caseId: "TC-02", content: TC02_FIRST_TRY } }] },
    { text: "The gates rejected the fixed dates. Use the fixture with day offsets, and check that nothing is stored.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-02-capacity.spec.ts", caseId: "TC-02", content: TC02 } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-02-capacity.spec.ts" } }] },
    {
      text: "The setup is correct (valid room, valid dates, one field changed). The API returned 201 where the case expects 400. That is the application, not the test.",
      toolCalls: [{ name: "submit_result", input: { caseId: "TC-02", file: "tc-02-capacity.spec.ts", outcome: "failing-suspected-product-bug", attempts: 1, evidence: "expect(res.status()).toBe(400): Expected 400, Received 201. The API stored a booking for 3 guests in room r2 (capacity 2).", notes: "Matches risk R1 and the known FR-005 gap. Do not change the oracle; hand to the Triager." } }],
    },
    // TC-08
    { text: "Same conventions as before.", toolCalls: [{ name: "write_generated_test", input: { file: "tc-08-back-to-back.spec.ts", caseId: "TC-08", content: TC08 } }] },
    { toolCalls: [{ name: "run_generated_test", input: { file: "tc-08-back-to-back.spec.ts" } }] },
    { toolCalls: [{ name: "submit_result", input: { caseId: "TC-08", file: "tc-08-back-to-back.spec.ts", outcome: "passed", attempts: 1, evidence: "1 passed: both bookings returned 201 and both are listed.", notes: "Asserts the setup booking too, so a failure in setup cannot look like a pass." } }] },
  ];
}

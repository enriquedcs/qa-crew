import type { Tool } from "../../agent/runAgent.ts";
import type { ExecutionReport, Review, ReviewCheck, TestCase } from "../../crew/contracts.ts";
import type { ModelClient, Usage } from "../../llm/types.ts";
import { preReview } from "./checks.ts";
import { runReviewer } from "./reviewer.ts";

// Who reviews the reviewer? A calibration set: generated tests with a known, planted defect
// (and a few clean ones), the same idea as seeding bugs to measure a test suite.
// Running the Reviewer over the set tells you what it catches, what it misses,
// and how often it raises a false alarm, before you trust it in a crew.

export interface CalibrationSample {
  name: string;
  testCase: TestCase;
  source: string;
  /** The planted defect, or null for a clean test the Reviewer should approve. */
  defect: ReviewCheck | null;
  /** What happens when the test runs against today's booking app. */
  result: ExecutionReport["outcome"];
}

const HEADER = `import { test, expect } from "../support/fixtures.ts";\n`;
const api = (over: Partial<TestCase> & Pick<TestCase, "id" | "title" | "requirementIds" | "data" | "expected">): TestCase => ({
  riskIds: ["R1"],
  technique: "boundary-values",
  layer: "api",
  priority: "p1",
  preconditions: ["Test data is reset"],
  steps: [],
  ...over,
});

const TC02 = api({ id: "TC-02", title: "The API rejects 3 guests for a room of capacity 2", requirementIds: ["booking-rules:FR-005"], data: { roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 }, expected: "400 Bad Request and no booking is stored" });
const TC05 = api({ id: "TC-05", title: "A stay that started yesterday is rejected", requirementIds: ["booking-rules:FR-007"], data: { roomId: "r2", guests: 1, checkInDays: -1, checkOutDays: 1 }, expected: "400 Bad Request and no booking is stored" });
const TC07 = api({ id: "TC-07", title: "A second booking for the same nights is rejected", requirementIds: ["booking-rules:FR-008"], data: { roomId: "r3", guests: 2, checkInDays: 10, checkOutDays: 12 }, expected: "400 'room is already booked for those dates', and only the first booking is stored" });
const TC08 = api({ id: "TC-08", title: "A stay may end on the day another stay starts", requirementIds: ["booking-rules:FR-009"], data: { roomId: "r2", guests: 1, checkInDays: 3, checkOutDays: 5, existing: { checkInDays: 5, checkOutDays: 7 } }, expected: "201 Created, and both bookings are stored" });
const TC10 = api({ id: "TC-10", title: "Cancelling a booking twice returns 404 the second time", requirementIds: ["booking-rules:FR-010"], technique: "state-transition", data: { roomId: "r1", guests: 1, checkInDays: 20, checkOutDays: 21 }, expected: "First DELETE 204, second DELETE 404" });

const t = (c: TestCase, body: string) => `${HEADER}
test("${c.id} ${c.title.toLowerCase()}", { tag: ["@${c.id}", ${c.requirementIds.map((r) => `"@${r}"`).join(", ")}] }, async ({ bookingApi }) => {
${body}
});
`;

export const CALIBRATION_SET: CalibrationSample[] = [
  {
    name: "clean: capacity, one request, full oracle",
    testCase: TC02,
    defect: null,
    result: "failing-suspected-product-bug",
    source: t(TC02, `  const res = await bookingApi.create({ roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 });
  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);`),
  },
  {
    name: "clean: back-to-back stays, setup asserted",
    testCase: TC08,
    defect: null,
    result: "passed",
    source: t(TC08, `  const existing = await bookingApi.create({ roomId: "r2", checkInDays: 5, checkOutDays: 7 });
  expect(existing.status()).toBe(201);
  const res = await bookingApi.create({ roomId: "r2", guestName: "Luis Ejemplo", checkInDays: 3, checkOutDays: 5 });
  expect(res.status()).toBe(201);
  expect(await bookingApi.list()).toHaveLength(2);`),
  },
  {
    name: "clean: a past check-in, standing alone (it fails: the app has the bug)",
    testCase: TC05,
    defect: null,
    result: "failing-suspected-product-bug",
    source: t(TC05, `  const res = await bookingApi.create({ roomId: "r2", checkInDays: -1, checkOutDays: 1 });
  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);`),
  },
  {
    name: "wrong reason: the overlap rule rejects the request (Chapter 7's TC-08)",
    testCase: TC05,
    defect: "right-reason",
    result: "passed",
    source: t(TC05, `  const today = await bookingApi.create({ roomId: "r2", checkInDays: 0, checkOutDays: 1 });
  expect(today.status()).toBe(201);
  const yesterday = await bookingApi.create({ roomId: "r2", checkInDays: -1, checkOutDays: 1 });
  expect(yesterday.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(1);`),
  },
  {
    name: "weakened oracle: asserts today's behavior instead of the requirement",
    testCase: TC02,
    defect: "no-weakening",
    result: "passed",
    source: t(TC02, `  // The API currently accepts this; assert what it does so the test is green.
  const res = await bookingApi.create({ roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 });
  expect(res.status()).toBe(201);`),
  },
  {
    name: "incomplete oracle: status only, the stored state is never checked",
    testCase: TC02,
    defect: "oracle-complete",
    result: "failing-suspected-product-bug",
    source: t(TC02, `  const res = await bookingApi.create({ roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 });
  expect(res.status()).toBe(400);`),
  },
  {
    name: "incomplete oracle: the quoted message is never checked",
    testCase: TC07,
    defect: "oracle-complete",
    result: "passed",
    source: t(TC07, `  const first = await bookingApi.create({ roomId: "r3", guests: 2, checkInDays: 10, checkOutDays: 12 });
  expect(first.status()).toBe(201);
  const second = await bookingApi.create({ roomId: "r3", guests: 2, checkInDays: 10, checkOutDays: 12 });
  expect(second.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(1);`),
  },
  {
    name: "unchecked setup: the existing booking is never asserted",
    testCase: { ...TC08, expected: "201 Created" },
    defect: "setup-verified",
    result: "passed",
    source: t(TC08, `  await bookingApi.create({ roomId: "r2", checkInDays: 5, checkOutDays: 7 });
  const res = await bookingApi.create({ roomId: "r2", guestName: "Luis Ejemplo", checkInDays: 3, checkOutDays: 5 });
  expect(res.status()).toBe(201);`),
  },
  {
    name: "wrong data: a room that fits 3 guests, so the capacity rule is never exercised",
    testCase: TC02,
    defect: "data-matches-case",
    result: "failing-suspected-product-bug",
    source: t(TC02, `  const res = await bookingApi.create({ roomId: "r3", guests: 3, checkInDays: 30, checkOutDays: 32 });
  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);`),
  },
  {
    name: "not isolated: cancels a booking id another test created",
    testCase: TC10,
    defect: "isolated",
    result: "failing-suspected-product-bug",
    source: t(TC10, `  // Booking b1 is created by the capacity tests, which run first.
  const first = await bookingApi.cancel("b1");
  expect(first.status()).toBe(204);
  const second = await bookingApi.cancel("b1");
  expect(second.status()).toBe(404);`),
  },
];

export interface CalibrationResult {
  sample: string;
  defect: ReviewCheck | null;
  /** Did code checks alone flag the planted defect? */
  code: boolean;
  verdict?: Review["verdict"];
  /** The defect was flagged (by code or Reviewer) under the right check, or a clean test was approved. */
  correct: boolean;
  findings: string[];
}

export interface CalibrationReport {
  results: CalibrationResult[];
  caught: number;
  defective: number;
  byCodeAlone: number;
  falseAlarms: number;
  clean: number;
  usage: Usage;
}

export async function calibrate(model: ModelClient, tools: Tool[] = [], samples = CALIBRATION_SET): Promise<CalibrationReport> {
  const results: CalibrationResult[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for (const s of samples) {
    const code = preReview(s.testCase, s.source).facts.some((f) => f.check === s.defect);
    const report: ExecutionReport = { caseId: s.testCase.id, file: `${s.testCase.id.toLowerCase()}.spec.ts`, outcome: s.result, attempts: 1, evidence: s.result === "passed" ? "1 passed." : "Expected 400, Received 201.", notes: "", verified: true };
    const { review, run } = await runReviewer({ model, tools, testCase: s.testCase, source: s.source, report });
    usage.inputTokens += run.usage.inputTokens;
    usage.outputTokens += run.usage.outputTokens;
    const flagged = !!review?.findings.some((f) => f.check === s.defect && f.severity !== "minor");
    const correct = s.defect === null ? review?.verdict === "approve" : review?.verdict === "request-changes" && flagged;
    results.push({
      sample: s.name,
      defect: s.defect,
      code,
      verdict: review?.verdict,
      correct: !!correct,
      findings: (review?.findings ?? []).map((f) => `${f.severity} ${f.check} (${f.source ?? "reviewer"})`),
    });
  }
  const defective = results.filter((r) => r.defect !== null);
  return {
    results,
    caught: defective.filter((r) => r.correct).length,
    defective: defective.length,
    byCodeAlone: defective.filter((r) => r.code).length,
    falseAlarms: results.filter((r) => r.defect === null && !r.correct).length,
    clean: results.length - defective.length,
    usage,
  };
}

export function renderCalibration(report: CalibrationReport, label: string): string {
  const lines = [
    `# Reviewer calibration: ${label}`,
    "",
    `Caught ${report.caught} of ${report.defective} planted defects (${report.byCodeAlone} were also flagged by code checks alone).`,
    `False alarms: ${report.falseAlarms} of ${report.clean} clean tests.`,
    `Tokens: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out.`,
    "",
    "| Sample | Planted defect | Code alone | Verdict | Result |",
    "|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    lines.push(`| ${r.sample} | ${r.defect ?? "none"} | ${r.defect === null ? "" : r.code ? "yes" : "no"} | ${r.verdict ?? "no review"} | ${r.correct ? "✓" : r.defect === null ? "✗ false alarm" : "✗ missed"} |`);
  }
  return lines.join("\n") + "\n";
}

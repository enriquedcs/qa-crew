import { expect, test } from "@playwright/test";
import { CSV_COLUMNS, testCaseRows, testPlanToCsv } from "../../src/agents/designer/export.ts";
import type { TestCase } from "../../src/crew/contracts.ts";

const tc = (over: Partial<TestCase> = {}): TestCase => ({
  id: "TC-02",
  title: "The API rejects 3 guests for a room of capacity 2",
  riskIds: ["R1"],
  requirementIds: ["booking-rules:FR-005"],
  technique: "boundary-values",
  layer: "api",
  priority: "p1",
  preconditions: ["Test data is reset"],
  steps: ["POST /api/bookings for room r2 with 3 guests", "GET /api/bookings"],
  data: { roomId: "r2", guests: 3 },
  expected: "400 Bad Request and no booking is stored",
  ...over,
});

test("one row per step; the data on the first step, the oracle on the last", () => {
  const rows = testCaseRows(tc());
  expect(rows).toHaveLength(2);
  const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
  expect(rows.map((r) => r[col("Step")])).toEqual(["1", "2"]);
  expect(rows.map((r) => r[col("Test Case ID")])).toEqual(["TC-02", "TC-02"]);
  expect(rows[0][col("Data")]).toBe('{"roomId":"r2","guests":3}');
  expect(rows[1][col("Data")]).toBe("");
  expect(rows[0][col("Expected Result")]).toBe("");
  expect(rows[1][col("Expected Result")]).toBe("400 Bad Request and no booking is stored");
});

test("quotes, commas and line breaks survive the CSV", () => {
  const csv = testPlanToCsv({ feature: "f", cases: [tc({ steps: ['Say "hi", then\nwait'] })] });
  expect(csv.split("\r\n")[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(","));
  expect(csv).toContain('"Say ""hi"", then\nwait"');
});

test("a blocked case keeps its open question, so the tool shows it is not ready", () => {
  const rows = testCaseRows(tc({ blockedBy: "Whose 'today' counts?" }));
  expect(rows[0][CSV_COLUMNS.indexOf("Blocked By")]).toBe("Whose 'today' counts?");
});

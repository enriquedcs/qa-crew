import type { TestCase, TestPlan } from "../../crew/contracts.ts";

// Export a reviewed test plan for a test case management tool: Azure DevOps Test Plans,
// Jira with Xray or Zephyr, TestRail and others. They all import CSV with one row per step,
// grouped by a test case id or title, and a mapping wizard that lets you say which column is what.
//
// The plan in the repository stays the source of truth. The CSV is a copy for the people and
// tools that live in the test case management tool; the case id (TC-02) travels with it, so
// a result or a bug can always be traced back to the case, the risk and the requirement.

export const CSV_COLUMNS = [
  "Test Case ID",
  "Title",
  "Priority",
  "Requirements",
  "Risks",
  "Technique",
  "Layer",
  "Preconditions",
  "Blocked By",
  "Step",
  "Action",
  "Data",
  "Expected Result",
] as const;

function cell(value: unknown): string {
  const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  // RFC 4180: quote every field, double the quotes inside it. Spreadsheets and importers all read this.
  return `"${text.replace(/"/g, '""')}"`;
}

/** One row per step. Case-level fields repeat on every row, so any importer can group the steps. */
export function testCaseRows(c: TestCase): string[][] {
  const steps = c.steps.length > 0 ? c.steps : ["(no steps)"];
  return steps.map((action, i) => [
    c.id,
    c.title,
    c.priority,
    c.requirementIds.join(", "),
    c.riskIds.join(", "),
    c.technique,
    c.layer,
    c.preconditions.join("; "),
    c.blockedBy ?? "",
    String(i + 1),
    action,
    i === 0 ? JSON.stringify(c.data) : "",
    // The plan has one oracle per case: it belongs to the last step, where it is observed.
    i === steps.length - 1 ? c.expected : "",
  ]);
}

export function testPlanToCsv(plan: TestPlan): string {
  const rows = [CSV_COLUMNS as readonly string[], ...plan.cases.flatMap(testCaseRows)];
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Chapter 8: the Triager turns a red build into classified failures and draft bug reports.
//
//   npm run ch08                                  # triage the demo red build in tests/triage-demo/
//   npm run ch08 -- --executor                    # triage the failures the Executor found in Chapter 7
//   QA_MODEL_PROVIDER=mock npm run ch08           # no API key: scripted model, real runs and real evidence
//
// Writes: out/triager/triage.md and triage.json
//         out/triager/issues/*.md                (draft bug reports, for a human to review and file)

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionReport, Failure, TestPlan, TriageItem } from "../crew/contracts.ts";
import type { MockTurn } from "../llm/index.ts";
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { collectEvidence, failuresFrom } from "../agents/triager/evidence.ts";
import { renderBugReport, renderTriage, runTriager } from "../agents/triager/triager.ts";
import { loadEnv, modelOrMock, printEvents, readArtifact, writeArtifact } from "../agents/shared.ts";
import { runPlaywright } from "../runner/playwright.ts";

loadEnv();
const fromExecutor = process.argv.includes("--executor");

// ---- 1. Find the failures ----

const failures: Failure[] = [];

if (fromExecutor) {
  const reports = await readArtifact<ExecutionReport[]>("out/executor/booking-rules.execution.json");
  const plan = existsSync("out/designer/booking-rules.test-plan.json")
    ? await readArtifact<TestPlan>("out/designer/booking-rules.test-plan.json")
    : undefined;
  for (const r of reports.filter((r) => r.outcome === "failing-suspected-product-bug")) {
    const summary = await runPlaywright(`tests/generated/${r.file}`);
    const expected = plan?.cases.find((c) => c.id === r.caseId)?.expected;
    for (const f of failuresFrom(summary)) failures.push({ ...f, caseId: r.caseId, ...(expected ? { expected } : {}) });
  }
} else {
  // The demo's flaky test alternates fail/pass; start it from a known state so the example is reproducible.
  await rm(path.join(os.tmpdir(), "qa-crew-flaky-demo.txt"), { force: true });
  for (const name of ["past-checkin", "capacity", "book-from-form", "new-booking-row"]) {
    failures.push(...failuresFrom(await runPlaywright(`tests/triage-demo/${name}.spec.ts`)));
  }
}

console.log(`${failures.length} failing tests to triage.\n`);

// ---- 2. The scripted demo, in the same order as the demo failures ----

function scriptedTriager(): MockTurn[] {
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

// ---- 3. Triage each failure: evidence by code, judgment by the model, guards by code ----

const model = modelOrMock(scriptedTriager);
const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([
  {
    name: "qa-tools",
    config: servers["qa-tools"],
    filter: { include: ["read_test_file", "list_requirements", "get_api_reference", "search_issues", "search_knowledge", "recent_changes"] },
  },
]);

const items: TriageItem[] = [];
try {
  for (const failure of failures) {
    console.log(`=== ${failure.title}  (${failure.file})`);
    const pack = await collectEvidence(failure);
    console.log(`  evidence: runs ${pack.runs.map((r) => r.status).join(", ")}; app healthy: ${pack.appHealthy ? "yes" : "no"}`);
    const { item, run } = await runTriager({ model, tools: toolbox.tools, pack, onEvent: printEvents("  ") });
    if (!item) {
      console.log(`  no triage (${run.status})\n`);
      continue;
    }
    items.push(item);
    console.log(`  => ${item.classification}${item.duplicateOf ? ` (duplicate of ${item.duplicateOf})` : ""}`);
    for (const w of item.warnings ?? []) console.log(`     ⚠ ${w}`);
    console.log("");
  }
} finally {
  await toolbox.close();
}

// ---- 4. Write it up for humans ----

await writeArtifact("out/triager/triage.json", items);
await writeArtifact("out/triager/triage.md", renderTriage(items));
for (const item of items) {
  const draft = renderBugReport(item);
  if (draft) {
    const slug = path.basename(item.file, ".spec.ts");
    console.log(`Draft bug report: ${await writeArtifact(`out/triager/issues/DRAFT-${slug}.md`, draft)}`);
  }
}
console.log("Triage: out/triager/triage.md");

// Chapter 7: the Executor turns test cases into Playwright tests, runs them and iterates.
//
//   npm run ch06                                   # first, produce the test plan
//   npm run ch07                                   # automate the p1 cases of the plan
//   npm run ch07 -- TC-02 TC-08                    # or only the cases you name
//   QA_MODEL_PROVIDER=mock npm run ch07            # no API key: scripted model, real gates and real runs
//
// Reads:  out/designer/<feature>.test-plan.json
// Writes: tests/generated/*.spec.ts                (drafts: a human promotes the ones worth keeping)
//         out/executor/<feature>.execution.json

import { existsSync } from "node:fs";
import type { ExecutionReport, TestPlan } from "../crew/contracts.ts";
import type { MockTurn } from "../llm/index.ts";
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { runExecutor } from "../agents/executor/executor.ts";
import { loadEnv, modelOrMock, printEvents, readArtifact, writeArtifact } from "../agents/shared.ts";

loadEnv();
const feature = "booking-rules";
const planFile = `out/designer/${feature}.test-plan.json`;
const mock = (process.env.QA_MODEL_PROVIDER ?? "").toLowerCase() === "mock";

if (!existsSync(planFile)) {
  console.error(`No test plan at ${planFile}. Run the Designer first: npm run ch06`);
  process.exit(1);
}

const plan = await readArtifact<TestPlan>(planFile);
const requested = process.argv.slice(2);
const ids = requested.length > 0 ? requested : mock ? ["TC-02", "TC-08"] : plan.cases.filter((c) => c.priority === "p1").map((c) => c.id);
const cases = plan.cases.filter((c) => ids.includes(c.id));

// ---- The scripted demo: one case the app fails (a real bug), one it passes ----

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

function scriptedExecutor(): MockTurn[] {
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

// ---- Run ----

const model = modelOrMock(scriptedExecutor);
const servers = await loadMcpConfig(".mcp.json");
const qaTools = { ...servers["qa-tools"], env: { ...servers["qa-tools"].env, QA_TOOLS_ALLOW_TEST_WRITES: "true" } };
const toolbox = await connectMcpServers([
  {
    name: "qa-tools",
    config: qaTools,
    // Least privilege: read the project, write and run generated tests. No booking writes.
    filter: { include: ["read_test_file", "list_test_files", "get_api_reference", "list_rooms", "write_generated_test", "run_generated_test"] },
  },
]);

const reports: ExecutionReport[] = [];
try {
  for (const testCase of cases) {
    console.log(`\n=== ${testCase.id} ${testCase.title}`);
    const { report, run } = await runExecutor({ model, tools: toolbox.tools, testCase, onEvent: printEvents("  ") });
    if (!report) {
      console.log(`  No report (${run.status}).`);
      continue;
    }
    reports.push(report);
    console.log(`  => ${report.outcome}${report.verified === false ? "  (NOT VERIFIED)" : ""}`);
    if (report.verification) console.log(`     ${report.verification}`);
  }
} finally {
  await toolbox.close();
}

await writeArtifact(`out/executor/${feature}.execution.json`, reports);
console.log("\nSummary:");
for (const r of reports) console.log(`  ${r.caseId}  ${r.outcome.padEnd(30)} ${r.verified ? "verified" : "check by hand"}  tests/generated/${r.file}`);

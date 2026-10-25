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
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { SCRIPTED_EXECUTOR_CASES, scriptedExecutor } from "../agents/executor/demo.ts";
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
const ids = requested.length > 0 ? requested : mock ? SCRIPTED_EXECUTOR_CASES : plan.cases.filter((c) => c.priority === "p1").map((c) => c.id);
const cases = plan.cases.filter((c) => ids.includes(c.id));

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

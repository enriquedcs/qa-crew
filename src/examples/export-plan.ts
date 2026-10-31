// Export a reviewed test plan as CSV for a test case management tool (Chapter 6).
//
//   npm run export-plan                                      # the latest crew run's plan, or out/designer/
//   npm run export-plan -- out/crew/<run>/test-plan.json     # a specific plan
//
// Writes the CSV next to the plan: test-plan.csv. Import it with your tool's CSV importer
// (Azure DevOps Test Plans, Xray, Zephyr...) and map the columns in its wizard.
// Export after the plan is approved: the tool should receive what a person accepted.

import { existsSync } from "node:fs";
import path from "node:path";
import type { TestPlan } from "../crew/contracts.ts";
import { latestRunId } from "../crew/orchestrator.ts";
import { testPlanToCsv } from "../agents/designer/export.ts";
import { readArtifact, writeArtifact } from "../agents/shared.ts";

async function findPlan(): Promise<string | undefined> {
  const given = process.argv[2];
  if (given) return given;
  const run = await latestRunId({ root: "out/crew" });
  const fromRun = run ? path.join("out/crew", run, "test-plan.json") : undefined;
  if (fromRun && existsSync(fromRun)) return fromRun;
  const fromDesigner = "out/designer/booking-rules.test-plan.json";
  return existsSync(fromDesigner) ? fromDesigner : undefined;
}

const file = await findPlan();
if (!file || !existsSync(file)) {
  console.error("No test plan found. Run the Designer (npm run ch06) or a crew run first, or pass a path.");
  process.exit(1);
}

const plan = await readArtifact<TestPlan>(file);
const out = path.join(path.dirname(file), path.basename(file, ".json") + ".csv");
await writeArtifact(out, testPlanToCsv(plan));
const steps = plan.cases.reduce((n, c) => n + Math.max(1, c.steps.length), 0);
console.log(`${plan.cases.length} cases, ${steps} steps -> ${out}`);
const blocked = plan.cases.filter((c) => c.blockedBy);
if (blocked.length) console.log(`${blocked.length} blocked by an open question (see the Blocked By column): ${blocked.map((c) => c.id).join(", ")}`);

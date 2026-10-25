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
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { collectEvidence, failuresFrom, failuresFromExecution } from "../agents/triager/evidence.ts";
import { scriptedTriager } from "../agents/triager/demo.ts";
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
  failures.push(...(await failuresFromExecution(reports, plan)));
} else {
  // The demo's flaky test alternates fail/pass; start it from a known state so the example is reproducible.
  await rm(path.join(os.tmpdir(), "qa-crew-flaky-demo.txt"), { force: true });
  for (const name of ["past-checkin", "capacity", "book-from-form", "new-booking-row"]) {
    failures.push(...failuresFrom(await runPlaywright(`tests/triage-demo/${name}.spec.ts`)));
  }
}

console.log(`${failures.length} failing tests to triage.\n`);

// ---- 2. Triage each failure: evidence by code, judgment by the model, guards by code ----

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

// ---- 3. Write it up for humans ----

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

// Chapter 6: the Designer turns the Analyst's risk map into a curated test plan.
//
//   npm run ch05                                   # first, produce and review the risk map
//   npm run ch06                                   # then design tests for it
//   QA_MODEL_PROVIDER=mock npm run ch06            # no API key: a scripted model, real tools
//
// Reads:  out/analyst/<feature>.risk-map.json   (risks you rejected there are skipped)
// Writes: out/designer/<feature>.test-plan.json and .md

import { existsSync } from "node:fs";
import type { RiskMap } from "../crew/contracts.ts";
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { risksForDesign } from "../agents/analyst/curate.ts";
import { scriptedDesigner } from "../agents/designer/demo.ts";
import { renderTestPlan, runDesigner } from "../agents/designer/designer.ts";
import { testDataTools } from "../agents/designer/testData.ts";
import { loadEnv, modelOrMock, printEvents, readArtifact, writeArtifact } from "../agents/shared.ts";

loadEnv();
const feature = process.argv[2] ?? "booking-rules";
const riskMapFile = `out/analyst/${feature}.risk-map.json`;

if (!existsSync(riskMapFile)) {
  console.error(`No risk map at ${riskMapFile}. Run the Analyst first: npm run ch05 -- ${feature}`);
  process.exit(1);
}

const riskMap = await readArtifact<RiskMap>(riskMapFile);
const risks = risksForDesign(riskMap);

const model = modelOrMock(() => scriptedDesigner(feature));
const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"], filter: { readOnly: true } }]);

try {
  console.log(`Designer on "${feature}" (${risks.length} risks) using ${model.provider} / ${model.model}\n`);
  const { run, plan, uncovered } = await runDesigner({
    model,
    tools: [...toolbox.tools, ...testDataTools()],
    feature,
    risks,
    onEvent: printEvents(),
  });

  console.log(`\nStatus: ${run.status} after ${run.steps} steps`);
  if (!plan) process.exit(1);

  const base = `out/designer/${feature}.test-plan`;
  await writeArtifact(`${base}.json`, plan);
  await writeArtifact(`${base}.md`, renderTestPlan(plan, uncovered));

  console.log(`\nKept ${plan.cases.length} cases:`);
  for (const c of plan.cases) console.log(`  ${c.priority}  ${c.id}  [${c.riskIds.join(",")}] ${c.layer.padEnd(3)} ${c.title}`);
  for (const d of plan.dropped ?? []) console.log(`  dropped ${d.id}: ${d.reason}`);
  for (const r of uncovered) console.log(`  no test for ${r.id}: ${r.title}`);
  console.log(`\nReview: ${base}.md`);
} finally {
  await toolbox.close();
}

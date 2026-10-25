// Chapter 5: the Analyst turns requirements into a risk map.
//
//   npm run app                                   # in one terminal
//   npm run ch05                                  # in another (uses QA_MODEL_* from .env)
//   QA_MODEL_PROVIDER=mock npm run ch05           # no API key: a scripted model, real tools
//   npm run ch05 -- max-stay-limit                # analyze another requirements document
//
// Output, for a human to review:
//   out/analyst/<feature>.risk-map.md     the readable version
//   out/analyst/<feature>.risk-map.json   the version you edit (status, scores) and the Designer reads

import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { runAnalyst } from "../agents/analyst/analyst.ts";
import { scriptedAnalyst } from "../agents/analyst/demo.ts";
import { renderRiskMap } from "../agents/analyst/render.ts";
import { loadEnv, modelOrMock, printEvents, writeArtifact } from "../agents/shared.ts";

loadEnv();
const feature = process.argv[2] ?? "booking-rules";

const model = modelOrMock(() => scriptedAnalyst(feature));
const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"], filter: { readOnly: true } }]);

try {
  console.log(`Analyst on "${feature}" using ${model.provider} / ${model.model}\n`);
  const { run, riskMap } = await runAnalyst({ model, tools: toolbox.tools, feature, onEvent: printEvents() });

  console.log(`\nStatus: ${run.status} after ${run.steps} steps (${run.usage.inputTokens} in / ${run.usage.outputTokens} out tokens)`);
  if (!riskMap) process.exit(1);

  const base = `out/analyst/${feature}.risk-map`;
  await writeArtifact(`${base}.json`, riskMap);
  await writeArtifact(`${base}.md`, renderRiskMap(riskMap));

  console.log(`\n${riskMap.summary}\n`);
  for (const r of riskMap.risks) {
    console.log(`  ${(r.level ?? "").toUpperCase().padEnd(6)} ${String(r.score).padStart(2)}  ${r.id} ${r.title}`);
    for (const w of r.warnings ?? []) console.log(`              ⚠ ${w}`);
  }
  console.log(`\n${riskMap.questions.length} open questions, ${riskMap.missingRequirements.length} possibly missing requirements.`);
  console.log(`Review: ${base}.md   Edit: ${base}.json`);
} finally {
  await toolbox.close();
}

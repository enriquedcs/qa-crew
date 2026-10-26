// Chapter 10: who reviews the reviewer? Run the Reviewer over a calibration set of generated tests
// with planted defects, and measure what it catches, what it misses, and its false alarms.
//
//   npm run ch10                                  # calibrate the Reviewer with your model (QA_REVIEWER_MODEL or QA_MODEL)
//   QA_MODEL_PROVIDER=mock npm run ch10           # a "rubber stamp" that approves everything: what code checks catch alone
//
// The Reviewer at work inside a crew run: QA_MODEL_PROVIDER=mock npm run crew -- start --auto
//
// Writes: out/reviewer/calibration-<model>.md

import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { CALIBRATION_SET, calibrate, renderCalibration, rubberStamp } from "../agents/reviewer/calibration.ts";
import { loadEnv, modelForRole, writeArtifact } from "../agents/shared.ts";

loadEnv();

const model = modelForRole("reviewer", () => rubberStamp());
const label = model.provider === "mock" ? "a rubber stamp (scripted: approves everything)" : `${model.provider} / ${model.model}`;
const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([
  { name: "qa-tools", config: servers["qa-tools"], filter: { include: ["read_test_file", "list_requirements", "get_api_reference"] } },
]);

try {
  console.log(`Calibrating the Reviewer: ${label}\n${CALIBRATION_SET.length} generated tests, ${CALIBRATION_SET.filter((s) => s.defect).length} with a planted defect.\n`);
  const report = await calibrate(model, toolbox.tools);
  for (const r of report.results) {
    const mark = r.correct ? "✓" : r.defect === null ? "✗ false alarm" : "✗ missed";
    console.log(`  ${mark.padEnd(14)} ${r.sample}`);
    for (const f of r.findings) console.log(`                   ${f}`);
  }
  console.log(`\nCaught ${report.caught} of ${report.defective} planted defects; code checks alone flagged ${report.byCodeAlone}.`);
  console.log(`False alarms: ${report.falseAlarms} of ${report.clean} clean tests.`);
  const slug = model.model.replace(/[^\w.-]+/g, "-");
  console.log(`\nReport: ${await writeArtifact(`out/reviewer/calibration-${slug}.md`, renderCalibration(report, label))}`);
} finally {
  await toolbox.close();
}

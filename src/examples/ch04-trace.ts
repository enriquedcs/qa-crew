// Chapter 4: where do the specs and the tests disagree?
//
// Reads every Spec Kit spec (specs/*/spec.md) and ODD feature document
// (odd/tasks/*.md), finds the requirement tags in the tests, and reports
// requirements with no test, tags that match no requirement, and open questions.
//
//   npm run trace
//   npm run trace -- --strict    # exit with code 1 on drift (for CI)
//
// No model is involved: this is the deterministic half of spec-driven QA.

import { loadRequirements } from "../specs/requirements.ts";
import { buildTraceReport, findRequirementTags, formatTraceReport } from "../specs/trace.ts";

const docs = await loadRequirements(".");
const report = buildTraceReport(docs, await findRequirementTags("tests"));

for (const doc of docs) {
  console.log(`${doc.workflow.toUpperCase()}  ${doc.file}  "${doc.title}"  (${doc.requirements.length} requirements)`);
}
console.log("\n" + formatTraceReport(report));

if (process.argv.includes("--strict") && report.unknownTags.length > 0) {
  console.error("Drift: some tests point at requirements that do not exist.");
  process.exit(1);
}

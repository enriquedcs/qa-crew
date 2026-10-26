// Chapter 12: freeze the inputs of the evals that would otherwise need a live run.
//
//   npm run eval:freeze
//
// An eval compares agents, models and prompts. If its input changes between two runs, you are no
// longer comparing like with like. So the inputs that come from a run (the red build the Triager
// reads, the risk map the Designer reads) are recorded once, committed, and replayed.
//
// Writes: src/evals/fixtures/risk-map.json        the Designer's input: a reviewed risk map
//         src/evals/fixtures/test-cases.json      the Executor's input: three cases from a test plan
//         src/evals/fixtures/triage-evidence.json the Triager's input: four failures with their evidence

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RiskMap, TestPlan } from "../crew/contracts.ts";
import { curateRiskMap } from "../agents/analyst/curate.ts";
import { scriptedAnalyst } from "../agents/analyst/demo.ts";
import { scriptedDesigner } from "../agents/designer/demo.ts";
import { SCRIPTED_CREW_CASES } from "../agents/executor/demo.ts";
import { collectEvidence, failuresFrom } from "../agents/triager/evidence.ts";
import { writeArtifact } from "../agents/shared.ts";
import type { MockTurn } from "../llm/index.ts";
import { runPlaywright } from "../runner/playwright.ts";
import { loadRequirements } from "../specs/requirements.ts";

const FIXTURES = "src/evals/fixtures";

/** The structured result a scripted agent submits on its last turn. */
function submitted<T>(turns: MockTurn[]): T {
  const last = turns.at(-1);
  const call = typeof last === "object" ? last.toolCalls?.find((c) => c.name === "submit_result") : undefined;
  if (!call) throw new Error("The script does not end with submit_result.");
  return call.input as T;
}

// 1. A reviewed risk map: the scripted Analyst's, with the risk that cites an invented id rejected.
const known = (await loadRequirements(".")).flatMap((d) => d.requirements.map((r) => r.id));
const draft = curateRiskMap(submitted<RiskMap>(scriptedAnalyst("booking-rules")), known);
const riskMap: RiskMap = {
  ...draft,
  risks: draft.risks.map((r) => ({ ...r, status: r.warnings ? "rejected" : "accepted" })),
};
console.log(`Risk map: ${await writeArtifact(`${FIXTURES}/risk-map.json`, riskMap)}`);

// 2. The cases the crew automates in its demo run.
const plan = submitted<TestPlan>(scriptedDesigner("booking-rules"));
const cases = plan.cases.filter((c) => SCRIPTED_CREW_CASES.includes(c.id));
console.log(`Test cases: ${await writeArtifact(`${FIXTURES}/test-cases.json`, cases)}`);

// 3. The demo red build from Chapter 8, with real re-runs, recorded once.
await rm(path.join(os.tmpdir(), "qa-crew-flaky-demo.txt"), { force: true });
const packs = [];
for (const name of ["past-checkin", "capacity", "book-from-form", "new-booking-row"]) {
  for (const failure of failuresFrom(await runPlaywright(`tests/triage-demo/${name}.spec.ts`))) {
    const pack = await collectEvidence(failure);
    console.log(`  ${name}: runs ${pack.runs.map((r) => r.status).join(", ")}`);
    packs.push(pack);
  }
}
console.log(`Triage evidence: ${await writeArtifact(`${FIXTURES}/triage-evidence.json`, packs)}`);

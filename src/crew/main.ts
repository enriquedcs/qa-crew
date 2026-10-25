// Chapter 9: run QA Crew as one team, with an orchestrator.
//
//   npm run crew                          # start a run for booking-rules; stops at each human gate
//   npm run crew -- approve               # approve what the run is waiting for, and continue
//   npm run crew -- approve --note "R6 rejected: out of scope"
//   npm run crew -- status                # where the latest run is, and what waits for you
//   npm run crew -- continue              # retry after a failure, or continue after raising the budget
//   npm run crew -- start --auto          # no human gates: a policy approves (demos and CI only)
//   npm run crew -- start max-stay-limit  # another requirements document
//
//   QA_MODEL_PROVIDER=mock npm run crew -- start --auto     # the whole crew with scripted models
//
// Options: --run <id> (default: the latest run), --max-tokens <n>, --cases TC-01,TC-02
// Per-role models: QA_ANALYST_MODEL, QA_DESIGNER_MODEL, QA_EXECUTOR_MODEL, QA_TRIAGER_MODEL.
//
// Every run lives in out/crew/<id>/: run.json (state), events.jsonl (trace), the agents' files,
// and summary.md, the list of decisions that are still yours.

import os from "node:os";
import { loadEnv, writeArtifact } from "../agents/shared.ts";
import { advance, approve, createRun, latestRunId, loadRun, saveRun, type CrewRun, type RunStore } from "./orchestrator.ts";
import { crewStages } from "./stages.ts";
import { decisionsFor, renderRunSummary } from "./summary.ts";

loadEnv();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = ["start", "approve", "continue", "status"].includes(args[0]) ? args[0] : "start";
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--") && a !== command);

const store: RunStore = { root: "out/crew" };
const stages = crewStages({ verbose: true, caseIds: flag("cases")?.split(",") });
const titles = Object.fromEntries(stages.map((s) => [s.name, s.title]));

async function current(): Promise<CrewRun> {
  const id = flag("run") ?? (await latestRunId(store));
  if (!id) throw new Error("No crew runs yet. Start one with: npm run crew");
  return loadRun(store, id);
}

async function report(run: CrewRun): Promise<void> {
  const summary = await renderRunSummary(store, run, titles);
  const file = await writeArtifact(`${store.root}/${run.id}/summary.md`, summary);
  console.log("");
  for (const s of run.stages) console.log(`  ${s.status.padEnd(8)} ${titles[s.name]}${s.notes[0] ? `\n           ${s.notes[0]}` : ""}${s.error ? `\n           Error: ${s.error}` : ""}`);
  console.log(`\nRun ${run.id}: ${run.status}${run.waitingAt ? ` (gate after "${run.waitingAt}")` : ""}`);
  if (run.error) console.log(run.error);
  const decisions = await decisionsFor(store, run);
  if (decisions.length > 0) {
    console.log("\nYour decisions:");
    for (const d of decisions) console.log(`  - ${d.text}`);
  }
  console.log(`\nSummary: ${file}`);
}

async function main() {
  if (command === "status") return report(await current());

  let run: CrewRun;
  if (command === "start") {
    const auto = args.includes("--auto");
    run = await createRun(store, {
      feature: positional[0] ?? "booking-rules",
      stages,
      gates: { analyze: auto ? "auto" : "human", design: auto ? "auto" : "human" },
      maxTokens: Number(flag("max-tokens") ?? process.env.QA_CREW_MAX_TOKENS ?? 400_000),
    });
    console.log(`Crew run ${run.id} started${auto ? " (gates approved by policy)" : ""}.`);
  } else {
    run = await current();
    const max = flag("max-tokens");
    if (max) {
      run.budget.maxTokens = Number(max);
      await saveRun(store, run);
    }
    if (command === "approve") {
      run = await approve(store, run, { by: process.env.QA_REVIEWER ?? os.userInfo().username, note: flag("note") });
      console.log(`Approved. Continuing run ${run.id}.`);
    }
  }

  run = await advance(store, run, stages);
  await report(run);
  if (run.status === "failed" || run.status === "over-budget") process.exitCode = 1;
}

await main();

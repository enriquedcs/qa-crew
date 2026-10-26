// Chapter 14: test the booking assistant, an LLM feature inside the app.
//
//   npm run ch14                                  # the question set, 3 trials per case
//   npm run ch14 -- --trials 5
//   ASSISTANT_MODEL_PROVIDER=mock npm run ch14    # the scripted assistant: a weak model with two planted mistakes
//
// The assistant's model: ASSISTANT_MODEL_PROVIDER, ASSISTANT_MODEL, ASSISTANT_MODEL_API_KEY (falling back to QA_MODEL_*).
// The judge's model, for the prose: QA_JUDGE_MODEL (falling back to QA_MODEL). With a scripted assistant there is no judge.
//
// Every case runs on a fresh in-memory hotel. Code checks the suggestion and the secrets in every trial;
// the judge grades the prose. A case passes only when EVERY trial passes: a rule that holds two times
// out of three does not hold.
//
// Writes: out/assistant/report.md and report.json

import { askAssistant, assistantModelFromEnv, scriptedAssistant, utcToday } from "../app/assistant.ts";
import { Store } from "../app/store.ts";
import { loadEnv, modelForRole, writeArtifact } from "../agents/shared.ts";
import { createMockClient } from "../llm/index.ts";
import { ASSISTANT_CASES, checkAnswer, withDates, type ExistingBooking, type Violation } from "../evals/assistant.ts";
import { judge, rubberStampJudge, type Judgment } from "../evals/judge.ts";

loadEnv();
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);

const assistant = assistantModelFromEnv() ?? (() => createMockClient(scriptedAssistant()));
const sample = assistant();
const scripted = sample.provider === "mock";
const trials = Math.max(1, Number(opt("trials") ?? (scripted ? 1 : 3)));
const judgeModel = scripted ? undefined : modelForRole("judge", () => rubberStampJudge());

interface TrialResult {
  answer: string;
  suggestion?: unknown;
  violations: Violation[];
  judgment?: Judgment;
}

console.log(`Booking assistant: ${sample.provider} / ${sample.model}${scripted ? " (scripted: two mistakes planted on purpose)" : ""}`);
console.log(`Judge: ${judgeModel ? `${judgeModel.provider} / ${judgeModel.model}` : "none"} · ${trials} trial${trials === 1 ? "" : "s"} per case\n`);

const today = utcToday();
const report: { id: string; title: string; requirements: string[]; trials: TrialResult[] }[] = [];

for (const c of ASSISTANT_CASES) {
  const results: TrialResult[] = [];
  const question = withDates(c.question, today);
  for (let i = 0; i < trials; i++) {
    // A fresh hotel per trial: the same state every time, so only the model varies.
    const store = new Store();
    const existing: ExistingBooking[] = c.setup.map((b) => ({
      guestName: b.guestName,
      roomId: b.roomId,
      guests: b.guests,
      checkIn: withDates(`{d:${b.inDays}}`, today),
      checkOut: withDates(`{d:${b.outDays}}`, today),
    }));
    for (const b of existing) store.addBooking(b);

    const reply = await askAssistant(question, store, assistant(), () => today);
    if (!reply) {
      results.push({ answer: "", violations: [{ requirement: c.requirements[0], problem: "no answer" }] });
      continue;
    }
    const violations = checkAnswer(c, reply, store.listRooms(), existing, today);
    let judgment: Judgment | undefined;
    if (judgeModel) {
      // The judge sees the facts without names: it does not need them, so it does not get them.
      const facts = [
        `Today: ${today}.`,
        `Rooms: ${store.listRooms().map((r) => `${r.id} ${r.name} (fits ${r.capacity}, ${r.pricePerNight}/night)`).join("; ")}.`,
        `Bookings: ${existing.length ? existing.map((b) => `${b.roomId} from ${b.checkIn} to ${b.checkOut} (another guest)`).join("; ") : "none"}.`,
      ].join("\n");
      judgment = (await judge(modelForRole("judge", () => rubberStampJudge()), { question, facts, answer: reply.answer })).judgment;
    }
    results.push({ answer: reply.answer, ...(reply.suggestion ? { suggestion: reply.suggestion } : {}), violations, judgment });
  }

  report.push({ id: c.id, title: c.title, requirements: c.requirements, trials: results });
  const clean = results.filter((r) => r.violations.length === 0).length;
  const judged = results.filter((r) => r.judgment?.verdict === "pass").length;
  console.log(`${c.id} ${clean === trials ? "✓" : "✗"} code ${clean}/${trials}${judgeModel ? `  judge ${judged}/${trials}` : ""}  ${c.title}`);
  for (const [i, r] of results.entries()) {
    for (const v of r.violations) console.log(`     trial ${i + 1}: ${v.requirement.replace("booking-assistant:", "")} ${v.problem}`);
    if (r.judgment?.verdict === "fail") console.log(`     trial ${i + 1}: judge: ${r.judgment.failed.join(", ")}: ${r.judgment.reason}`);
  }
}

// ---- Report ----

const lines = [
  `# Booking assistant: ${sample.provider} / ${sample.model}`,
  "",
  `${trials} trial(s) per case. A case passes only if every trial passes the code checks.`,
  "",
  "| Case | Requirements | Code | Judge | |",
  "|---|---|---|---|---|",
];
for (const r of report) {
  const clean = r.trials.filter((t) => t.violations.length === 0).length;
  const judged = r.trials.filter((t) => t.judgment?.verdict === "pass").length;
  lines.push(`| ${r.id} ${r.title} | ${r.requirements.map((x) => x.replace("booking-assistant:", "")).join(", ")} | ${clean}/${r.trials.length} | ${judgeModel ? `${judged}/${r.trials.length}` : "–"} | ${clean === r.trials.length ? "✓" : "✗"} |`);
}
for (const r of report) {
  lines.push("", `## ${r.id} ${r.title}`);
  for (const [i, t] of r.trials.entries()) {
    lines.push("", `Trial ${i + 1}: ${t.answer.replace(/\n/g, " ")}`);
    if (t.suggestion) lines.push(`Suggestion: \`${JSON.stringify(t.suggestion)}\``);
    for (const v of t.violations) lines.push(`- ✗ ${v.requirement}: ${v.problem}`);
    if (t.judgment) lines.push(`- judge: ${t.judgment.verdict}${t.judgment.failed.length ? ` (${t.judgment.failed.join(", ")})` : ""}: ${t.judgment.reason}`);
  }
}
await writeArtifact("out/assistant/report.json", report);
console.log(`\nReport: ${await writeArtifact("out/assistant/report.md", lines.join("\n") + "\n")}`);
